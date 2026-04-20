/**
 * Correlation layer: owns the (in-memory) pending-session queue and the
 * bound `channel_token -> WebSocket` map. Module-local mutable state is
 * unavoidable here because liveness (sockets, timers) cannot be persisted.
 * Everything that CAN be immutable (row snapshots) is.
 */

import type { ServerWebSocket } from "bun";
import type { Db, SessionRow } from "./db.ts";
import { corrWindowMs, log } from "./config.ts";

export interface WsData {
  /** Populated after successful handshake + correlation. */
  channel_token?: string;
  session_id?: string;
  /** Timer that closes the socket if no handshake arrives in time. */
  handshake_timer?: ReturnType<typeof setTimeout>;
}

export type HarborWs = ServerWebSocket<WsData>;

interface PendingSession {
  readonly session_id: string;
  readonly cwd: string;
  readonly pid: number;
  readonly channel_token: string;
  readonly registered_at: number;
}

/**
 * In-memory maps. Lifetime = process lifetime. On restart all sessions are
 * re-created by the next SessionStart hook. Documented in PLAN §4.
 */
const pending = new Map<string, PendingSession>(); // key: session_id
const bound = new Map<string, HarborWs>(); // key: channel_token

export function registerPending(session: PendingSession): void {
  pending.set(session.session_id, session);
  // Auto-expire from pending queue after window (kept in DB though).
  setTimeout(() => pending.delete(session.session_id), corrWindowMs()).unref?.();
}

/**
 * Find a pending session that matches cwd+parent_pid within the
 * correlation window. On success the pending record is removed so the same
 * record cannot satisfy two sockets. On ties prefers the newest
 * `registered_at`.
 */
export function findPendingMatch(args: {
  cwd: string;
  parent_pid: number;
  now: number;
}): PendingSession | null {
  let best: PendingSession | null = null;
  for (const p of pending.values()) {
    if (p.cwd !== args.cwd) continue;
    if (p.pid !== args.parent_pid) continue;
    if (args.now - p.registered_at > corrWindowMs()) continue;
    if (!best || p.registered_at > best.registered_at) {
      best = p;
    }
  }
  if (best) {
    pending.delete(best.session_id);
  }
  return best;
}

/**
 * Bind a WS to a channel_token. Refuses to re-bind when a socket is
 * already live for that token. Returns true on success, false on refusal
 * (caller should close the new WS with 4010 "already bound"). The
 * previously-bound socket is NOT disturbed.
 */
export function bindSocket(token: string, ws: HarborWs): boolean {
  const prev = bound.get(token);
  if (prev && prev !== ws) {
    log.warn("ws: bind refused, token already bound", { token_prefix: token.slice(0, 8) });
    return false;
  }
  bound.set(token, ws);
  return true;
}

export function unbindSocket(token: string, ws: HarborWs): void {
  const existing = bound.get(token);
  if (existing === ws) bound.delete(token);
}

export function getBoundSocket(token: string): HarborWs | null {
  return bound.get(token) ?? null;
}

/**
 * Send a `notifications/claude/channel`-shaped frame to the WS bound to the
 * given session. Returns true if a socket was found and the frame was queued.
 */
export function pushToSession(
  db: Db,
  session_id: string,
  content: string,
  meta?: Record<string, string>,
): boolean {
  const row: SessionRow | null = db.getSessionById(session_id);
  if (!row) return false;
  const ws = bound.get(row.channel_token);
  if (!ws) return false;
  const frame = {
    method: "notifications/claude/channel",
    params: {
      content,
      meta: meta ?? {},
    },
  };
  try {
    ws.send(JSON.stringify(frame));
    return true;
  } catch (err) {
    log.warn("pushToSession: ws.send failed", { session_id, err: String(err) });
    return false;
  }
}

/** Test helper: clear all in-memory state. */
export function __resetCorrelation(): void {
  for (const ws of bound.values()) {
    try {
      ws.close(1001, "reset");
    } catch {
      // ignore
    }
  }
  bound.clear();
  pending.clear();
}
