import path from 'node:path';
import type { Config } from './config.js';
import type { Logger } from './logger.js';
import type { Database } from './db/client.js';
import { migrate } from './db/migrate.js';
import { SqliteMessageRepo, SqliteSessionRepo } from './repo/sqlite.js';
import { dispatch } from './http.js';
import { InMemoryHub } from './ws/hub.js';
import type { Hub } from './ws/hub.js';
import type { UserSocketData } from './ws/hub.js';
import { InMemorySessionRegistry } from './ws/session-registry.js';
import type { SessionRegistry } from './ws/session-registry.js';
import type { SessionSocketData } from './routes/session-socket.js';
import {
  checkSessionSocketAuth,
  handleSessionSocketOpen,
  handleSessionSocketMessage,
  handleSessionSocketClose,
} from './routes/session-socket.js';

export interface ServerDeps {
  readonly config: Config;
  readonly db: Database;
  readonly logger: Logger;
  /** Optional hub — defaults to a new InMemoryHub. Pass your own for testing. */
  readonly hub?: Hub;
  /** Optional session registry — defaults to a new InMemorySessionRegistry. Pass your own for testing. */
  readonly sessionRegistry?: SessionRegistry;
  /** Optional absolute path to the web root. Defaults to <cwd>/web. */
  readonly webRoot?: string;
}

export interface RunningServer {
  readonly port: number;
  stop(drain?: boolean): Promise<void>;
}

/** Union of all typed data slots — one per WebSocket upgrade path. */
type WsData = SessionSocketData | UserSocketData;

/** Loopback addresses that are safe without CF Access. */
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

function isLoopback(hostname: string): boolean {
  return LOOPBACK.has(hostname);
}

// LOW fix: one warning per process lifetime; reset on restart.
let nonLoopbackWarningEmitted = false;

export function createServer(deps: ServerDeps): RunningServer {
  const { config, db, logger } = deps;

  // Run migrations synchronously before binding the socket.
  migrate(db);

  const msgRepo = new SqliteMessageRepo(db);
  const sessRepo = new SqliteSessionRepo(db);
  const hub = deps.hub ?? new InMemoryHub();
  const sessionRegistry = deps.sessionRegistry ?? new InMemorySessionRegistry();
  const webRoot = path.resolve(deps.webRoot ?? path.join(process.cwd(), 'web'));
  const ctx = { msgRepo, sessRepo, logger, db, hub, config, webRoot };

  const sessionSocketDeps = { config, sessRepo, sessionRegistry, logger };

  const server = Bun.serve<WsData>({
    port: config.port,
    fetch: (req, bunServer) => {
      const url = new URL(req.url);

      // ── /session-socket upgrade ─────────────────────────────────────────────
      if (
        url.pathname === '/session-socket' &&
        req.headers.get('upgrade')?.toLowerCase() === 'websocket'
      ) {
        const authError = checkSessionSocketAuth(req, config);
        if (authError !== null) return authError;

        const upgraded = bunServer.upgrade(req, {
          data: { kind: 'session-socket' } satisfies SessionSocketData,
        });
        if (upgraded) return undefined as unknown as Response;
        return new Response('upgrade failed', { status: 400 });
      }

      // ── /user-socket upgrade ────────────────────────────────────────────────
      if (
        url.pathname === '/user-socket' &&
        req.headers.get('upgrade')?.toLowerCase() === 'websocket'
      ) {
        const upgraded = bunServer.upgrade(req, {
          data: { kind: 'user-socket' } satisfies UserSocketData,
        });
        // Bun's upgrade idiom: return undefined after successful upgrade; cast silences the Response return type.
        if (upgraded) return undefined as unknown as Response;
        return new Response('upgrade failed', { status: 400 });
      }

      return dispatch(req, ctx);
    },
    websocket: {
      open: (ws) => {
        if (ws.data.kind === 'user-socket') {
          hub.add(ws);
          logger.info('ws_open', { size: hub.size });
        } else {
          // kind === 'session-socket'
          handleSessionSocketOpen(ws, { logger });
        }
      },
      close: (ws) => {
        if (ws.data.kind === 'user-socket') {
          hub.remove(ws);
          logger.info('ws_close', { size: hub.size });
        } else {
          // kind === 'session-socket'
          handleSessionSocketClose(ws, { sessionRegistry, logger });
        }
      },
      message: (ws, rawMessage) => {
        switch (ws.data.kind) {
          case 'session-socket':
            handleSessionSocketMessage(ws, rawMessage as string | Buffer, sessionSocketDeps);
            break;
          case 'user-socket':
            // Reserved for P2.3 — ignore inbound frames from user-socket for now.
            break;
        }
      },
    },
    error: (err) => {
      logger.error('unhandled', { err: String(err) });
      return new Response('internal error', { status: 500 });
    },
  });

  // MED 3 fix: read hostname from server.hostname (Bun resolves the actual bind address).
  // Falls back to '0.0.0.0' (non-loopback) when undefined (e.g. unix socket).
  // LOW fix: gate behind warn-once flag so the log fires at most once per process.
  const listenHostname = server.hostname ?? '0.0.0.0';
  if (!config.trustCfAccess && !isLoopback(listenHostname) && !nonLoopbackWarningEmitted) {
    nonLoopbackWarningEmitted = true; // one warning per process lifetime; reset on restart
    logger.warn(
      'TRUST_CF_ACCESS=false and listening on non-loopback — /session-socket and /api/me are unauthenticated. Bind to 127.0.0.1 pre-P4.',
    );
  }

  return {
    get port() { return server.port as number; },
    stop: (drain = true) => server.stop(drain),
  };
}
