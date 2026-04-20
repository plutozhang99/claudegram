/**
 * WebSocket client: connects to the harbor `/channel` endpoint, performs
 * the handshake, parses inbound frames, and provides a send helper.
 *
 * Reconnect policy: up to 3 attempts with 500ms / 1s / 2s backoff per
 * episode when the socket closes unexpectedly before shutdown is
 * requested. In addition, a process-wide hourly cap (MAX_RECONNECTS_PER_HOUR)
 * prevents a degenerate server that accepts-then-closes from burning the
 * proxy with endless retries.
 */

import { toWsUrl, log } from "./config.ts";
import {
  capContent,
  sanitizeMeta,
  stripControlChars,
} from "./sanitize.ts";
import type { WsBound, WsPush } from "./types.ts";

const HANDSHAKE_TIMEOUT_MS = 10_000;
const RECONNECT_DELAYS_MS: readonly number[] = [500, 1000, 2000];

/** Process-wide reconnect cap: > N reconnects within the window → fatal. */
export const MAX_RECONNECTS_PER_HOUR = 10;
export const RECONNECT_WINDOW_MS = 60 * 60 * 1000;

export interface WsClientOptions {
  readonly harborUrl: string;
  readonly parentPid: number;
  readonly cwd: string;
  /** Called for every inbound push frame after bound. */
  readonly onPush: (push: WsPush) => void;
  /** Called after a successful (re)bind. Receives the channel_token. */
  readonly onBound: (bound: WsBound) => void;
  /** Called when the client gives up (exhausted retries or hard failure). */
  readonly onFatal: (reason: string) => void;
  /**
   * Optional override for the rate-cap clock. Tests can inject a fake
   * clock to assert fatal-trigger timing deterministically.
   */
  readonly now?: () => number;
}

export interface WsClient {
  /** Current channel_token (once bound), or null. */
  channelToken(): string | null;
  /** Returns once the first successful handshake completes. Rejects on fatal. */
  ready(): Promise<void>;
  /** Close the socket cleanly; suppresses reconnect. */
  close(): void;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseBound(v: unknown): WsBound | null {
  if (!isObject(v)) return null;
  if (v.type !== "bound") return null;
  const session_id = typeof v.session_id === "string" ? v.session_id : null;
  const channel_token = typeof v.channel_token === "string" ? v.channel_token : null;
  if (!session_id || !channel_token) return null;
  return { type: "bound", session_id, channel_token };
}

/**
 * Parse an inbound "push" frame. Applies size caps, control-char stripping,
 * and meta bounds before returning the push. Returns null on unrecognized
 * shape or hard rejection.
 */
export function parsePush(v: unknown): WsPush | null {
  if (!isObject(v)) return null;
  if (v.type !== "push") return null;
  const contentRaw = typeof v.content === "string" ? v.content : null;
  if (contentRaw === null) return null;
  const content = stripControlChars(capContent(contentRaw));
  const metaRaw = v.meta;
  let meta: Record<string, string> | undefined;
  if (isObject(metaRaw)) {
    const sanitized = sanitizeMeta(metaRaw);
    if (Object.keys(sanitized).length > 0) meta = sanitized;
  }
  return meta ? { type: "push", content, meta } : { type: "push", content };
}

/**
 * Legacy/admin-push frame: the server's pushToSession emits
 * `{ method: "notifications/claude/channel", params: { content, meta } }`.
 * Translate to a WsPush so the proxy forwarder is uniform. Applies the
 * same sanitation as `parsePush`.
 */
export function parseLegacyPush(v: unknown): WsPush | null {
  if (!isObject(v)) return null;
  if (v.method !== "notifications/claude/channel") return null;
  const params = isObject(v.params) ? v.params : null;
  if (!params) return null;
  const contentRaw = typeof params.content === "string" ? params.content : null;
  if (contentRaw === null) return null;
  const content = stripControlChars(capContent(contentRaw));
  const metaRaw = params.meta;
  let meta: Record<string, string> | undefined;
  if (isObject(metaRaw)) {
    const sanitized = sanitizeMeta(metaRaw);
    if (Object.keys(sanitized).length > 0) meta = sanitized;
  }
  return meta ? { type: "push", content, meta } : { type: "push", content };
}

export function connectWs(opts: WsClientOptions): WsClient {
  const endpoint = toWsUrl(opts.harborUrl) + "/channel";
  const now = opts.now ?? (() => Date.now());

  let closedByUser = false;
  let attempt = 0;
  let currentToken: string | null = null;
  let currentSocket: WebSocket | null = null;
  let readyResolve: (() => void) | null = null;
  let readyReject: ((err: Error) => void) | null = null;
  const readyPromise = new Promise<void>((res, rej) => {
    readyResolve = res;
    readyReject = rej;
  });
  // Timestamps of every reconnect attempt since process start (sliding window).
  const reconnectTimestamps: number[] = [];
  let fatalFired = false;

  function fireFatal(reason: string): void {
    if (fatalFired) return;
    fatalFired = true;
    opts.onFatal(reason);
    readyReject?.(new Error(reason));
    readyReject = null;
  }

  function scheduleReconnect(): void {
    if (closedByUser) return;
    // Sliding-window cap across the process lifetime.
    const t = now();
    const cutoff = t - RECONNECT_WINDOW_MS;
    while (reconnectTimestamps.length > 0 && (reconnectTimestamps[0] ?? 0) < cutoff) {
      reconnectTimestamps.shift();
    }
    if (reconnectTimestamps.length >= MAX_RECONNECTS_PER_HOUR) {
      fireFatal(
        `reconnect rate cap exceeded (${reconnectTimestamps.length} within ${RECONNECT_WINDOW_MS}ms)`,
      );
      return;
    }
    if (attempt >= RECONNECT_DELAYS_MS.length) {
      fireFatal("reconnect budget exhausted");
      return;
    }
    const delay = RECONNECT_DELAYS_MS[attempt] as number;
    reconnectTimestamps.push(t);
    attempt += 1;
    log.info("ws: scheduling reconnect", { attempt, delayMs: delay });
    setTimeout(() => {
      if (!closedByUser) connect();
    }, delay).unref?.();
  }

  function connect(): void {
    const ws = new WebSocket(endpoint);
    currentSocket = ws;
    let bound = false;
    const hsTimer = setTimeout(() => {
      if (!bound) {
        log.warn("ws: handshake timeout", {});
        try {
          ws.close();
        } catch {
          // ignore
        }
      }
    }, HANDSHAKE_TIMEOUT_MS);
    hsTimer.unref?.();

    ws.addEventListener("open", () => {
      try {
        ws.send(
          JSON.stringify({
            parent_pid: opts.parentPid,
            cwd: opts.cwd,
            ts: Date.now(),
          }),
        );
      } catch (err) {
        log.warn("ws: failed to send handshake", { err: String(err) });
      }
    });

    ws.addEventListener("message", (ev) => {
      const raw = typeof ev.data === "string" ? ev.data : String(ev.data);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        log.warn("ws: dropping non-json frame", {});
        return;
      }
      if (!bound) {
        const ack = parseBound(parsed);
        if (ack) {
          bound = true;
          currentToken = ack.channel_token;
          clearTimeout(hsTimer);
          // Reset reconnect counter on successful bind.
          attempt = 0;
          opts.onBound(ack);
          if (readyResolve) {
            readyResolve();
            readyResolve = null;
            readyReject = null;
          }
          return;
        }
        // Pre-bound frame that is NOT a valid bound ack: close with a
        // distinct code and let reconnect logic handle recovery. Silent
        // drop previously masked server misbehavior.
        log.warn("ws: expected bound ack, closing", {});
        try {
          ws.close(4011, "expected bound ack");
        } catch {
          // ignore
        }
        return;
      }
      const push = parsePush(parsed) ?? parseLegacyPush(parsed);
      if (push) {
        opts.onPush(push);
        return;
      }
      log.info("ws: ignoring unrecognized frame", {});
    });

    ws.addEventListener("close", (ev: CloseEvent) => {
      clearTimeout(hsTimer);
      currentSocket = null;
      if (closedByUser) return;
      log.warn("ws: closed", { code: ev.code, reason: ev.reason });
      if (bound) {
        // Lost bound connection — retry from scratch.
        currentToken = null;
      }
      scheduleReconnect();
    });

    ws.addEventListener("error", (ev) => {
      log.warn("ws: error event", { msg: String(ev.type) });
    });
  }

  connect();

  return {
    channelToken(): string | null {
      return currentToken;
    },
    ready(): Promise<void> {
      return readyPromise;
    },
    close(): void {
      closedByUser = true;
      if (currentSocket) {
        try {
          currentSocket.close(1000, "shutdown");
        } catch {
          // ignore
        }
      }
    },
  };
}
