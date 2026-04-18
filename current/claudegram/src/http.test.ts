import { describe, it, expect, afterAll } from 'bun:test';
import { dispatch, jsonResponse } from './http.js';
import type { RouterCtx } from './http.js';
import type { MessageRepo, SessionRepo } from './repo/types.js';
import { openDatabase, closeDatabase } from './db/client.js';

// Minimal stub repos — no real DB needed.
const stubMsgRepo: MessageRepo = {
  insert: () => {},
  findBySession: () => [],
  findBySessionPage: () => ({ messages: [], has_more: false }),
};

const stubSessRepo: SessionRepo = {
  upsert: () => {},
  findById: () => null,
  findAll: () => [],
};

// Provide a real in-memory DB so RouterCtx is satisfied;
// these tests don't hit /health so the DB is never queried.
const db = openDatabase(':memory:');

afterAll(() => {
  closeDatabase(db);
});

const ctx: RouterCtx = {
  msgRepo: stubMsgRepo,
  sessRepo: stubSessRepo,
  logger: {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  },
  db,
};

function makeReq(method: string, path: string): Request {
  return new Request(`http://localhost${path}`, { method });
}

describe('dispatch', () => {
  it('GET /nope → 404 JSON not found', async () => {
    const res = await dispatch(makeReq('GET', '/nope'), ctx);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json();
    expect(body).toEqual({ ok: false, error: 'not found' });
  });

  it('/api/foo → 404 (reserved prefix)', async () => {
    const res = await dispatch(makeReq('GET', '/api/foo'), ctx);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ ok: false, error: 'not found' });
  });

  it('/web/index → 404 (reserved prefix)', async () => {
    const res = await dispatch(makeReq('GET', '/web/index'), ctx);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ ok: false, error: 'not found' });
  });

  it('GET / → 404', async () => {
    const res = await dispatch(makeReq('GET', '/'), ctx);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ ok: false, error: 'not found' });
  });
});

describe('jsonResponse', () => {
  it('returns correct status, content-type, and body', async () => {
    const res = jsonResponse(200, { ok: true });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });
});
