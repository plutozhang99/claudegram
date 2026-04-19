export interface Message {
  readonly session_id: string;
  readonly id: string;
  readonly direction: 'assistant' | 'user';
  readonly ts: number;
  readonly ingested_at: number;
  readonly content: string;
}

export interface Session {
  readonly id: string;
  readonly name: string;
  readonly first_seen_at: number;
  readonly last_seen_at: number;
  readonly status: 'active' | 'ended';
  readonly last_read_at: number;
}

export interface SessionListItem extends Session {
  readonly unread_count: number;
  /** Live connection state — populated by the API layer, not persisted in DB. */
  readonly connected: boolean;
}

export type MessageInsert = Omit<Message, 'ingested_at'> & { readonly ingested_at?: number };

export type SessionUpsert = Pick<Session, 'id' | 'name'> & { readonly now: number };

export interface MessageRepo {
  insert(msg: MessageInsert): void;
  findBySession(session_id: string, opts?: { before?: number; limit?: number }): ReadonlyArray<Message>;
  findBySessionPage(
    session_id: string,
    opts?: { before_id?: string; limit?: number },
  ): { readonly messages: ReadonlyArray<Message>; readonly has_more: boolean };
  /** Look up a single message by composite primary key (session_id, id). Returns null on miss or cross-session. */
  findById(session_id: string, id: string): Readonly<Message> | null;
  /** Delete all messages for a session. Used inside session delete transaction. */
  deleteBySession(session_id: string): void;
}

// TODO(P2): expose updateStatus / markEnded method on SessionRepo — status is currently write-only via raw SQL
export interface SessionRepo {
  upsert(s: SessionUpsert): void;
  findById(id: string): Readonly<Session> | null;
  findAll(): ReadonlyArray<Omit<SessionListItem, 'connected'>>;
  /**
   * Monotonically advance `last_read_at` for the given session.
   * SQL: UPDATE sessions SET last_read_at = MAX(last_read_at, ?) WHERE id = ?
   * No-op if session_id doesn't exist. Never rolls back.
   */
  updateLastReadAt(session_id: string, ts: number): void;
  /**
   * Delete a session by id. Returns true if found+deleted, false if not found.
   * Callers are responsible for deleting related messages first (or use a
   * transaction). Does NOT cascade — use MessageRepo.deleteBySession() before
   * calling this.
   */
  delete(id: string): boolean;
  /**
   * Rename a session. Returns true if the session was found and updated,
   * false if no row matched (session does not exist).
   */
  rename(id: string, name: string): boolean;
}
