/**
 * SQLite wrapper. Thin repository layer over bun:sqlite.
 * All mutating operations return fresh row snapshots (no in-place mutation).
 */

import { Database } from "bun:sqlite";

/**
 * Narrow bind-value type: SQLite accepts these as named-parameter values.
 * Matches the element-shape of the `Record<...>` arm in bun:sqlite's
 * `SQLQueryBindings` without pulling in the (recursive) union export.
 */
type BindValue = string | number | bigint | boolean | null | Uint8Array;
type BindMap = Record<string, BindValue>;
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL, MIGRATIONS } from "./schema.ts";

export type SessionStatus = "active" | "idle" | "ended" | "unbound";

export interface SessionRow {
  session_id: string;
  channel_token: string;
  cwd: string | null;
  pid: number | null;
  project_dir: string | null;
  account_hint: string | null;
  started_at: number | null;
  ended_at: number | null;
  ended_reason: string | null;
  latest_model: string | null;
  latest_model_display: string | null;
  latest_ctx_pct: number | null;
  latest_ctx_window_size: number | null;
  latest_limits_json: string | null;
  latest_cost_usd: number | null;
  latest_version: string | null;
  latest_permission_mode: string | null;
  latest_statusline_at: number | null;
  status: string;
}

/** Row shape for `messages` — mirrors schema.sql. */
export interface MessageRow {
  id: number;
  session_id: string | null;
  direction: string | null;
  content: string | null;
  meta_json: string | null;
  created_at: number | null;
}

/** Allowed `status` query values for `listSessions`. */
export type SessionListStatus =
  | "active"
  | "idle"
  | "ended"
  | "unbound"
  | "all";

export interface ListSessionsArgs {
  status: SessionListStatus;
  limit: number;
  offset: number;
}

export interface SessionCounts {
  messages: number;
  tool_events: number;
}

export interface SessionWithCounts {
  session: SessionRow;
  counts: SessionCounts;
}

export interface StatuslineSnapshot {
  model_id: string | null;
  model_display: string | null;
  ctx_pct: number | null;
  ctx_window_size: number | null;
  limits_json: string | null;
  cost_usd: number | null;
  version: string | null;
  permission_mode: string | null;
  cwd: string | null;
  project_dir: string | null;
}

// Only these predicate fragments may be composed dynamically. Every entry
// here maps to a fixed SQL fragment with a fixed bind-parameter name, so
// user-controlled input never reaches SQL text.
const PREDICATE_ALLOWLIST = {
  cwd: { sql: "cwd = $cwd", bindKey: "$cwd" as const },
  pid: { sql: "pid = $pid", bindKey: "$pid" as const },
  sinceTs: { sql: "started_at >= $since", bindKey: "$since" as const },
  status_active: {
    sql: "status = 'active'",
    bindKey: null as string | null,
  },
} as const;

export class Db {
  readonly raw: Database;

  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.raw = new Database(path);
    this.raw.exec("PRAGMA journal_mode = WAL;");
    // Enforce FKs so rogue hook writes with a bad session_id cannot
    // leave orphan rows in `messages` / `tool_events`. Must be set per
    // connection (not per database) for bun:sqlite.
    this.raw.exec("PRAGMA foreign_keys = ON;");
    this.raw.exec(SCHEMA_SQL);
    // Idempotent additive migrations. Each may throw "duplicate column
    // name" on repeat boots; that's expected and safe to swallow.
    for (const sql of MIGRATIONS) {
      try {
        this.raw.exec(sql);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!/duplicate column name/i.test(msg)) {
          throw e;
        }
      }
    }
  }

  close(): void {
    this.raw.close();
  }

  createSession(input: {
    session_id: string;
    channel_token: string;
    cwd: string;
    pid: number;
    started_at: number;
  }): SessionRow {
    // Copy install_meta.account_hint (if any) into the new session row at
    // creation time. Once persisted on the session row, subsequent changes
    // to install_meta do NOT mutate it — prior-session history is immutable.
    const accountHint = this.getAccountHint();
    const stmt = this.raw.prepare(`
      INSERT INTO sessions (session_id, channel_token, cwd, pid, started_at, account_hint, status)
      VALUES ($session_id, $channel_token, $cwd, $pid, $started_at, $account_hint, 'active')
    `);
    stmt.run({
      $session_id: input.session_id,
      $channel_token: input.channel_token,
      $cwd: input.cwd,
      $pid: input.pid,
      $started_at: input.started_at,
      $account_hint: accountHint,
    });
    const row = this.getSessionById(input.session_id);
    if (!row) throw new Error("session insert failed");
    return row;
  }

  /**
   * Store or clear the install-scoped account_hint. The row is a singleton
   * (id=1). Pass `null` to clear. New sessions created after this call
   * inherit the hint; previously-created sessions are unaffected.
   */
  setAccountHint(hint: string | null): void {
    const ts = Date.now();
    this.raw
      .prepare(
        `INSERT INTO install_meta (id, account_hint, updated_at)
         VALUES (1, $hint, $ts)
         ON CONFLICT(id) DO UPDATE SET
           account_hint = excluded.account_hint,
           updated_at = excluded.updated_at`,
      )
      .run({ $hint: hint, $ts: ts });
  }

  /** Read the install-scoped account_hint (null if unset). */
  getAccountHint(): string | null {
    const row = this.raw
      .prepare("SELECT account_hint FROM install_meta WHERE id = 1")
      .get() as { account_hint: string | null } | null;
    return row?.account_hint ?? null;
  }

  getSessionById(session_id: string): SessionRow | null {
    return (
      (this.raw
        .prepare("SELECT * FROM sessions WHERE session_id = ?")
        .get(session_id) as SessionRow | null) ?? null
    );
  }

  getSessionByToken(token: string): SessionRow | null {
    return (
      (this.raw
        .prepare("SELECT * FROM sessions WHERE channel_token = ?")
        .get(token) as SessionRow | null) ?? null
    );
  }

  /**
   * Find the most recent session matching cwd (and optionally pid).
   * Used by statusline (cwd match) and by channel handshake (cwd+pid match).
   *
   * When ONLY cwd is given (statusline fallback), we constrain to
   * `status = 'active'` AND `started_at >= now - 24h` to avoid attaching
   * statusline updates to arbitrarily old sessions.
   */
  findRecentSession(args: {
    cwd: string;
    pid?: number;
    sinceTs?: number;
  }): SessionRow | null {
    const parts: string[] = [PREDICATE_ALLOWLIST.cwd.sql];
    const bind: BindMap = {
      [PREDICATE_ALLOWLIST.cwd.bindKey]: args.cwd,
    };
    if (typeof args.pid === "number") {
      parts.push(PREDICATE_ALLOWLIST.pid.sql);
      bind[PREDICATE_ALLOWLIST.pid.bindKey] = args.pid;
    } else {
      // cwd-only fallback: restrict to recent active sessions.
      parts.push(PREDICATE_ALLOWLIST.status_active.sql);
      const cutoff =
        typeof args.sinceTs === "number"
          ? args.sinceTs
          : Date.now() - 24 * 60 * 60 * 1000;
      parts.push(PREDICATE_ALLOWLIST.sinceTs.sql);
      bind[PREDICATE_ALLOWLIST.sinceTs.bindKey] = cutoff;
    }
    if (typeof args.sinceTs === "number" && typeof args.pid === "number") {
      parts.push(PREDICATE_ALLOWLIST.sinceTs.sql);
      bind[PREDICATE_ALLOWLIST.sinceTs.bindKey] = args.sinceTs;
    }
    const sql = `SELECT * FROM sessions WHERE ${parts.join(" AND ")} ORDER BY started_at DESC LIMIT 1`;
    return (this.raw.prepare(sql).get(bind) as SessionRow | null) ?? null;
  }

  /**
   * Apply a statusline snapshot. Returns the refreshed row, OR `null`
   * distinctly when no row matched the given session_id.
   */
  updateStatuslineSnapshot(
    session_id: string,
    snap: StatuslineSnapshot,
    ts: number,
  ): SessionRow | null {
    const result = this.raw
      .prepare(
        `UPDATE sessions SET
           latest_model = $model,
           latest_model_display = $model_display,
           latest_ctx_pct = $ctx_pct,
           latest_ctx_window_size = $ctx_window_size,
           latest_limits_json = $limits,
           latest_cost_usd = $cost,
           latest_version = $version,
           latest_permission_mode = $permission_mode,
           latest_statusline_at = $ts,
           project_dir = COALESCE($project_dir, project_dir),
           cwd = COALESCE($cwd, cwd)
         WHERE session_id = $sid`,
      )
      .run({
        $sid: session_id,
        $model: snap.model_id,
        $model_display: snap.model_display,
        $ctx_pct: snap.ctx_pct,
        $ctx_window_size: snap.ctx_window_size,
        $limits: snap.limits_json,
        $cost: snap.cost_usd,
        $version: snap.version,
        $permission_mode: snap.permission_mode,
        $project_dir: snap.project_dir,
        $cwd: snap.cwd,
        $ts: ts,
      });
    if (!result.changes || result.changes === 0) return null;
    return this.getSessionById(session_id);
  }

  setSessionStatus(session_id: string, status: SessionStatus): void {
    this.raw
      .prepare("UPDATE sessions SET status = ? WHERE session_id = ?")
      .run(status, session_id);
  }

  /**
   * Insert a message row (inbound or outbound). Returns the new row id.
   * `meta` is serialized to JSON (empty object when undefined).
   *
   * The `meta` arg here accepts string-valued records (for outbound reply
   * meta validated against per-key caps). Hook handlers that persist the
   * full raw payload pass it as pre-serialized JSON via `metaJson`.
   */
  insertMessage(input: {
    session_id: string;
    direction: "inbound" | "outbound";
    content: string;
    meta?: Record<string, string>;
    metaJson?: string | null;
    created_at: number;
  }): number {
    const metaJson =
      input.metaJson !== undefined
        ? input.metaJson
        : input.meta
          ? JSON.stringify(input.meta)
          : null;
    const result = this.raw
      .prepare(
        `INSERT INTO messages (session_id, direction, content, meta_json, created_at)
         VALUES ($sid, $dir, $content, $meta, $ts)`,
      )
      .run({
        $sid: input.session_id,
        $dir: input.direction,
        $content: input.content,
        $meta: metaJson,
        $ts: input.created_at,
      });
    return Number(result.lastInsertRowid);
  }

  /**
   * Insert a tool_events audit row. `tool_input_json` and
   * `tool_output_json` are expected to be already-serialized JSON strings
   * (or null). Callers build them from raw payload fields.
   */
  insertToolEvent(input: {
    session_id: string;
    hook_event: string;
    tool_name: string | null;
    tool_input_json: string | null;
    tool_output_json: string | null;
    permission_mode: string | null;
    created_at: number;
  }): number {
    const result = this.raw
      .prepare(
        `INSERT INTO tool_events
           (session_id, hook_event, tool_name, tool_input_json, tool_output_json, permission_mode, created_at)
         VALUES ($sid, $event, $tname, $tin, $tout, $pmode, $ts)`,
      )
      .run({
        $sid: input.session_id,
        $event: input.hook_event,
        $tname: input.tool_name,
        $tin: input.tool_input_json,
        $tout: input.tool_output_json,
        $pmode: input.permission_mode,
        $ts: input.created_at,
      });
    return Number(result.lastInsertRowid);
  }

  /**
   * Mark a session as ended. Returns true if a row was updated, false if
   * the session_id was unknown. Idempotent: calling twice on the same
   * session still returns true and refreshes `ended_at` and `ended_reason`.
   *
   * `reason` is the CC SessionEnd `reason` field ("clear" | "logout" |
   * "prompt_input_exit" | "other" | any future string). Pass `null` to
   * clear, `undefined` to preserve any previously-recorded value — we
   * currently always overwrite because the second SessionEnd call carries
   * the more recent reason.
   */
  markSessionEnded(
    session_id: string,
    ts: number,
    reason: string | null = null,
  ): boolean {
    const result = this.raw
      .prepare(
        "UPDATE sessions SET status = 'ended', ended_at = $ts, ended_reason = $reason WHERE session_id = $sid",
      )
      .run({ $ts: ts, $reason: reason, $sid: session_id });
    return result.changes > 0;
  }
}
