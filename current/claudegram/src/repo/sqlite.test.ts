import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { openDatabase, closeDatabase, type Database } from '../db/client.js';
import { migrate } from '../db/migrate.js';
import { SqliteMessageRepo, SqliteSessionRepo } from './sqlite.js';

let db: Database;
let msgRepo: SqliteMessageRepo;
let sessRepo: SqliteSessionRepo;

beforeEach(() => {
  db = openDatabase(':memory:');
  migrate(db);
  msgRepo = new SqliteMessageRepo(db);
  sessRepo = new SqliteSessionRepo(db);
});

afterEach(() => {
  closeDatabase(db);
});

// Helper to insert a session before inserting messages (FK requirement)
function insertSession(id: string, name = 'test', now = 1_000_000): void {
  sessRepo.upsert({ id, name, now });
}

describe('SqliteMessageRepo', () => {
  // Test 1: insert a valid message → findBySession returns it
  it('insert valid message then findBySession returns 1 row', () => {
    insertSession('s1');
    msgRepo.insert({ session_id: 's1', id: 'm1', direction: 'user', ts: 100, content: 'hello' });
    const rows = msgRepo.findBySession('s1');
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe('m1');
    expect(rows[0].session_id).toBe('s1');
    expect(rows[0].direction).toBe('user');
    expect(rows[0].ts).toBe(100);
    expect(rows[0].content).toBe('hello');
  });

  // Test 2: insert WITHOUT ingested_at → row's ingested_at is within wall-clock range
  it('insert without ingested_at → ingested_at defaults to current time', () => {
    insertSession('s1');
    const before = Date.now();
    msgRepo.insert({ session_id: 's1', id: 'm1', direction: 'user', ts: 100, content: 'hello' });
    const after = Date.now();
    const rows = msgRepo.findBySession('s1');
    expect(rows.length).toBe(1);
    expect(rows[0].ingested_at).toBeGreaterThanOrEqual(before);
    expect(rows[0].ingested_at).toBeLessThanOrEqual(after);
  });

  // Test 3: insert WITH explicit ingested_at=12345 → row has ingested_at === 12345
  it('insert with explicit ingested_at → row preserves that value', () => {
    insertSession('s1');
    msgRepo.insert({ session_id: 's1', id: 'm1', direction: 'user', ts: 100, content: 'hi', ingested_at: 12345 });
    const rows = msgRepo.findBySession('s1');
    expect(rows.length).toBe(1);
    expect(rows[0].ingested_at).toBe(12345);
  });

  // Test 4: insert same (session_id, id) twice → silent no-op, still 1 row
  it('duplicate (session_id, id) is silent no-op', () => {
    insertSession('s1');
    msgRepo.insert({ session_id: 's1', id: 'm1', direction: 'user', ts: 100, content: 'first' });
    msgRepo.insert({ session_id: 's1', id: 'm1', direction: 'user', ts: 200, content: 'second' });
    const rows = msgRepo.findBySession('s1');
    expect(rows.length).toBe(1);
    expect(rows[0].content).toBe('first');
  });

  // Test 5: same id but different session_id → each session returns exactly 1 row
  it('same message id under different session_ids are independent', () => {
    insertSession('s1');
    insertSession('s2');
    msgRepo.insert({ session_id: 's1', id: 'm1', direction: 'user', ts: 100, content: 'from s1' });
    msgRepo.insert({ session_id: 's2', id: 'm1', direction: 'user', ts: 100, content: 'from s2' });
    expect(msgRepo.findBySession('s1').length).toBe(1);
    expect(msgRepo.findBySession('s2').length).toBe(1);
  });

  // Test 6: insert message with no matching session → FK violation throws
  it('insert message with missing session throws FK error', () => {
    expect(() => {
      msgRepo.insert({ session_id: 'nonexistent', id: 'm1', direction: 'user', ts: 100, content: 'bad' });
    }).toThrow();
  });

  // Test 7: direction 'user' and 'assistant' succeed; 'bot' throws CHECK constraint
  it("direction 'user' and 'assistant' succeed; 'bot' throws", () => {
    insertSession('s1');
    expect(() =>
      msgRepo.insert({ session_id: 's1', id: 'm1', direction: 'user', ts: 100, content: 'ok' })
    ).not.toThrow();
    expect(() =>
      msgRepo.insert({ session_id: 's1', id: 'm2', direction: 'assistant', ts: 101, content: 'ok' })
    ).not.toThrow();
    expect(() =>
      // @ts-expect-error intentional invalid direction
      msgRepo.insert({ session_id: 's1', id: 'm3', direction: 'bot', ts: 102, content: 'bad' })
    ).toThrow();
  });

  // Test 8: findBySession on unknown session → empty array
  it('findBySession for unknown session returns empty array', () => {
    const rows = msgRepo.findBySession('unknown');
    expect(rows).toEqual([]);
  });

  // Test 9: findBySession orders by ts DESC
  it('findBySession returns rows ordered by ts DESC', () => {
    insertSession('s1');
    msgRepo.insert({ session_id: 's1', id: 'm1', direction: 'user', ts: 10, content: 'a' });
    msgRepo.insert({ session_id: 's1', id: 'm2', direction: 'user', ts: 30, content: 'c' });
    msgRepo.insert({ session_id: 's1', id: 'm3', direction: 'user', ts: 20, content: 'b' });
    const rows = msgRepo.findBySession('s1');
    expect(rows[0].ts).toBe(30);
    expect(rows[1].ts).toBe(20);
    expect(rows[2].ts).toBe(10);
  });

  // Test 10: findBySession with limit=2 returns 2 most-recent rows (insert 5)
  it('findBySession with limit=2 returns 2 most-recent rows', () => {
    insertSession('s1');
    for (let i = 1; i <= 5; i++) {
      msgRepo.insert({ session_id: 's1', id: `m${i}`, direction: 'user', ts: i * 10, content: `msg${i}` });
    }
    const rows = msgRepo.findBySession('s1', { limit: 2 });
    expect(rows.length).toBe(2);
    expect(rows[0].ts).toBe(50);
    expect(rows[1].ts).toBe(40);
  });

  // Test 11: findBySession with before=<ts> filters out messages with ts >= before
  it('findBySession with before filters messages by ts', () => {
    insertSession('s1');
    msgRepo.insert({ session_id: 's1', id: 'm1', direction: 'user', ts: 10, content: 'a' });
    msgRepo.insert({ session_id: 's1', id: 'm2', direction: 'user', ts: 20, content: 'b' });
    msgRepo.insert({ session_id: 's1', id: 'm3', direction: 'user', ts: 30, content: 'c' });
    const rows = msgRepo.findBySession('s1', { before: 25 });
    // Should return ts=10 and ts=20 (both < 25), ordered DESC
    expect(rows.length).toBe(2);
    expect(rows[0].ts).toBe(20);
    expect(rows[1].ts).toBe(10);
  });

  // Test 12: findBySession with limit=1000 silently caps at 500
  // The cap is enforced in code: Math.min(limit, 500). With 5 rows inserted
  // and limit=1000, we get ≤ 5 (capped to 500 internally, but only 5 exist).
  // To verify the cap code path with data: insert 600 rows and assert only 500 returned.
  it('findBySession with limit=1000 silently caps at 500', () => {
    insertSession('s1');
    for (let i = 1; i <= 600; i++) {
      msgRepo.insert({ session_id: 's1', id: `m${i}`, direction: 'user', ts: i, content: `msg${i}` });
    }
    const rows = msgRepo.findBySession('s1', { limit: 1000 });
    // Cap enforced: never more than 500 returned even when 600 rows exist
    expect(rows.length).toBe(500);
  });

  // Fix 4: NaN guard — NaN must not be passed to SQLite as LIMIT (SQLite treats it as 0)
  it('findBySession with limit=NaN returns rows using DEFAULT_LIMIT (not 0)', () => {
    insertSession('s1');
    for (let i = 1; i <= 3; i++) {
      msgRepo.insert({ session_id: 's1', id: `m${i}`, direction: 'user', ts: i * 10, content: `msg${i}` });
    }
    const rows = msgRepo.findBySession('s1', { limit: NaN });
    // DEFAULT_LIMIT=50, all 3 rows fit — must return 3, not 0
    expect(rows.length).toBe(3);
  });

  // Test 12b: limit=0 and limit=-1 are clamped to 1 (not silently unlimited).
  // Without the floor clamp, SQLite treats LIMIT -1 as unlimited.
  it('findBySession with limit=0 returns at most 1 row (clamped, never unlimited)', () => {
    insertSession('s1');
    for (let i = 1; i <= 5; i++) {
      msgRepo.insert({ session_id: 's1', id: `m${i}`, direction: 'user', ts: i, content: `msg${i}` });
    }
    expect(msgRepo.findBySession('s1', { limit: 0 }).length).toBe(1);
    expect(msgRepo.findBySession('s1', { limit: -1 }).length).toBe(1);
    expect(msgRepo.findBySession('s1', { limit: -9999 }).length).toBe(1);
  });

  // Test 13: returned Message objects have all six fields
  it('returned Message objects have all required fields', () => {
    insertSession('s1');
    msgRepo.insert({ session_id: 's1', id: 'm1', direction: 'user', ts: 100, content: 'hello', ingested_at: 999 });
    const rows = msgRepo.findBySession('s1');
    expect(rows.length).toBe(1);
    const msg = rows[0];
    expect(typeof msg.session_id).toBe('string');
    expect(typeof msg.id).toBe('string');
    expect(typeof msg.direction).toBe('string');
    expect(typeof msg.ts).toBe('number');
    expect(typeof msg.ingested_at).toBe('number');
    expect(typeof msg.content).toBe('string');
    // Verify all six fields are present by checking the keys
    expect('session_id' in msg).toBe(true);
    expect('id' in msg).toBe(true);
    expect('direction' in msg).toBe(true);
    expect('ts' in msg).toBe(true);
    expect('ingested_at' in msg).toBe(true);
    expect('content' in msg).toBe(true);
  });
});

describe('SqliteSessionRepo', () => {
  // Test 14: upsert new session → findById returns it with first_seen_at === last_seen_at === now
  it('upsert new session → findById returns correct data', () => {
    sessRepo.upsert({ id: 'sess1', name: 'My Session', now: 5000 });
    const sess = sessRepo.findById('sess1');
    expect(sess).not.toBeNull();
    expect(sess!.id).toBe('sess1');
    expect(sess!.name).toBe('My Session');
    expect(sess!.first_seen_at).toBe(5000);
    expect(sess!.last_seen_at).toBe(5000);
  });

  // Test 15: upsert again with later now and different name → first_seen_at unchanged, last_seen_at updated, name updated
  it('second upsert updates last_seen_at and name but not first_seen_at', () => {
    sessRepo.upsert({ id: 'sess1', name: 'Original', now: 1000 });
    sessRepo.upsert({ id: 'sess1', name: 'Updated', now: 9999 });
    const sess = sessRepo.findById('sess1');
    expect(sess).not.toBeNull();
    expect(sess!.first_seen_at).toBe(1000);
    expect(sess!.last_seen_at).toBe(9999);
    expect(sess!.name).toBe('Updated');
  });

  // Test 16: findById for unknown id → returns null
  it('findById unknown id returns null', () => {
    const result = sessRepo.findById('does-not-exist');
    expect(result).toBeNull();
  });

  // P1 tests: findById returns new fields

  it('findById returns status and last_read_at fields', () => {
    sessRepo.upsert({ id: 'sess1', name: 'S', now: 1000 });
    const sess = sessRepo.findById('sess1');
    expect(sess).not.toBeNull();
    expect(sess!.status).toBe('active');
    expect(sess!.last_read_at).toBe(0);
  });
});

// ── P1: findAll tests ──────────────────────────────────────────────────────────

describe('SqliteSessionRepo.findAll', () => {
  it('findAll on empty DB returns []', () => {
    const items = sessRepo.findAll();
    expect(items).toEqual([]);
  });

  it('findAll with one session, zero messages → one item, unread_count=0, status=active, last_read_at=0', () => {
    sessRepo.upsert({ id: 's1', name: 'Solo', now: 1000 });
    const items = sessRepo.findAll();
    expect(items.length).toBe(1);
    expect(items[0].id).toBe('s1');
    expect(items[0].unread_count).toBe(0);
    expect(items[0].status).toBe('active');
    expect(items[0].last_read_at).toBe(0);
  });

  it('findAll with assistant + user messages → unread_count counts only assistant', () => {
    sessRepo.upsert({ id: 's1', name: 'S', now: 1000 });
    // ts is > last_read_at (0), so assistant messages count as unread
    msgRepo.insert({ session_id: 's1', id: 'm1', direction: 'assistant', ts: 10, content: 'hi' });
    msgRepo.insert({ session_id: 's1', id: 'm2', direction: 'assistant', ts: 20, content: 'there' });
    msgRepo.insert({ session_id: 's1', id: 'm3', direction: 'user', ts: 30, content: 'hello' });
    const items = sessRepo.findAll();
    expect(items.length).toBe(1);
    // 2 assistant messages with ts > last_read_at=0; 1 user not counted
    expect(items[0].unread_count).toBe(2);
  });

  it('findAll with messages where ts <= last_read_at → those excluded from unread_count', () => {
    sessRepo.upsert({ id: 's1', name: 'S', now: 1000 });
    // Manually set last_read_at=50 via raw SQL (no setter in repo yet)
    db.run(`UPDATE sessions SET last_read_at=50 WHERE id='s1'`);
    msgRepo.insert({ session_id: 's1', id: 'm1', direction: 'assistant', ts: 30, content: 'old' });
    msgRepo.insert({ session_id: 's1', id: 'm2', direction: 'assistant', ts: 50, content: 'at boundary' });
    msgRepo.insert({ session_id: 's1', id: 'm3', direction: 'assistant', ts: 60, content: 'new' });
    const items = sessRepo.findAll();
    expect(items.length).toBe(1);
    // Only ts=60 (> 50) counts; ts=30 and ts=50 do not
    expect(items[0].unread_count).toBe(1);
  });

  it('findAll ORDER BY last_seen_at DESC — two sessions ordered correctly', () => {
    sessRepo.upsert({ id: 'early', name: 'Early', now: 1000 });
    sessRepo.upsert({ id: 'late', name: 'Late', now: 9000 });
    const items = sessRepo.findAll();
    expect(items.length).toBe(2);
    expect(items[0].id).toBe('late');
    expect(items[1].id).toBe('early');
  });
});

// ── P1: findBySessionPage tests ────────────────────────────────────────────────

describe('SqliteMessageRepo.findBySessionPage', () => {
  it('unknown session_id → { messages: [], has_more: false }', () => {
    const result = msgRepo.findBySessionPage('no-such-session');
    expect(result.messages).toEqual([]);
    expect(result.has_more).toBe(false);
  });

  it('before_id pointing to unknown message → { messages: [], has_more: false }', () => {
    sessRepo.upsert({ id: 's1', name: 'S', now: 1000 });
    msgRepo.insert({ session_id: 's1', id: 'm1', direction: 'user', ts: 100, content: 'hello' });
    const result = msgRepo.findBySessionPage('s1', { before_id: 'nonexistent-id' });
    expect(result.messages).toEqual([]);
    expect(result.has_more).toBe(false);
  });

  it('limit=2, exactly 2 rows → has_more=false, messages.length=2', () => {
    sessRepo.upsert({ id: 's1', name: 'S', now: 1000 });
    msgRepo.insert({ session_id: 's1', id: 'm1', direction: 'user', ts: 10, content: 'a' });
    msgRepo.insert({ session_id: 's1', id: 'm2', direction: 'user', ts: 20, content: 'b' });
    const result = msgRepo.findBySessionPage('s1', { limit: 2 });
    expect(result.has_more).toBe(false);
    expect(result.messages.length).toBe(2);
  });

  it('limit=2, 3 rows total → has_more=true, messages.length=2 (most-recent 2, ORDER BY ts DESC)', () => {
    sessRepo.upsert({ id: 's1', name: 'S', now: 1000 });
    msgRepo.insert({ session_id: 's1', id: 'm1', direction: 'user', ts: 10, content: 'oldest' });
    msgRepo.insert({ session_id: 's1', id: 'm2', direction: 'user', ts: 20, content: 'middle' });
    msgRepo.insert({ session_id: 's1', id: 'm3', direction: 'user', ts: 30, content: 'newest' });
    const result = msgRepo.findBySessionPage('s1', { limit: 2 });
    expect(result.has_more).toBe(true);
    expect(result.messages.length).toBe(2);
    // Most-recent 2 are ts=30, ts=20
    expect(result.messages[0].ts).toBe(30);
    expect(result.messages[1].ts).toBe(20);
  });

  it('with before_id on real cursor → returns rows strictly older than cursor ts', () => {
    sessRepo.upsert({ id: 's1', name: 'S', now: 1000 });
    msgRepo.insert({ session_id: 's1', id: 'm1', direction: 'user', ts: 10, content: 'oldest' });
    msgRepo.insert({ session_id: 's1', id: 'm2', direction: 'user', ts: 20, content: 'middle' });
    msgRepo.insert({ session_id: 's1', id: 'm3', direction: 'user', ts: 30, content: 'newest' });
    // before_id='m3' (ts=30) → should return only rows with ts < 30
    const result = msgRepo.findBySessionPage('s1', { before_id: 'm3', limit: 10 });
    expect(result.has_more).toBe(false);
    expect(result.messages.length).toBe(2);
    expect(result.messages[0].ts).toBe(20);
    expect(result.messages[1].ts).toBe(10);
  });

  it('limit=0 clamps to 1', () => {
    sessRepo.upsert({ id: 's1', name: 'S', now: 1000 });
    for (let i = 1; i <= 3; i++) {
      msgRepo.insert({ session_id: 's1', id: `m${i}`, direction: 'user', ts: i * 10, content: `msg${i}` });
    }
    const result = msgRepo.findBySessionPage('s1', { limit: 0 });
    expect(result.messages.length).toBe(1);
  });

  it('limit=-5 clamps to 1', () => {
    sessRepo.upsert({ id: 's1', name: 'S', now: 1000 });
    for (let i = 1; i <= 3; i++) {
      msgRepo.insert({ session_id: 's1', id: `m${i}`, direction: 'user', ts: i * 10, content: `msg${i}` });
    }
    const result = msgRepo.findBySessionPage('s1', { limit: -5 });
    expect(result.messages.length).toBe(1);
  });

  it('limit=9999 clamps to 500', () => {
    sessRepo.upsert({ id: 's1', name: 'S', now: 1000 });
    for (let i = 1; i <= 600; i++) {
      msgRepo.insert({ session_id: 's1', id: `m${i}`, direction: 'user', ts: i, content: `msg${i}` });
    }
    const result = msgRepo.findBySessionPage('s1', { limit: 9999 });
    expect(result.messages.length).toBe(500);
    expect(result.has_more).toBe(true);
  });

  // Fix 3: composite cursor (ts, id) — duplicate ts pagination
  it('pagination with duplicate ts: insert 3 messages at same ts with ids m1,m2,m3; page limit=2 without cursor returns newest 2 (m3,m2) and has_more=true; next page with before_id=m2 returns m1 and has_more=false', () => {
    sessRepo.upsert({ id: 's1', name: 'S', now: 1000 });
    // All share the same ts — ordering falls back to id DESC
    msgRepo.insert({ session_id: 's1', id: 'm1', direction: 'user', ts: 100, content: 'first' });
    msgRepo.insert({ session_id: 's1', id: 'm2', direction: 'user', ts: 100, content: 'second' });
    msgRepo.insert({ session_id: 's1', id: 'm3', direction: 'user', ts: 100, content: 'third' });

    // First page: limit=2, no cursor
    const page1 = msgRepo.findBySessionPage('s1', { limit: 2 });
    expect(page1.has_more).toBe(true);
    expect(page1.messages.length).toBe(2);
    expect(page1.messages[0].id).toBe('m3');
    expect(page1.messages[1].id).toBe('m2');

    // Second page: before_id='m2'
    const page2 = msgRepo.findBySessionPage('s1', { before_id: 'm2', limit: 2 });
    expect(page2.has_more).toBe(false);
    expect(page2.messages.length).toBe(1);
    expect(page2.messages[0].id).toBe('m1');
  });

  it('pagination is stable across pages when all ts identical', () => {
    sessRepo.upsert({ id: 's1', name: 'S', now: 1000 });
    // Insert 4 messages all with same ts; ids are lexicographically ordered
    for (const id of ['ma', 'mb', 'mc', 'md']) {
      msgRepo.insert({ session_id: 's1', id, direction: 'user', ts: 500, content: id });
    }
    // Page 1: limit=2, no cursor → md, mc (DESC by id)
    const page1 = msgRepo.findBySessionPage('s1', { limit: 2 });
    expect(page1.has_more).toBe(true);
    expect(page1.messages.map((m) => m.id)).toEqual(['md', 'mc']);

    // Page 2: before_id='mc' → mb, ma
    const page2 = msgRepo.findBySessionPage('s1', { before_id: 'mc', limit: 2 });
    expect(page2.has_more).toBe(false);
    expect(page2.messages.map((m) => m.id)).toEqual(['mb', 'ma']);
  });

  // Fix 4: NaN guard on limit
  it('findBySessionPage with limit=NaN returns rows using DEFAULT_LIMIT (not 0)', () => {
    sessRepo.upsert({ id: 's1', name: 'S', now: 1000 });
    for (let i = 1; i <= 3; i++) {
      msgRepo.insert({ session_id: 's1', id: `m${i}`, direction: 'user', ts: i * 10, content: `msg${i}` });
    }
    const result = msgRepo.findBySessionPage('s1', { limit: NaN });
    // DEFAULT_LIMIT=50, all 3 rows fit
    expect(result.messages.length).toBe(3);
    expect(result.has_more).toBe(false);
  });
});

// ── P2.3: MessageRepo.findById tests ──────────────────────────────────────────

describe('SqliteMessageRepo.findById', () => {
  it('findById round-trip hit → returns the correct message', () => {
    insertSession('s1');
    msgRepo.insert({ session_id: 's1', id: 'm1', direction: 'assistant', ts: 300, content: 'Hi there', ingested_at: 310 });
    const msg = msgRepo.findById('s1', 'm1');
    expect(msg).not.toBeNull();
    expect(msg!.session_id).toBe('s1');
    expect(msg!.id).toBe('m1');
    expect(msg!.ts).toBe(300);
    expect(msg!.content).toBe('Hi there');
    expect(msg!.direction).toBe('assistant');
  });

  it('findById unknown id → returns null', () => {
    insertSession('s1');
    const msg = msgRepo.findById('s1', 'no-such-id');
    expect(msg).toBeNull();
  });

  it('findById with mismatched session_id → returns null (cross-session isolation)', () => {
    insertSession('s1');
    insertSession('s2');
    msgRepo.insert({ session_id: 's2', id: 'm1', direction: 'user', ts: 100, content: 'secret' });
    // Looking up m1 under s1 should NOT find the s2 message
    const msg = msgRepo.findById('s1', 'm1');
    expect(msg).toBeNull();
  });
});

// ── P2.3: SessionRepo.updateLastReadAt tests ──────────────────────────────────

describe('SqliteSessionRepo.updateLastReadAt', () => {
  it('updateLastReadAt on existing session → last_read_at updated', () => {
    sessRepo.upsert({ id: 's1', name: 'S', now: 1000 });
    sessRepo.updateLastReadAt('s1', 500);
    const sess = sessRepo.findById('s1');
    expect(sess).not.toBeNull();
    expect(sess!.last_read_at).toBe(500);
  });

  it('updateLastReadAt monotonic: calling with earlier ts does not roll backwards', () => {
    sessRepo.upsert({ id: 's1', name: 'S', now: 1000 });
    sessRepo.updateLastReadAt('s1', 800);
    sessRepo.updateLastReadAt('s1', 400); // earlier ts — must NOT overwrite 800
    const sess = sessRepo.findById('s1');
    expect(sess).not.toBeNull();
    expect(sess!.last_read_at).toBe(800); // still 800, not 400
  });

  it('updateLastReadAt on unknown session_id → no throw, no rows affected (no-op)', () => {
    // Should not throw even though session doesn't exist
    expect(() => {
      sessRepo.updateLastReadAt('nonexistent-session', 12345);
    }).not.toThrow();
    // Verify nothing was created
    const sess = sessRepo.findById('nonexistent-session');
    expect(sess).toBeNull();
  });

  it('delete existing session → returns true and row is gone', () => {
    sessRepo.upsert({ id: 'del-sess', name: 'Del', now: 100 });
    expect(sessRepo.findById('del-sess')).not.toBeNull();
    const deleted = sessRepo.delete('del-sess');
    expect(deleted).toBe(true);
    expect(sessRepo.findById('del-sess')).toBeNull();
  });

  it('delete non-existent session → returns false', () => {
    const deleted = sessRepo.delete('no-such-session');
    expect(deleted).toBe(false);
  });
});

// ── rename tests ──────────────────────────────────────────────────────────────

describe('SqliteSessionRepo.rename', () => {
  it('rename existing session → returns true and name is updated', () => {
    sessRepo.upsert({ id: 'r1', name: 'Original', now: 1000 });
    const result = sessRepo.rename('r1', 'Renamed');
    expect(result).toBe(true);
    const sess = sessRepo.findById('r1');
    expect(sess).not.toBeNull();
    expect(sess!.name).toBe('Renamed');
  });

  it('rename unknown session → returns false', () => {
    const result = sessRepo.rename('no-such-id', 'Whatever');
    expect(result).toBe(false);
  });

  it('rename with same name (idempotent) → returns true', () => {
    sessRepo.upsert({ id: 'r2', name: 'Stable', now: 1000 });
    const result = sessRepo.rename('r2', 'Stable');
    expect(result).toBe(true);
    const sess = sessRepo.findById('r2');
    expect(sess!.name).toBe('Stable');
  });
});

describe('SqliteMessageRepo.deleteBySession()', () => {
  it('deleteBySession removes all messages for a session', () => {
    sessRepo.upsert({ id: 'sess-del-msg', name: 'Test', now: 100 });
    msgRepo.insert({ session_id: 'sess-del-msg', id: 'm1', direction: 'user', ts: 100, content: 'a' });
    msgRepo.insert({ session_id: 'sess-del-msg', id: 'm2', direction: 'assistant', ts: 200, content: 'b' });
    expect(msgRepo.findBySession('sess-del-msg')).toHaveLength(2);

    msgRepo.deleteBySession('sess-del-msg');
    expect(msgRepo.findBySession('sess-del-msg')).toHaveLength(0);
  });

  it('deleteBySession is no-op for unknown session — does not throw', () => {
    expect(() => msgRepo.deleteBySession('unknown-sess')).not.toThrow();
  });

  it('deleteBySession does not affect other sessions', () => {
    sessRepo.upsert({ id: 'sess-a', name: 'A', now: 100 });
    sessRepo.upsert({ id: 'sess-b', name: 'B', now: 100 });
    msgRepo.insert({ session_id: 'sess-a', id: 'ma1', direction: 'user', ts: 100, content: 'a' });
    msgRepo.insert({ session_id: 'sess-b', id: 'mb1', direction: 'user', ts: 100, content: 'b' });

    msgRepo.deleteBySession('sess-a');
    expect(msgRepo.findBySession('sess-a')).toHaveLength(0);
    expect(msgRepo.findBySession('sess-b')).toHaveLength(1);
  });
});
