/**
 * Frontend live WebSocket (`WS /subscribe`). Separate from `WS /channel`,
 * which is owned by the stdio MCP proxy — do NOT conflate the two.
 *
 * Protocol:
 *   - On open: server sends `{ type: "subscribed" }`.
 *   - Server then forwards every `HarborEvent` from the `EventBus`
 *     (JSON-encoded) to every open subscriber.
 *   - Client-to-server frames are ignored (frontend is a pure listener).
 *
 * Auth: gated by the same `checkAdminAuth` function as `/admin/*`
 * (loopback OR `HARBOR_ADMIN_TOKEN` header). P2 is still single-user
 * internal-network.
 */

import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import { log } from "./config.ts";
import type { Db } from "./db.ts";
import type { EventBus, HarborEvent } from "./event-bus.ts";
import { getBus } from "./event-bus.ts";
import { listSessions } from "./db-queries.ts";
import { safeStringify } from "./http-utils.ts";

/** Cap cumulative serialized bytes for the replay burst. */
const REPLAY_MAX_BYTES = 256 * 1024;
/** Close code for a subscriber whose WS outbound buffer is overfull. */
const WS_CLOSE_BACKPRESSURE = 1009;
/** Close code for "try again later" when subscriber cap is exceeded. */
const WS_CLOSE_TRY_LATER = 1013;
/** Soft cap on outbound WS buffered bytes before we close the socket. */
const WS_BUFFERED_MAX = 1_000_000;

/**
 * Per-socket data. We store the bus-unsubscribe fn so we can detach on
 * close.
 */
export interface SubscribeWsData {
  kind: "subscribe";
  unsubscribe?: () => void;
}

export type SubscribeWs = ServerWebSocket<SubscribeWsData>;

/** Max payload we're willing to accept from a subscriber. Small — they don't talk. */
export const SUBSCRIBE_MAX_PAYLOAD_BYTES = 4096;

/** Max active sessions we replay to a newly-connected subscriber. */
const REPLAY_ACTIVE_LIMIT = 100;

/**
 * Build the WS handler for `/subscribe`. Each open socket subscribes to
 * the bus on `open` and unsubscribes on `close`. Failures to `send` are
 * logged but never thrown — one dead socket must not take others down.
 *
 * If `db` is provided, on open we also replay a synthetic `session.created`
 * for every currently-active session so freshly-connected frontends learn
 * about sessions that were registered before they subscribed.
 */
export function buildSubscribeHandler(
  _bus?: EventBus,
  db?: Db,
): WebSocketHandler<SubscribeWsData> {
  // We intentionally resolve the bus lazily at `open` time via `getBus()`.
  // Tests swap the module-global bus with `__resetBus()`; a captured
  // reference would go stale across test fixtures.
  return {
    open(ws: SubscribeWs) {
      // Initial ack. Use safeStringify to keep parity with the rest of the
      // codebase (payload is trivial but the wrapper is free defense).
      try {
        ws.send(safeStringify({ type: "subscribed" }));
      } catch (e) {
        log.warn("ws-subscribe: ack send failed", {
          err: e instanceof Error ? e.message : String(e),
        });
      }
      // Replay active sessions so a late subscriber sees the current world.
      // `session.created` events already carry a `PublicSessionRow` (no
      // `channel_token`), and `listSessions` likewise returns the public
      // projection, so the replay frames are safe for untrusted consumers.
      if (db) {
        try {
          const { sessions } = listSessions(db, {
            status: "active",
            limit: REPLAY_ACTIVE_LIMIT,
            offset: 0,
          });
          let replayBytes = 0;
          let truncated = false;
          for (const s of sessions) {
            const frame = safeStringify({
              type: "session.created",
              session_id: s.session_id,
              session: s,
            });
            // TS-M replay byte budget: stop replaying past the cap.
            if (replayBytes + frame.length > REPLAY_MAX_BYTES) {
              truncated = true;
              break;
            }
            replayBytes += frame.length;
            try {
              ws.send(frame);
            } catch (e) {
              log.warn("ws-subscribe: replay send failed", {
                err: e instanceof Error ? e.message : String(e),
              });
            }
          }
          if (truncated) {
            log.warn("replay truncated for subscriber", {
              bytes: replayBytes,
              cap: REPLAY_MAX_BYTES,
            });
          }
        } catch (e) {
          log.warn("ws-subscribe: replay failed", {
            err: e instanceof Error ? e.message : String(e),
          });
        }
      }
      const bus = _bus ?? getBus();
      let unsub: (() => void) | null = null;
      try {
        unsub = bus.subscribeAll((ev: HarborEvent) => {
          let frame: string;
          try {
            frame = safeStringify(ev);
          } catch (e) {
            // safeStringify doesn't throw, but guard anyway.
            log.warn("ws-subscribe: stringify failed", {
              err: e instanceof Error ? e.message : String(e),
            });
            return;
          }
          // Backpressure: if the outbound buffer is overfull, close the
          // socket rather than let it balloon. Runtimes without
          // `getBufferedAmount` (e.g. older Bun) degrade to the pre-check
          // behavior silently.
          const bufFn = (
            ws as unknown as { getBufferedAmount?: () => number }
          ).getBufferedAmount;
          if (typeof bufFn === "function") {
            try {
              const buffered = bufFn.call(ws);
              if (typeof buffered === "number" && buffered > WS_BUFFERED_MAX) {
                log.warn("ws-subscribe: backpressure, closing", { buffered });
                try {
                  ws.data.unsubscribe?.();
                } catch {
                  // ignore
                }
                ws.data.unsubscribe = undefined;
                try {
                  ws.close(WS_CLOSE_BACKPRESSURE, "backpressure");
                } catch {
                  // ignore
                }
                return;
              }
            } catch {
              // ignore — best effort
            }
          }
          try {
            ws.send(frame);
          } catch (e) {
            log.warn("ws-subscribe: send failed", {
              err: e instanceof Error ? e.message : String(e),
            });
          }
        });
      } catch (e) {
        // H2: bus rejected the subscription (cap exceeded). Close with 1013
        // so the client can try again later.
        log.warn("ws-subscribe: subscription refused (cap)", {
          err: e instanceof Error ? e.message : String(e),
        });
        try {
          ws.close(WS_CLOSE_TRY_LATER, "subscriber cap");
        } catch {
          // ignore
        }
        return;
      }
      ws.data.unsubscribe = unsub ?? undefined;
    },
    message(_ws: SubscribeWs, _raw) {
      // Frontend is a pure listener. Silently drop inbound frames.
    },
    close(ws: SubscribeWs) {
      const unsub = ws.data.unsubscribe;
      if (unsub) {
        try {
          unsub();
        } catch {
          // Ignore — subscriber cleanup must not throw onward.
        }
        ws.data.unsubscribe = undefined;
      }
    },
  };
}

/**
 * Attempt to upgrade a request to the subscribe WS. Returns:
 *   - `undefined` if the upgrade succeeded (caller should return undefined)
 *   - `null` if the path/method doesn't match (caller continues routing)
 *   - a `Response` when auth fails or upgrade is rejected.
 *
 * Keeps path/upgrade parsing out of index.ts.
 */
export function tryUpgradeSubscribe(
  req: Request,
  srv: Server<unknown>,
  authCheck: () => Response | null,
): Response | null | "upgraded" {
  const url = new URL(req.url);
  if (url.pathname !== "/subscribe") return null;
  if (req.headers.get("upgrade") !== "websocket") return null;
  const denied = authCheck();
  if (denied) return denied;
  const ok = srv.upgrade(req, {
    data: { kind: "subscribe" } satisfies SubscribeWsData,
  });
  if (!ok) return new Response("upgrade failed", { status: 400 });
  return "upgraded";
}
