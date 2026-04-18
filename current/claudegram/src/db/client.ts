import { Database } from 'bun:sqlite';

export type { Database } from 'bun:sqlite';

const closedDbs = new WeakSet<Database>();

/**
 * Opens a SQLite database at the given path and applies standard PRAGMAs.
 * For `:memory:` databases, WAL journal mode is silently skipped (unsupported).
 * The directory containing `path` must exist; `:memory:` is always valid.
 */
export function openDatabase(path: string): Database {
  const db = new Database(path);

  if (path !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL;');
  }

  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');

  const fkRow = db.query('PRAGMA foreign_keys').get() as { foreign_keys: number } | null;
  if (fkRow?.foreign_keys !== 1) {
    db.close();
    throw new Error('failed to enable foreign_keys PRAGMA');
  }

  return db;
}

/**
 * Idempotently closes a database. Subsequent calls are no-ops and do not throw.
 */
export function closeDatabase(db: Database): void {
  if (closedDbs.has(db)) {
    return;
  }
  closedDbs.add(db);
  db.close();
}
