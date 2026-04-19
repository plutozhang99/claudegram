import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { openDatabase, closeDatabase } from '../db/client.js';
import { migrate } from '../db/migrate.js';
import { SqliteMessageRepo, SqliteSessionRepo } from '../repo/sqlite.js';
import { dispatch } from '../http.js';
import type { RouterCtx } from '../http.js';
import type { MessageRepo, SessionRepo } from '../repo/types.js';
import type { Logger } from '../logger.js';
import type { Hub, BroadcastPayload } from '../ws/hub.js';
import { INGEST_MAX_BODY_BYTES } from './ingest.js';

// ── Shared no-op logger ──────────────────────────────────────────────────────
const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};


function makeStubHub(): Hub {
  return {
    add: () => {},
    remove: () => {},
    broadcast: (_payload: BroadcastPayload) => {},
    get size() { return 0; },
  };
}

function makeReq(
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Request {
  const url = `http://localhost${path}`;
  if (body === undefined) {
    return new Request(url, { method, headers });
  }
  const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
  return new Request(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: bodyStr,
  });
}

const validPayload = {
  session_id: 's1',
  message: {
    id: 'm1',
    direction: 'assistant',
    ts: 1_700_000_000,
    content: 'hello',
  },
};

// ── Test suite ────────────────────────────────────────────────────────────────

describe('POST /ingest', () => {
  let db: Database;
  let msgRepo: SqliteMessageRepo;
  let sessRepo: SqliteSessionRepo;
  let ctx: RouterCtx;

  beforeEach(() => {
    db = openDatabase(':memory:');
    migrate(db);
    msgRepo = new SqliteMessageRepo(db);
    sessRepo = new SqliteSessionRepo(db);
    ctx = {
      msgRepo,
      sessRepo,
      logger: noopLogger,
      db,
      hub: makeStubHub(),
      config: {
        port: 8788,
        db_path: ':memory:',
        log_level: 'info',
        trustCfAccess: false,
        wsOutboundBufferCapBytes: 1_048_576,
      },
      webRoot: '/tmp/__claudegram_test_nonexistent_web__',
    };
  });

  afterEach(() => {
    closeDatabase(db);
  });

  // Case 1: valid payload → 200, DB has session + message
  it('returns 200 with message_id and persists session + message', async () => {
    const req = makeReq('POST', '/ingest', validPayload);
    const res = await dispatch(req, ctx);
    expect(res.status).toBe(200);
    const json = await res.json() as { ok: boolean; message_id: string };
    expect(json.ok).toBe(true);
    expect(json.message_id).toBe('m1');

    const session = sessRepo.findById('s1');
    expect(session).not.toBeNull();
    expect(session!.id).toBe('s1');

    const messages = msgRepo.findBySession('s1');
    expect(messages).toHaveLength(1);
    expect(messages[0]!.id).toBe('m1');
  });

  // Case 2: missing session_id → 400 with issues
  it('returns 400 with issues when session_id is missing', async () => {
    const payload = {
      message: { id: 'm1', direction: 'assistant', ts: 0, content: 'hi' },
    };
    const req = makeReq('POST', '/ingest', payload);
    const res = await dispatch(req, ctx);
    expect(res.status).toBe(400);
    const json = await res.json() as { ok: boolean; error: string; issues: unknown[] };
    expect(json.ok).toBe(false);
    expect(json.error).toBe('invalid payload');
    expect(Array.isArray(json.issues)).toBe(true);
    expect(json.issues.length).toBeGreaterThan(0);
  });

  // Case 3: invalid direction='bot' → 400 with issues
  it('returns 400 with issues when direction is invalid', async () => {
    const payload = {
      session_id: 's1',
      message: { id: 'm1', direction: 'bot', ts: 0, content: 'hi' },
    };
    const req = makeReq('POST', '/ingest', payload);
    const res = await dispatch(req, ctx);
    expect(res.status).toBe(400);
    const json = await res.json() as { ok: boolean; error: string; issues: unknown[] };
    expect(json.ok).toBe(false);
    expect(json.error).toBe('invalid payload');
    expect(Array.isArray(json.issues)).toBe(true);
    expect(json.issues.length).toBeGreaterThan(0);
  });

  // Case 4: invalid JSON → 400 with error:'invalid json'
  it('returns 400 when body is not valid JSON', async () => {
    const brokenReq = new Request('http://localhost/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    });
    const res = await dispatch(brokenReq, ctx);
    expect(res.status).toBe(400);
    const json = await res.json() as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toBe('invalid json');
  });

  // Case 5: Content-Length header > cap with tiny actual body → 413
  it('returns 413 when Content-Length header exceeds cap', async () => {
    const req = new Request('http://localhost/ingest', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(INGEST_MAX_BODY_BYTES + 1),
      },
      body: '{}',
    });
    const res = await dispatch(req, ctx);
    expect(res.status).toBe(413);
    const json = await res.json() as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toBe('payload too large');
  });

  // Case 6: real body > 1 MiB (no Content-Length) → 413
  it('returns 413 when actual body exceeds cap (no Content-Length)', async () => {
    // 1 MiB + 1 byte of 'x' characters
    const bigBody = 'x'.repeat(INGEST_MAX_BODY_BYTES + 1);
    const req = new Request('http://localhost/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: bigBody,
    });
    const res = await dispatch(req, ctx);
    expect(res.status).toBe(413);
    const json = await res.json() as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toBe('payload too large');
  });

  // Case 6b: Content-Length: abc (non-numeric) → 400 invalid content-length
  // Attack vector: sending a non-numeric Content-Length bypasses the fast-reject
  // numeric check and could cause unbounded buffering without this guard.
  it('returns 400 when Content-Length is non-numeric (NaN bypass)', async () => {
    const req = new Request('http://localhost/ingest', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': 'abc',
      },
      body: '{}',
    });
    const res = await dispatch(req, ctx);
    expect(res.status).toBe(400);
    const json = await res.json() as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toBe('invalid content-length');
  });

  // Case 6c: streaming body > 1 MiB without a Content-Length header → 413
  // Attack vector: omit Content-Length entirely (or send a lying value below the cap)
  // so the fast-reject is skipped; the streaming reader must cap during read to
  // prevent unbounded memory allocation before the body is fully received.
  it('returns 413 on streaming body > cap with no Content-Length (streaming cap)', async () => {
    // Build a body that is 1 byte over the cap.
    // We pass it as a string without setting Content-Length so only the
    // streaming path can detect the oversize payload.
    const bigBody = 'x'.repeat(INGEST_MAX_BODY_BYTES + 1);
    // Construct using a ReadableStream so Bun does not auto-set Content-Length.
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(bigBody));
        controller.close();
      },
    });
    const req = new Request('http://localhost/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: stream,
    });
    const res = await dispatch(req, ctx);
    expect(res.status).toBe(413);
    const json = await res.json() as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toBe('payload too large');
  });

  // Case 7: no session_name → session created with name === session_id
  it('creates session with name equal to session_id when session_name is omitted', async () => {
    const req = makeReq('POST', '/ingest', validPayload);
    const res = await dispatch(req, ctx);
    expect(res.status).toBe(200);

    const session = sessRepo.findById('s1');
    expect(session).not.toBeNull();
    expect(session!.name).toBe('s1');
  });

  // Case 8: same (session_id, message.id) twice → both 200, DB has 1 message (idempotent)
  it('is idempotent: duplicate (session_id, message.id) returns 200 and stores 1 message', async () => {
    const req1 = makeReq('POST', '/ingest', validPayload);
    const req2 = makeReq('POST', '/ingest', validPayload);

    const res1 = await dispatch(req1, ctx);
    const res2 = await dispatch(req2, ctx);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    const messages = msgRepo.findBySession('s1');
    expect(messages).toHaveLength(1);
  });

  // Case 9: GET /ingest → 405
  it('returns 405 for GET /ingest', async () => {
    const req = new Request('http://localhost/ingest', { method: 'GET' });
    const res = await dispatch(req, ctx);
    expect(res.status).toBe(405);
    const json = await res.json() as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toBe('method not allowed');
  });

  // Case 10: repo throws → 500
  it('returns 500 when repo throws', async () => {
    const errors: Array<[string, Record<string, unknown>]> = [];
    const errorCapturingLogger: Logger = {
      ...noopLogger,
      error: (msg, fields) => { errors.push([msg, fields ?? {}]); },
    };

    const stubMsgRepo: MessageRepo = {
      insert: () => { throw new Error('DB exploded'); },
      findBySession: () => [],
      findBySessionPage: () => ({ messages: [], has_more: false }),
    };

    const stubSessRepo: SessionRepo = {
      upsert: () => {},
      findById: () => null,
      findAll: () => [],
    };

    const stubCtx: RouterCtx = {
      msgRepo: stubMsgRepo,
      sessRepo: stubSessRepo,
      logger: errorCapturingLogger,
      db: null as unknown as RouterCtx['db'],
      hub: makeStubHub(),
      config: {
        port: 8788,
        db_path: ':memory:',
        log_level: 'info',
        trustCfAccess: false,
        wsOutboundBufferCapBytes: 1_048_576,
      },
      webRoot: '/tmp/__claudegram_test_nonexistent_web__',
    };

    const req = makeReq('POST', '/ingest', validPayload);
    const res = await dispatch(req, stubCtx);
    expect(res.status).toBe(500);
    const json = await res.json() as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toBe('internal error');

    // Verify logger.error was called with correct event name
    expect(errors.length).toBe(1);
    expect(errors[0]![0]).toBe('ingest_failed');
    expect(errors[0]![1]['session_id']).toBe('s1');
    expect(errors[0]![1]['message_id']).toBe('m1');
  });

  // ── Hub broadcast tests ──────────────────────────────────────────────────────

  // Case 11: successful ingest → hub.broadcast called twice (message + session_update)
  it('calls hub.broadcast twice on 200: once with type:message, once with type:session_update', async () => {
    const broadcasts: BroadcastPayload[] = [];
    const spyHub: Hub = {
      add: () => {},
      remove: () => {},
      broadcast: (payload: BroadcastPayload) => { broadcasts.push(payload); },
      get size() { return 0; },
    };

    const req = makeReq('POST', '/ingest', validPayload);
    const res = await dispatch(req, { ...ctx, hub: spyHub });
    expect(res.status).toBe(200);

    expect(broadcasts).toHaveLength(2);
    expect(broadcasts[0]!.type).toBe('message');
    expect(broadcasts[1]!.type).toBe('session_update');

    // Fix D: message broadcast must include ingested_at
    const msgPayload = broadcasts[0] as Extract<BroadcastPayload, { type: 'message' }>;
    expect(typeof msgPayload.message.ingested_at).toBe('number');
  });

  // Case 12: 400 response (invalid payload) → hub.broadcast NOT called
  it('does NOT call hub.broadcast on 400 (invalid payload)', async () => {
    const broadcasts: BroadcastPayload[] = [];
    const spyHub: Hub = {
      add: () => {},
      remove: () => {},
      broadcast: (payload: BroadcastPayload) => { broadcasts.push(payload); },
      get size() { return 0; },
    };

    const badPayload = { message: { id: 'm1', direction: 'assistant', ts: 0, content: 'hi' } };
    const req = makeReq('POST', '/ingest', badPayload);
    const res = await dispatch(req, { ...ctx, hub: spyHub });
    expect(res.status).toBe(400);
    expect(broadcasts).toHaveLength(0);
  });

  // Case 13: 413 response → hub.broadcast NOT called
  it('does NOT call hub.broadcast on 413 (payload too large)', async () => {
    const broadcasts: BroadcastPayload[] = [];
    const spyHub: Hub = {
      add: () => {},
      remove: () => {},
      broadcast: (payload: BroadcastPayload) => { broadcasts.push(payload); },
      get size() { return 0; },
    };

    const req = new Request('http://localhost/ingest', {
      method: 'POST',
      headers: { 'Content-Length': String(INGEST_MAX_BODY_BYTES + 1) },
      body: '{}',
    });
    const res = await dispatch(req, { ...ctx, hub: spyHub });
    expect(res.status).toBe(413);
    expect(broadcasts).toHaveLength(0);
  });

  // Case 14: 500 (repo throws) → hub.broadcast NOT called
  it('does NOT call hub.broadcast on 500 (repo throws)', async () => {
    const broadcasts: BroadcastPayload[] = [];
    const spyHub: Hub = {
      add: () => {},
      remove: () => {},
      broadcast: (payload: BroadcastPayload) => { broadcasts.push(payload); },
      get size() { return 0; },
    };

    const throwingMsgRepo: MessageRepo = {
      insert: () => { throw new Error('DB exploded'); },
      findBySession: () => [],
      findBySessionPage: () => ({ messages: [], has_more: false }),
    };

    const throwingSessRepo: SessionRepo = {
      upsert: () => {},
      findById: () => null,
      findAll: () => [],
    };

    const failCtx: RouterCtx = {
      msgRepo: throwingMsgRepo,
      sessRepo: throwingSessRepo,
      logger: noopLogger,
      db: null as unknown as RouterCtx['db'],
      hub: spyHub,
      config: {
        port: 8788,
        db_path: ':memory:',
        log_level: 'info',
        trustCfAccess: false,
        wsOutboundBufferCapBytes: 1_048_576,
      },
      webRoot: '/tmp/__claudegram_test_nonexistent_web__',
    };

    const req = makeReq('POST', '/ingest', validPayload);
    const res = await dispatch(req, failCtx);
    expect(res.status).toBe(500);
    expect(broadcasts).toHaveLength(0);
  });

  // Case 15 (R15): hub.broadcast throws → ingest still returns 200
  it('returns 200 even when hub.broadcast throws (best-effort broadcast)', async () => {
    const throwingHub: Hub = {
      add: () => {},
      remove: () => {},
      broadcast: (_payload: BroadcastPayload) => { throw new Error('hub exploded'); },
      get size() { return 0; },
    };

    const req = makeReq('POST', '/ingest', validPayload);
    const res = await dispatch(req, { ...ctx, hub: throwingHub });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; message_id: string };
    expect(body.ok).toBe(true);
    expect(body.message_id).toBe('m1');
  });
});
