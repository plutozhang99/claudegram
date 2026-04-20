/**
 * SQLite DDL per PLAN §8. Applied on startup; idempotent (IF NOT EXISTS).
 */

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  channel_token TEXT UNIQUE NOT NULL,
  cwd TEXT,
  pid INTEGER,
  project_dir TEXT,
  account_hint TEXT,
  started_at INTEGER,
  ended_at INTEGER,
  latest_model TEXT,
  latest_model_display TEXT,
  latest_ctx_pct REAL,
  latest_ctx_window_size INTEGER,
  latest_limits_json TEXT,
  latest_cost_usd REAL,
  latest_version TEXT,
  latest_permission_mode TEXT,
  latest_statusline_at INTEGER,
  status TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_cwd ON sessions(cwd);
CREATE INDEX IF NOT EXISTS idx_sessions_channel_token ON sessions(channel_token);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  direction TEXT,
  content TEXT,
  meta_json TEXT,
  created_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);

CREATE TABLE IF NOT EXISTS tool_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  hook_event TEXT,
  tool_name TEXT,
  tool_input_json TEXT,
  tool_output_json TEXT,
  permission_mode TEXT,
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint TEXT,
  keys_json TEXT,
  created_at INTEGER
);
`;
