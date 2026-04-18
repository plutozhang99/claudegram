import type { Database } from './client.js';
import { SCHEMA_SQL } from './schema.js';

type PragmaTableInfoRow = { name: string };

/**
 * Applies the base schema (CREATE TABLE IF NOT EXISTS), then runs additive
 * ALTER TABLE migrations for DBs created under P0 that lack the new columns.
 * Idempotent: safe to call multiple times.
 */
export function migrate(db: Database): void {
  db.exec(SCHEMA_SQL);

  const existingColumns = new Set(
    (db.prepare('PRAGMA table_info(sessions)').all() as PragmaTableInfoRow[]).map((r) => r.name),
  );

  const needsStatus = !existingColumns.has('status');
  const needsLastReadAt = !existingColumns.has('last_read_at');

  if (needsStatus || needsLastReadAt) {
    db.exec('BEGIN');
    try {
      if (needsStatus) {
        db.exec(`ALTER TABLE sessions ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`);
      }
      if (needsLastReadAt) {
        db.exec(`ALTER TABLE sessions ADD COLUMN last_read_at INTEGER NOT NULL DEFAULT 0`);
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}
