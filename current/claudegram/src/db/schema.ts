export const SCHEMA_SQL: string = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','ended')),
  last_read_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
  session_id TEXT NOT NULL,
  id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('assistant','user')),
  ts INTEGER NOT NULL,
  ingested_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec')*1000 AS INTEGER)),
  content TEXT NOT NULL,
  PRIMARY KEY (session_id, id),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_session_ts ON messages(session_id, ts DESC);
`;
