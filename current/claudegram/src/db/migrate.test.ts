import { describe, it, expect, beforeEach } from 'bun:test';
import { openDatabase, closeDatabase } from './client.js';
import type { Database } from './client.js';
import { migrate } from './migrate.js';

type SqliteMasterRow = { type: string; name: string };

describe('migrate', () => {
  let db: Database;

  beforeEach(() => {
    db = openDatabase(':memory:');
  });

  // No afterEach cleanup — memory DBs are GC'd and tests are isolated.

  it('1. creates sessions table, messages table, and index in sqlite_master', () => {
    migrate(db);
    const rows = db
      .query<SqliteMasterRow, string[]>(
        `SELECT type, name FROM sqlite_master WHERE name IN (?,?,?) ORDER BY name`,
      )
      .all('idx_messages_session_ts', 'messages', 'sessions');

    const names = rows.map((r) => r.name).sort();
    expect(names).toEqual(['idx_messages_session_ts', 'messages', 'sessions']);
    expect(rows.find((r) => r.name === 'sessions')?.type).toBe('table');
    expect(rows.find((r) => r.name === 'messages')?.type).toBe('table');
    expect(rows.find((r) => r.name === 'idx_messages_session_ts')?.type).toBe('index');
    closeDatabase(db);
  });

  it('2. can INSERT a valid sessions row after migrate', () => {
    migrate(db);
    expect(() =>
      db.run(
        `INSERT INTO sessions (id, name, first_seen_at, last_seen_at) VALUES (?,?,?,?)`,
        ['s1', 'My Session', 1000, 2000],
      ),
    ).not.toThrow();
    closeDatabase(db);
  });

  it('3. INSERT into messages with unknown session_id throws FK constraint', () => {
    migrate(db);
    expect(() =>
      db.run(
        `INSERT INTO messages (session_id, id, direction, ts, content) VALUES (?,?,?,?,?)`,
        ['no-such-session', 'm1', 'user', 1000, 'hello'],
      ),
    ).toThrow();
    closeDatabase(db);
  });

  it('4. INSERT into messages with direction="bot" throws CHECK constraint', () => {
    migrate(db);
    db.run(
      `INSERT INTO sessions (id, name, first_seen_at, last_seen_at) VALUES (?,?,?,?)`,
      ['s1', 'Session', 1000, 2000],
    );
    expect(() =>
      db.run(
        `INSERT INTO messages (session_id, id, direction, ts, content) VALUES (?,?,?,?,?)`,
        ['s1', 'm1', 'bot', 1000, 'hello'],
      ),
    ).toThrow();
    closeDatabase(db);
  });

  it('5. direction="user" and direction="assistant" both succeed', () => {
    migrate(db);
    db.run(
      `INSERT INTO sessions (id, name, first_seen_at, last_seen_at) VALUES (?,?,?,?)`,
      ['s1', 'Session', 1000, 2000],
    );
    expect(() =>
      db.run(
        `INSERT INTO messages (session_id, id, direction, ts, content) VALUES (?,?,?,?,?)`,
        ['s1', 'm1', 'user', 1000, 'hello'],
      ),
    ).not.toThrow();
    expect(() =>
      db.run(
        `INSERT INTO messages (session_id, id, direction, ts, content) VALUES (?,?,?,?,?)`,
        ['s1', 'm2', 'assistant', 1001, 'world'],
      ),
    ).not.toThrow();
    closeDatabase(db);
  });

  it('6. ingested_at default has true millisecond precision within [beforeInsert, afterInsert]', () => {
    migrate(db);
    db.run(
      `INSERT INTO sessions (id, name, first_seen_at, last_seen_at) VALUES (?,?,?,?)`,
      ['s1', 'Session', 1000, 2000],
    );
    const beforeInsert = Date.now();
    db.run(
      `INSERT INTO messages (session_id, id, direction, ts, content) VALUES (?,?,?,?,?)`,
      ['s1', 'm1', 'user', 1000, 'hello'],
    );
    const afterInsert = Date.now();
    const row = db
      .query<{ ingested_at: number }, [string]>(`SELECT ingested_at FROM messages WHERE id=?`)
      .get('m1');
    expect(row).not.toBeNull();
    expect(row!.ingested_at).toBeGreaterThanOrEqual(beforeInsert);
    expect(row!.ingested_at).toBeLessThanOrEqual(afterInsert);
    closeDatabase(db);
  });

  it('7. running migrate twice is idempotent — no throw, still exactly 3 objects', () => {
    migrate(db);
    expect(() => migrate(db)).not.toThrow();
    const rows = db
      .query<SqliteMasterRow, string[]>(
        `SELECT name FROM sqlite_master WHERE name IN (?,?,?)`,
      )
      .all('idx_messages_session_ts', 'messages', 'sessions');
    expect(rows).toHaveLength(3);
    closeDatabase(db);
  });

  it('8. composite PK: inserting same (session_id, id) twice throws', () => {
    migrate(db);
    db.run(
      `INSERT INTO sessions (id, name, first_seen_at, last_seen_at) VALUES (?,?,?,?)`,
      ['s1', 'Session', 1000, 2000],
    );
    db.run(
      `INSERT INTO messages (session_id, id, direction, ts, content) VALUES (?,?,?,?,?)`,
      ['s1', 'm1', 'user', 1000, 'hello'],
    );
    expect(() =>
      db.run(
        `INSERT INTO messages (session_id, id, direction, ts, content) VALUES (?,?,?,?,?)`,
        ['s1', 'm1', 'user', 1001, 'again'],
      ),
    ).toThrow();
    closeDatabase(db);
  });

  it('9. same message id under different session_ids both succeed (composite PK)', () => {
    migrate(db);
    db.run(
      `INSERT INTO sessions (id, name, first_seen_at, last_seen_at) VALUES (?,?,?,?)`,
      ['s1', 'Session A', 1000, 2000],
    );
    db.run(
      `INSERT INTO sessions (id, name, first_seen_at, last_seen_at) VALUES (?,?,?,?)`,
      ['s2', 'Session B', 1000, 2000],
    );
    expect(() =>
      db.run(
        `INSERT INTO messages (session_id, id, direction, ts, content) VALUES (?,?,?,?,?)`,
        ['s1', 'shared-id', 'user', 1000, 'from s1'],
      ),
    ).not.toThrow();
    expect(() =>
      db.run(
        `INSERT INTO messages (session_id, id, direction, ts, content) VALUES (?,?,?,?,?)`,
        ['s2', 'shared-id', 'assistant', 1001, 'from s2'],
      ),
    ).not.toThrow();
    closeDatabase(db);
  });

  it('10. deleting a session cascades to its messages', () => {
    migrate(db);
    db.run(
      `INSERT INTO sessions (id, name, first_seen_at, last_seen_at) VALUES (?,?,?,?)`,
      ['s1', 'Session', 1000, 2000],
    );
    db.run(
      `INSERT INTO messages (session_id, id, direction, ts, content) VALUES (?,?,?,?,?)`,
      ['s1', 'm1', 'user', 1000, 'hello'],
    );
    db.run(`DELETE FROM sessions WHERE id=?`, ['s1']);
    const count = db
      .query<{ cnt: number }, [string]>(`SELECT COUNT(*) as cnt FROM messages WHERE session_id=?`)
      .get('s1');
    expect(count!.cnt).toBe(0);
    closeDatabase(db);
  });

  // P1 migration tests

  it('11. fresh DB after migrate() has status and last_read_at columns with correct defaults', () => {
    migrate(db);
    type ColInfo = { name: string; dflt_value: string | null; notnull: number };
    const cols = db
      .query<ColInfo, []>(`PRAGMA table_info(sessions)`)
      .all()
      .filter((c) => c.name === 'status' || c.name === 'last_read_at');

    const statusCol = cols.find((c) => c.name === 'status');
    const lastReadAtCol = cols.find((c) => c.name === 'last_read_at');

    expect(statusCol).toBeDefined();
    expect(statusCol!.dflt_value).toBe("'active'");
    expect(statusCol!.notnull).toBe(1);

    expect(lastReadAtCol).toBeDefined();
    expect(lastReadAtCol!.dflt_value).toBe('0');
    expect(lastReadAtCol!.notnull).toBe(1);
    closeDatabase(db);
  });

  it('12. P0 DB simulation: migrate() adds missing columns; existing row gets correct defaults', () => {
    // Simulate a P0 DB with only original 4 columns
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
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
    `);

    // Insert a pre-existing row (P0-era row)
    db.run(
      `INSERT INTO sessions (id, name, first_seen_at, last_seen_at) VALUES (?,?,?,?)`,
      ['s-old', 'Old Session', 1000, 2000],
    );

    // Run migration — should ALTER TABLE to add missing columns
    migrate(db);

    // Both new columns must now be present
    type ColInfo = { name: string };
    const colNames = db
      .query<ColInfo, []>(`PRAGMA table_info(sessions)`)
      .all()
      .map((c) => c.name);
    expect(colNames).toContain('status');
    expect(colNames).toContain('last_read_at');

    // Existing row must have the column defaults applied
    const row = db
      .query<{ status: string; last_read_at: number }, [string]>(
        `SELECT status, last_read_at FROM sessions WHERE id=?`,
      )
      .get('s-old');
    expect(row).not.toBeNull();
    expect(row!.status).toBe('active');
    expect(row!.last_read_at).toBe(0);
    closeDatabase(db);
  });

  it('13. migrate() called three times is idempotent — no throw, schema stable, row count unchanged', () => {
    // First call creates a fresh DB
    migrate(db);

    db.run(
      `INSERT INTO sessions (id, name, first_seen_at, last_seen_at) VALUES (?,?,?,?)`,
      ['s1', 'Test', 1000, 2000],
    );

    // Second and third calls must not throw and must not duplicate anything
    expect(() => migrate(db)).not.toThrow();
    expect(() => migrate(db)).not.toThrow();

    const count = db
      .query<{ cnt: number }, []>(`SELECT COUNT(*) as cnt FROM sessions`)
      .get();
    expect(count!.cnt).toBe(1);

    type ColInfo = { name: string };
    const colNames = db
      .query<ColInfo, []>(`PRAGMA table_info(sessions)`)
      .all()
      .map((c) => c.name);
    expect(colNames).toContain('status');
    expect(colNames).toContain('last_read_at');
    closeDatabase(db);
  });
});
