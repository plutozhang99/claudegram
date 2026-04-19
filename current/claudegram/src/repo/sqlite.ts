import type { Database } from '../db/client.js';
import type { Message, Session, SessionListItem, MessageInsert, SessionUpsert, MessageRepo, SessionRepo } from './types.js';

/** The shape returned by the DB for findAll — no `connected` field (that's added by the API layer). */
type SessionRow = Omit<SessionListItem, 'connected'>;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

// ─────────────────────────────── MessageRepo ───────────────────────────────

export class SqliteMessageRepo implements MessageRepo {
  private readonly stmtInsertWithIngested: ReturnType<Database['prepare']>;
  private readonly stmtInsertWithoutIngested: ReturnType<Database['prepare']>;
  private readonly stmtFindWithBefore: ReturnType<Database['prepare']>;
  private readonly stmtFindWithoutBefore: ReturnType<Database['prepare']>;
  private readonly stmtPageLookupCursor: ReturnType<Database['prepare']>;
  private readonly stmtPageWithBefore: ReturnType<Database['prepare']>;
  private readonly stmtPageWithoutBefore: ReturnType<Database['prepare']>;
  private readonly stmtFindById: ReturnType<Database['prepare']>;
  private readonly stmtDeleteBySession: ReturnType<Database['prepare']>;

  constructor(private readonly db: Database) {
    this.stmtInsertWithIngested = db.prepare(
      `INSERT INTO messages (session_id, id, direction, ts, content, ingested_at)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(session_id, id) DO NOTHING`
    );

    this.stmtInsertWithoutIngested = db.prepare(
      `INSERT INTO messages (session_id, id, direction, ts, content)
       VALUES (?,?,?,?,?)
       ON CONFLICT(session_id, id) DO NOTHING`
    );

    this.stmtFindWithBefore = db.prepare(
      `SELECT session_id, id, direction, ts, ingested_at, content
       FROM messages
       WHERE session_id=? AND ts<?
       ORDER BY ts DESC
       LIMIT ?`
    );

    this.stmtFindWithoutBefore = db.prepare(
      `SELECT session_id, id, direction, ts, ingested_at, content
       FROM messages
       WHERE session_id=?
       ORDER BY ts DESC
       LIMIT ?`
    );

    // Cursor lookup: resolve a message id to its ts for composite (ts, id) pagination
    this.stmtPageLookupCursor = db.prepare(
      `SELECT ts FROM messages WHERE session_id=? AND id=?`
    );

    // Page queries fetch limit+1 rows so we can detect has_more.
    // Composite cursor: WHERE ts < cursor.ts OR (ts = cursor.ts AND id < before_id)
    this.stmtPageWithBefore = db.prepare(
      `SELECT session_id, id, direction, ts, ingested_at, content
       FROM messages
       WHERE session_id=? AND (ts < ? OR (ts = ? AND id < ?))
       ORDER BY ts DESC, id DESC
       LIMIT ?`
    );

    this.stmtPageWithoutBefore = db.prepare(
      `SELECT session_id, id, direction, ts, ingested_at, content
       FROM messages
       WHERE session_id=?
       ORDER BY ts DESC, id DESC
       LIMIT ?`
    );

    this.stmtFindById = db.prepare(
      `SELECT session_id, id, direction, ts, ingested_at, content
       FROM messages
       WHERE session_id=? AND id=?`
    );

    this.stmtDeleteBySession = db.prepare(
      `DELETE FROM messages WHERE session_id=?`
    );
  }

  insert(msg: MessageInsert): void {
    if (msg.ingested_at !== undefined) {
      this.stmtInsertWithIngested.run(
        msg.session_id,
        msg.id,
        msg.direction,
        msg.ts,
        msg.content,
        msg.ingested_at
      );
    } else {
      this.stmtInsertWithoutIngested.run(
        msg.session_id,
        msg.id,
        msg.direction,
        msg.ts,
        msg.content
      );
    }
  }

  // Clamp silently: HTTP layer is the enforcement point for invalid input.
  // Clamping floor to 1 prevents SQLite's "LIMIT -1 = unlimited" footgun.
  findBySession(session_id: string, opts?: { before?: number; limit?: number }): ReadonlyArray<Message> {
    const candidate = opts?.limit ?? DEFAULT_LIMIT;
    const rawLimit = Number.isFinite(candidate) ? candidate : DEFAULT_LIMIT;
    const limit = Math.min(Math.max(1, rawLimit), MAX_LIMIT);

    if (opts?.before !== undefined) {
      return this.stmtFindWithBefore.all(session_id, opts.before, limit) as Message[];
    }
    return this.stmtFindWithoutBefore.all(session_id, limit) as Message[];
  }

  findBySessionPage(
    session_id: string,
    opts?: { before_id?: string; limit?: number },
  ): { readonly messages: ReadonlyArray<Message>; readonly has_more: boolean } {
    const candidate = opts?.limit ?? DEFAULT_LIMIT;
    const rawLimit = Number.isFinite(candidate) ? candidate : DEFAULT_LIMIT;
    const limit = Math.min(Math.max(1, rawLimit), MAX_LIMIT);
    const fetchCount = limit + 1;

    let rows: Message[];

    if (opts?.before_id !== undefined) {
      const cursor = this.stmtPageLookupCursor.get(session_id, opts.before_id) as { ts: number } | null;
      if (cursor === null) {
        return { messages: [], has_more: false };
      }
      rows = this.stmtPageWithBefore.all(session_id, cursor.ts, cursor.ts, opts.before_id, fetchCount) as Message[];
    } else {
      rows = this.stmtPageWithoutBefore.all(session_id, fetchCount) as Message[];
    }

    const has_more = rows.length > limit;
    return { messages: rows.slice(0, limit), has_more };
  }

  findById(session_id: string, id: string): Readonly<Message> | null {
    return (this.stmtFindById.get(session_id, id) as Message | null) ?? null;
  }

  deleteBySession(session_id: string): void {
    this.stmtDeleteBySession.run(session_id);
  }
}

// ─────────────────────────────── SessionRepo ───────────────────────────────

export class SqliteSessionRepo implements SessionRepo {
  private readonly stmtUpsert: ReturnType<Database['prepare']>;
  private readonly stmtFindById: ReturnType<Database['prepare']>;
  private readonly stmtFindAll: ReturnType<Database['prepare']>;
  private readonly stmtUpdateLastReadAt: ReturnType<Database['prepare']>;
  private readonly stmtDelete: ReturnType<Database['prepare']>;

  constructor(private readonly db: Database) {
    this.stmtUpsert = db.prepare(
      `INSERT INTO sessions (id, name, first_seen_at, last_seen_at)
       VALUES (?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         last_seen_at = excluded.last_seen_at,
         name = excluded.name`
    );

    this.stmtFindById = db.prepare(
      `SELECT id, name, first_seen_at, last_seen_at, status, last_read_at
       FROM sessions
       WHERE id=?`
    );

    this.stmtFindAll = db.prepare(
      `SELECT s.id, s.name, s.first_seen_at, s.last_seen_at, s.status, s.last_read_at,
              COALESCE(SUM(CASE WHEN m.direction = 'assistant' AND m.ts > s.last_read_at THEN 1 ELSE 0 END), 0) AS unread_count
       FROM sessions s
       LEFT JOIN messages m ON m.session_id = s.id
       GROUP BY s.id, s.name, s.first_seen_at, s.last_seen_at, s.status, s.last_read_at
       ORDER BY s.last_seen_at DESC`
    );

    this.stmtUpdateLastReadAt = db.prepare(
      `UPDATE sessions SET last_read_at = MAX(COALESCE(last_read_at, 0), ?) WHERE id = ?`
    );

    this.stmtDelete = db.prepare(`DELETE FROM sessions WHERE id=?`);
  }

  upsert(s: SessionUpsert): void {
    this.stmtUpsert.run(s.id, s.name, s.now, s.now);
  }

  findById(id: string): Readonly<Session> | null {
    return (this.stmtFindById.get(id) as Session | null) ?? null;
  }

  findAll(): ReadonlyArray<SessionRow> {
    return this.stmtFindAll.all() as SessionRow[];
  }

  updateLastReadAt(session_id: string, ts: number): void {
    this.stmtUpdateLastReadAt.run(ts, session_id);
  }

  delete(id: string): boolean {
    const result = this.stmtDelete.run(id);
    return (result as { changes: number }).changes > 0;
  }
}
