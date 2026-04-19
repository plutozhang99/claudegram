/**
 * integration-api.test.ts — Real HTTP integration tests for API routes (no mocks).
 *
 * Boots a full in-process server with an in-memory SQLite DB and exercises
 * the HTTP API routes via fetch(). No unit mocks are used.
 *
 * Port 0 → Bun assigns an ephemeral port; srv.port returns the actual binding.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import path from 'node:path';
import { openDatabase, closeDatabase } from './db/client.js';
import type { Database } from './db/client.js';
import { createServer } from './server.js';
import type { RunningServer } from './server.js';
import { createLogger } from './logger.js';
import type { Config } from './config.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeConfig(): Config {
  return { port: 0 as unknown as number, db_path: ':memory:', log_level: 'error', trustCfAccess: false, wsOutboundBufferCapBytes: 1_048_576, wsInboundMaxBadFrames: 5, maxPwaConnections: 256, maxSessionConnections: 64 };
}

const logger = createLogger({ level: 'error', stream: { write: () => {} } });

function get(port: number, urlPath: string, headers?: Record<string, string>): Promise<Response> {
  return fetch(`http://localhost:${port}${urlPath}`, { headers });
}

async function postIngest(port: number, body: unknown): Promise<Response> {
  return fetch(`http://localhost:${port}/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ── Suite ───────────────────────────────────────────────────────────────────

describe('API HTTP integration', () => {
  let db: Database;
  let srv: RunningServer;

  beforeAll(() => {
    db = openDatabase(':memory:');
    srv = createServer({
      config: makeConfig(),
      db,
      logger,
      webRoot: path.resolve(process.cwd(), 'web'),
    });
  });

  afterAll(async () => {
    await srv.stop(true);
    closeDatabase(db);
  });

  // ── GET /api/sessions ──────────────────────────────────────────────────────

  it('GET /api/sessions with empty DB → 200, {ok:true, sessions:[]}', async () => {
    const res = await get(srv.port, '/api/sessions');
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; sessions: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.sessions).toEqual([]);
  });

  it('GET /api/sessions after ingest → returns 1 session with correct fields (user direction = unread_count:0)', async () => {
    await postIngest(srv.port, {
      session_id: 'sess-user-dir',
      session_name: 'User Direction Session',
      message: { id: 'mu1', direction: 'user', ts: 1_700_000_100_000, content: 'user msg' },
    });

    const res = await get(srv.port, '/api/sessions');
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; sessions: Array<Record<string, unknown>> };
    expect(body.ok).toBe(true);

    const sess = body.sessions.find((s) => s['id'] === 'sess-user-dir');
    expect(sess).toBeDefined();
    expect(sess!['name']).toBe('User Direction Session');
    expect(sess!['status']).toBe('active');
    // user direction messages are NOT counted as unread (only assistant direction is)
    expect(sess!['unread_count']).toBe(0);
  });

  it('GET /api/sessions after assistant ingest → unread_count:1', async () => {
    await postIngest(srv.port, {
      session_id: 'sess-assistant-dir',
      session_name: 'Assistant Direction Session',
      message: { id: 'ma1', direction: 'assistant', ts: 1_700_000_200_000, content: 'assistant msg' },
    });

    const res = await get(srv.port, '/api/sessions');
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; sessions: Array<Record<string, unknown>> };

    const sess = body.sessions.find((s) => s['id'] === 'sess-assistant-dir');
    expect(sess).toBeDefined();
    expect(sess!['unread_count']).toBe(1);
  });

  it('GET /api/sessions — multiple sessions ordered by last_seen_at DESC', async () => {
    // Seed two sessions with distinct ts values so ordering is deterministic.
    await postIngest(srv.port, {
      session_id: 'sess-older',
      message: { id: 'mo1', direction: 'user', ts: 1_600_000_000_000, content: 'older' },
    });
    await postIngest(srv.port, {
      session_id: 'sess-newer',
      message: { id: 'mn1', direction: 'user', ts: 1_700_000_300_000, content: 'newer' },
    });

    const res = await get(srv.port, '/api/sessions');
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; sessions: Array<Record<string, unknown>> };

    // 'sess-newer' was ingested last so it should appear before 'sess-older'.
    const ids = body.sessions.map((s) => s['id']) as string[];
    const idxNewer = ids.indexOf('sess-newer');
    const idxOlder = ids.indexOf('sess-older');
    expect(idxNewer).toBeGreaterThanOrEqual(0);
    expect(idxOlder).toBeGreaterThanOrEqual(0);
    expect(idxNewer).toBeLessThan(idxOlder);
  });

  // ── GET /api/messages ──────────────────────────────────────────────────────

  it('GET /api/messages?session_id=unknown → 200, {ok:true, messages:[], has_more:false}', async () => {
    const res = await get(srv.port, '/api/messages?session_id=does-not-exist');
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; messages: unknown[]; has_more: boolean };
    expect(body.ok).toBe(true);
    expect(body.messages).toEqual([]);
    expect(body.has_more).toBe(false);
  });

  it('GET /api/messages without session_id → 400', async () => {
    const res = await get(srv.port, '/api/messages');
    expect(res.status).toBe(400);
    const body = await res.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
  });

  it('GET /api/messages?session_id=X&limit=2 with 3 messages → has_more:true, 2 most-recent', async () => {
    const sessionId = 'sess-pagination';

    // Insert 3 messages with distinct ts values (ascending).
    for (const [id, ts] of [['p1', 1_700_001_000_000], ['p2', 1_700_002_000_000], ['p3', 1_700_003_000_000]] as [string, number][]) {
      await postIngest(srv.port, {
        session_id: sessionId,
        message: { id, direction: 'user', ts, content: `msg ${id}` },
      });
    }

    const res = await get(srv.port, `/api/messages?session_id=${sessionId}&limit=2`);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; messages: Array<Record<string, unknown>>; has_more: boolean };
    expect(body.ok).toBe(true);
    expect(body.has_more).toBe(true);
    expect(body.messages).toHaveLength(2);

    // Results are ORDER BY ts DESC — newest first.
    expect(body.messages[0]!['id']).toBe('p3');
    expect(body.messages[1]!['id']).toBe('p2');
  });

  it('GET /api/messages?before=<newest_id> → returns older messages', async () => {
    const sessionId = 'sess-pagination'; // reuse session seeded above

    // 'p3' is newest; fetching before it should return 'p2' and 'p1'.
    const res = await get(srv.port, `/api/messages?session_id=${sessionId}&before=p3`);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; messages: Array<Record<string, unknown>>; has_more: boolean };
    expect(body.ok).toBe(true);
    // p2 and p1 are older than p3.
    const ids = body.messages.map((m) => m['id']);
    expect(ids).toContain('p2');
    expect(ids).toContain('p1');
    expect(ids).not.toContain('p3');
  });

  // ── GET /api/me ────────────────────────────────────────────────────────────

  it('GET /api/me without TRUST_CF_ACCESS → {ok:true, email:"local@dev"} regardless of header', async () => {
    // Even if the CF header is present, trustCfAccess=false means it should be ignored.
    const res = await get(srv.port, '/api/me', {
      'Cf-Access-Authenticated-User-Email': 'user@cloudflare.com',
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; email: string };
    expect(body.ok).toBe(true);
    expect(body.email).toBe('local@dev');
  });
});
