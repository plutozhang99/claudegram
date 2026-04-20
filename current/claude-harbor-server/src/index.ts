/**
 * Entry point. Composes Db + HTTP router + WS handler behind a single
 * Bun.serve instance.
 */

import type { Server } from "bun";
import { loadConfig, log } from "./config.ts";
import { Db } from "./db.ts";
import { handleHttp } from "./http.ts";
import { buildWsHandler } from "./ws.ts";
import type { WsData } from "./correlate.ts";

export interface StartOptions {
  port?: number;
  dbPath?: string;
}

export interface HarborHandle {
  server: Server<WsData>;
  db: Db;
  stop(): void;
}

/** WS handshake frame cap — conservative for the small JSON we expect. */
const WS_MAX_PAYLOAD_BYTES = 4096;

export function start(opts: StartOptions = {}): HarborHandle {
  const cfg = loadConfig();
  const port = opts.port ?? cfg.port;
  const dbPath = opts.dbPath ?? cfg.dbPath;
  const db = new Db(dbPath);
  const wsHandler = buildWsHandler(db);

  const server: Server<WsData> = Bun.serve<WsData>({
    port,
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/channel" && req.headers.get("upgrade") === "websocket") {
        const ok = srv.upgrade(req, { data: {} satisfies WsData });
        if (ok) return undefined as Response | undefined;
        return new Response("upgrade failed", { status: 400 });
      }
      return handleHttp(req, db, srv);
    },
    websocket: {
      ...wsHandler,
      maxPayloadLength: WS_MAX_PAYLOAD_BYTES,
    },
  });

  log.info("harbor: listening", { port: server.port, dbPath });
  return {
    server,
    db,
    stop() {
      server.stop(true);
      db.close();
    },
  };
}

// Run if invoked directly (not imported by tests).
if (import.meta.main) {
  const handle = start();
  const shutdown = () => {
    log.info("harbor: shutting down");
    handle.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
