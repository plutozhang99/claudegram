import { describe, it, expect, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, closeDatabase } from './client';
import type { Database } from './client';

describe('openDatabase', () => {
  it('1. returns a Database that can run SELECT 1', () => {
    const db = openDatabase(':memory:');
    const row = db.query('SELECT 1').get() as Record<string, unknown>;
    expect(row).toEqual({ '1': 1 });
    closeDatabase(db);
  });

  it('2. PRAGMA foreign_keys returns 1', () => {
    const db = openDatabase(':memory:');
    const row = db.query('PRAGMA foreign_keys').get() as Record<string, unknown>;
    expect(row['foreign_keys']).toBe(1);
    closeDatabase(db);
  });

  it('3. PRAGMA busy_timeout returns 5000', () => {
    const db = openDatabase(':memory:');
    const row = db.query('PRAGMA busy_timeout').get() as Record<string, unknown>;
    expect(row['timeout']).toBe(5000);
    closeDatabase(db);
  });

  it('4. :memory: PRAGMA journal_mode returns "memory" (WAL skipped, no throw)', () => {
    const db = openDatabase(':memory:');
    const row = db.query('PRAGMA journal_mode').get() as Record<string, unknown>;
    expect(row['journal_mode']).toBe('memory');
    closeDatabase(db);
  });

  describe('5. file-backed DB uses WAL journal mode', () => {
    let tmpDir: string;
    let dbPath: string;

    afterAll(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('PRAGMA journal_mode returns "wal" for file-backed DB', () => {
      tmpDir = mkdtempSync(join(tmpdir(), 'claudegram-test-'));
      dbPath = join(tmpDir, 'test.db');
      const db = openDatabase(dbPath);
      const row = db.query('PRAGMA journal_mode').get() as Record<string, unknown>;
      expect(row['journal_mode']).toBe('wal');
      closeDatabase(db);
    });
  });
});

describe('closeDatabase', () => {
  it('6. closes the DB — subsequent query throws', () => {
    const db = openDatabase(':memory:');
    closeDatabase(db);
    expect(() => db.query('SELECT 1')).toThrow();
  });

  it('7. second call to closeDatabase does NOT throw (idempotent)', () => {
    const db = openDatabase(':memory:');
    closeDatabase(db);
    expect(() => closeDatabase(db)).not.toThrow();
  });

  it('8. third call to closeDatabase still does not throw', () => {
    const db = openDatabase(':memory:');
    closeDatabase(db);
    closeDatabase(db);
    expect(() => closeDatabase(db)).not.toThrow();
  });

  it('9. two independent openDatabase calls return distinct instances', () => {
    const db1 = openDatabase(':memory:');
    const db2 = openDatabase(':memory:');
    expect(db1).not.toBe(db2);
    closeDatabase(db1);
    // db2 should still be operational after closing db1
    const row = db2.query('SELECT 1').get() as Record<string, unknown>;
    expect(row).toEqual({ '1': 1 });
    closeDatabase(db2);
  });
});
