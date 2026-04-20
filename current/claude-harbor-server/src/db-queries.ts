/**
 * P2 read-side queries against the SQLite schema, kept as free functions
 * against `Db.raw` to keep `db.ts` under the 400-line cap.
 *
 * All bind values are passed through parameterized queries. The only
 * dynamic SQL fragments are toggled via a fixed allowlist (WHERE clause
 * for `status` in `listSessions`), never user-controlled strings.
 */

import type { Db, SessionRow } from "./db.ts";
import type {
  ListSessionsArgs,
  MessageRow,
  SessionWithCounts,
} from "./db.ts";

type BindValue = string | number | bigint | boolean | null | Uint8Array;
type BindMap = Record<string, BindValue>;

/**
 * Public projection of a session row — identical to `SessionRow` minus the
 * `channel_token` column, which is the auth material for `POST /channel/reply`
 * and must NEVER be exposed via unauthenticated REST (`GET /sessions*`) or
 * the frontend `WS /subscribe` fan-out. The token is kept internal to:
 *   - `WS /channel` bind (proxy handshake)
 *   - `POST /channel/reply` (constant-time compare)
 *   - `GET /admin/session/:id` (admin-gated, explicitly permitted for debug)
 */
export type PublicSessionRow = Omit<SessionRow, "channel_token">;

/**
 * Strip `channel_token` from a session row. Returns a fresh object (no
 * in-place mutation of the input). Apply at every REST and WS fan-out site
 * that serializes session rows to unauthenticated consumers.
 */
export function toPublicSessionRow(row: SessionRow): PublicSessionRow {
  // Explicit property copy to keep the type-narrowing explicit and to avoid
  // any accidental property leak if `SessionRow` grows a new sensitive field.
  const {
    // biome-ignore lint/correctness/noUnusedVariables: discard channel_token
    channel_token: _channel_token,
    ...rest
  } = row;
  return rest;
}

/**
 * Paginated session list for the frontend. `status` is one of the
 * canonical lifecycle values or `all`. Ordering mirrors the frontend's
 * "recently-active first" expectation: most-recent `latest_statusline_at`
 * first (NULLs last), then newest `started_at` first as a stable fallback.
 * Returns `{ sessions, total }`. `total` counts rows that match the same
 * filter (not the page) so the frontend can render a total count.
 */
export function listSessions(
  db: Db,
  args: ListSessionsArgs,
): { sessions: PublicSessionRow[]; total: number } {
  const whereSql = args.status === "all" ? "" : "WHERE status = $status";
  const bind: BindMap = {};
  if (args.status !== "all") bind.$status = args.status;

  const totalRow = db.raw
    .prepare(`SELECT COUNT(*) AS c FROM sessions ${whereSql}`)
    .get(bind) as { c: number } | null;
  const total = totalRow?.c ?? 0;

  const rows = db.raw
    .prepare(
      `SELECT * FROM sessions ${whereSql}
       ORDER BY
         CASE WHEN latest_statusline_at IS NULL THEN 1 ELSE 0 END ASC,
         latest_statusline_at DESC,
         started_at DESC,
         session_id DESC
       LIMIT $limit OFFSET $offset`,
    )
    .all({ ...bind, $limit: args.limit, $offset: args.offset }) as SessionRow[];

  return { sessions: rows.map(toPublicSessionRow), total };
}

/** Public-safe variant of `SessionWithCounts` — `channel_token` removed. */
export interface PublicSessionWithCounts {
  session: PublicSessionRow;
  counts: SessionWithCounts["counts"];
}

/**
 * Fetch a session row plus `messages` / `tool_events` counts. Returns
 * `null` if no session row exists. Strips `channel_token` before returning
 * so callers (REST / WS fan-out) can never leak the channel auth material.
 */
export function getSessionWithCounts(
  db: Db,
  session_id: string,
): PublicSessionWithCounts | null {
  const session = db.getSessionById(session_id);
  if (!session) return null;
  const m = db.raw
    .prepare("SELECT COUNT(*) AS c FROM messages WHERE session_id = ?")
    .get(session_id) as { c: number } | null;
  const t = db.raw
    .prepare("SELECT COUNT(*) AS c FROM tool_events WHERE session_id = ?")
    .get(session_id) as { c: number } | null;
  return {
    session: toPublicSessionRow(session),
    counts: {
      messages: m?.c ?? 0,
      tool_events: t?.c ?? 0,
    },
  };
}

/**
 * Fetch a page of `messages` for a session, newest first, paginated by
 * `id < before` (cursor). Returns `{ messages, next_before }` where
 * `next_before` is the id to pass for the next page, or null if the page
 * was short of `limit` (end of history).
 */
export function listMessages(
  db: Db,
  args: {
    session_id: string;
    before?: number | null;
    limit: number;
  },
): { messages: MessageRow[]; next_before: number | null } {
  const bind: BindMap = {
    $sid: args.session_id,
    $limit: args.limit,
  };
  let whereBefore = "";
  if (typeof args.before === "number" && Number.isFinite(args.before)) {
    whereBefore = "AND id < $before";
    bind.$before = args.before;
  }
  const rows = db.raw
    .prepare(
      `SELECT id, session_id, direction, content, meta_json, created_at
       FROM messages
       WHERE session_id = $sid ${whereBefore}
       ORDER BY id DESC
       LIMIT $limit`,
    )
    .all(bind) as MessageRow[];
  const full = rows.length === args.limit;
  const next_before = full ? (rows[rows.length - 1]?.id ?? null) : null;
  return { messages: rows, next_before };
}

/**
 * Row lookup by numeric message id, scoped by `session_id` to defend
 * against cross-session reads. Callers always know the session id (they
 * inserted the row or derived it from a validated channel_token) so
 * scoping the lookup is free defense in depth.
 *
 * Returns null if the row does not exist OR belongs to a different session.
 */
export function getMessageById(
  db: Db,
  id: number,
  session_id: string,
): MessageRow | null {
  return (
    (db.raw
      .prepare(
        `SELECT id, session_id, direction, content, meta_json, created_at
         FROM messages WHERE id = ? AND session_id = ?`,
      )
      .get(id, session_id) as MessageRow | null) ?? null
  );
}
