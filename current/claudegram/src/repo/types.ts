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
}

// TODO(P2): expose updateStatus / markEnded method on SessionRepo — status is currently write-only via raw SQL
export interface SessionRepo {
  upsert(s: SessionUpsert): void;
  findById(id: string): Readonly<Session> | null;
  findAll(): ReadonlyArray<SessionListItem>;
}
