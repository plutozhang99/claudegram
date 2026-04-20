/**
 * Entry point. Composes Db + HTTP router + WS handler behind a single
 * Bun.serve instance.
 */

import type { Server, ServerWebSocket } from "bun";
import { loadConfig, log } from "./config.ts";
import { Db } from "./db.ts";
import { handleHttp, adminAuthGate } from "./http.ts";
import { buildWsHandler } from "./ws.ts";
import type { WsData } from "./correlate.ts";
import {
  buildSubscribeHandler,
  tryUpgradeSubscribe,
  type SubscribeWsData,
} from "./ws-subscribe.ts";
import { createStaticServer } from "./http-static.ts";

export interface StartOptions {
  port?: number;
  /**
   * Host to bind. Defaults to `127.0.0.1` per PLAN §12 (P1 hooks are
   * unauthenticated, so loopback-only is the safe default). Set
   * `HARBOR_BIND=0.0.0.0` or pass `bind: "0.0.0.0"` to expose more
   * broadly (e.g. behind a trusted reverse proxy in a container).
   */
  bind?: string;
  dbPath?: string;
  /**
   * Override the default Flutter build directory — primarily for tests
   * that stage fixtures in a temp dir.
   */
  frontendBuildDir?: string;
}

export interface HarborHandle {
  server: Server<WsData>;
  db: Db;
  stop(): void;
}

/** WS handshake frame cap — conservative for the small JSON we expect. */
const WS_MAX_PAYLOAD_BYTES = 4096;

/**
 * Union of WS socket data types across our two WS surfaces. Using a single
 * union lets us share Bun.serve's `websocket` handler — each callback
 * routes by `data.kind`.
 */
type AnyWsData = WsData | SubscribeWsData;

export function start(opts: StartOptions = {}): HarborHandle {
  const cfg = loadConfig();
  const port = opts.port ?? cfg.port;
  const bind = opts.bind ?? cfg.bind;
  const dbPath = opts.dbPath ?? cfg.dbPath;

  // M1 unsafe-bind guard: if we're binding off-loopback and no admin token
  // is configured, refuse to start unless the operator explicitly opts in
  // with `HARBOR_ALLOW_UNSAFE_BIND=1`. Loopback binds (127.x, ::1) stay
  // permissive — that is the single-user default topology.
  const isLoopback =
    bind === "127.0.0.1" ||
    bind === "::1" ||
    bind === "localhost" ||
    bind.startsWith("127.");
  if (
    !isLoopback &&
    !process.env.HARBOR_ADMIN_TOKEN &&
    process.env.HARBOR_ALLOW_UNSAFE_BIND !== "1"
  ) {
    log.error(
      "harbor: refusing to bind non-loopback without HARBOR_ADMIN_TOKEN",
      {
        bind,
        hint: "set HARBOR_ADMIN_TOKEN, or HARBOR_ALLOW_UNSAFE_BIND=1 to override",
      },
    );
    throw new Error(
      `refusing to bind ${bind}: set HARBOR_ADMIN_TOKEN or HARBOR_ALLOW_UNSAFE_BIND=1`,
    );
  }

  const db = new Db(dbPath);
  const channelHandler = buildWsHandler(db);
  // Do not capture the bus here — the module-level singleton can be
  // swapped by `__resetBus()` between tests; WS handlers must resolve the
  // bus on each `open`.
  const subscribeHandler = buildSubscribeHandler(undefined, db);
  const staticServer = createStaticServer(opts.frontendBuildDir);

  const server: Server<AnyWsData> = Bun.serve<AnyWsData>({
    port,
    hostname: bind,
    async fetch(req, srv) {
      const url = new URL(req.url);

      // WS /channel — stdio proxy upgrade.
      if (
        url.pathname === "/channel" &&
        req.headers.get("upgrade") === "websocket"
      ) {
        const ok = srv.upgrade(req, {
          data: { kind: "channel" } satisfies WsData,
        });
        if (ok) return undefined as Response | undefined;
        return new Response("upgrade failed", { status: 400 });
      }

      // WS /subscribe — frontend upgrade, admin-gated.
      const up = tryUpgradeSubscribe(
        req,
        srv as unknown as Server<unknown>,
        () => adminAuthGate(req, srv as Server<WsData>),
      );
      if (up === "upgraded") return undefined as Response | undefined;
      if (up instanceof Response) return up;
      // up === null → not a subscribe request; fall through.

      return handleHttp(req, db, srv as Server<WsData>, {
        staticServer,
        bind,
      });
    },
    websocket: {
      maxPayloadLength: WS_MAX_PAYLOAD_BYTES,
      open(ws) {
        const kind = (ws.data as AnyWsData | undefined)?.kind;
        if (kind === "subscribe") {
          subscribeHandler.open?.(ws as ServerWebSocket<SubscribeWsData>);
        } else {
          channelHandler.open?.(ws as ServerWebSocket<WsData>);
        }
      },
      message(ws, raw) {
        const kind = (ws.data as AnyWsData | undefined)?.kind;
        if (kind === "subscribe") {
          subscribeHandler.message?.(
            ws as ServerWebSocket<SubscribeWsData>,
            raw,
          );
        } else {
          channelHandler.message?.(ws as ServerWebSocket<WsData>, raw);
        }
      },
      close(ws, code, reason) {
        const kind = (ws.data as AnyWsData | undefined)?.kind;
        if (kind === "subscribe") {
          subscribeHandler.close?.(
            ws as ServerWebSocket<SubscribeWsData>,
            code,
            reason,
          );
        } else {
          channelHandler.close?.(ws as ServerWebSocket<WsData>, code, reason);
        }
      },
    },
  });

  log.info("harbor: listening", {
    port: server.port,
    bind,
    dbPath,
    static: staticServer.available ? "ok" : "stub",
  });
  return {
    server: server as unknown as Server<WsData>,
    db,
    stop() {
      server.stop(true);
      db.close();
    },
  };
}

// Run if invoked directly (not imported by tests).
if (import.meta.main) {
  let handle: HarborHandle;
  try {
    handle = start();
  } catch (e) {
    log.error("harbor: startup failed", {
      err: e instanceof Error ? e.message : String(e),
    });
    process.exit(1);
  }
  const shutdown = () => {
    log.info("harbor: shutting down");
    handle.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
