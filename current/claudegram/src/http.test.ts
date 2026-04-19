import { describe, it, expect, afterAll, mock, spyOn } from 'bun:test';
import { dispatch, jsonResponse } from './http.js';
import type { RouterCtx } from './http.js';
import type { MessageRepo, SessionRepo } from './repo/types.js';
import { openDatabase, closeDatabase } from './db/client.js';
import type { Hub, BroadcastPayload } from './ws/hub.js';

import * as sessionsModule from './routes/api/sessions.js';
import * as messagesModule from './routes/api/messages.js';
import * as meModule from './routes/api/me.js';

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


function makeStubHub(): Hub {
  return {
    add: () => {},
    remove: () => {},
    broadcast: (_payload: BroadcastPayload) => {},
    get size() { return 0; },
  };
}

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
  hub: makeStubHub(),
  config: {
    port: 8788,
    db_path: './data/claudegram.db',
    log_level: 'info',
    trustCfAccess: false,
    wsOutboundBufferCapBytes: 1_048_576,
  },
  // Point at a nonexistent dir so static file handlers return 404 (no disk I/O needed).
  webRoot: '/tmp/__claudegram_test_nonexistent_web__',
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

  it('/api/unknown → 404 (unrecognised api path)', async () => {
    const res = await dispatch(makeReq('GET', '/api/unknown'), ctx);
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

  it('/api/sessions → routed to handleApiSessions', async () => {
    const spy = spyOn(sessionsModule, 'handleApiSessions').mockReturnValue(
      new Response('{}', { status: 200 }),
    );
    await dispatch(makeReq('GET', '/api/sessions'), ctx);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('/api/messages → routed to handleApiMessages', async () => {
    const spy = spyOn(messagesModule, 'handleApiMessages').mockResolvedValue(
      new Response('{}', { status: 200 }),
    );
    await dispatch(makeReq('GET', '/api/messages?session_id=x'), ctx);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('/api/me → routed to handleApiMe', async () => {
    const spy = spyOn(meModule, 'handleApiMe').mockReturnValue(
      new Response('{}', { status: 200 }),
    );
    await dispatch(makeReq('GET', '/api/me'), ctx);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
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
