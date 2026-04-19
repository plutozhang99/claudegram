import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { openDatabase, closeDatabase } from '../db/client.js';
import { migrate } from '../db/migrate.js';
import type { Database } from '../db/client.js';
import { dispatch } from '../http.js';
import type { RouterCtx } from '../http.js';
import type { Hub, BroadcastPayload } from '../ws/hub.js';
import type { MessageRepo, SessionRepo } from '../repo/types.js';

// Minimal stub repos — no real DB interaction needed for repo methods.
const stubMsgRepo: MessageRepo = {
  insert: () => {},
  findBySession: () => [],
  findBySessionPage: () => ({ messages: [], has_more: false }),
  findById: () => null,
};

const stubSessRepo: SessionRepo = {
  upsert: () => {},
  findById: () => null,
  findAll: () => [],
  updateLastReadAt: () => {},
};

const stubLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function makeReq(method: string, path: string): Request {
  return new Request(`http://localhost${path}`, { method });
}

let db: Database;
function makeStubHub(): Hub {
  return {
    add: () => {},
    tryAdd: () => ({ ok: true as const }),
    remove: () => {},
    broadcast: (_payload: BroadcastPayload) => {},
    get size() { return 0; },
  };
}

let ctx: RouterCtx;

beforeEach(() => {
  db = openDatabase(':memory:');
  migrate(db);
  ctx = {
    msgRepo: stubMsgRepo,
    sessRepo: stubSessRepo,
    logger: stubLogger,
    db,
    hub: makeStubHub(),
    config: {
      port: 8788,
      db_path: './data/claudegram.db',
      log_level: 'info',
      trustCfAccess: false,
      wsOutboundBufferCapBytes: 1_048_576,
      wsInboundMaxBadFrames: 5,
      maxPwaConnections: 256,
      maxSessionConnections: 64,
    },
    webRoot: '/tmp/__claudegram_test_nonexistent_web__',
  };
});

afterEach(() => {
  closeDatabase(db);
});

describe('GET /health', () => {
  it('working DB → 200 { ok: true }', async () => {
    const res = await dispatch(makeReq('GET', '/health'), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });

  it('closed DB → 503 { ok: false, error: "database unavailable" }', async () => {
    // Close the DB before the request so the query throws.
    closeDatabase(db);
    const res = await dispatch(makeReq('GET', '/health'), ctx);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toEqual({ ok: false, error: 'database unavailable' });
  });
});

describe('non-GET /health', () => {
  it('POST /health → 405 { ok: false, error: "method not allowed" }', async () => {
    const res = await dispatch(makeReq('POST', '/health'), ctx);
    expect(res.status).toBe(405);
    const body = await res.json();
    expect(body).toEqual({ ok: false, error: 'method not allowed' });
  });

  it('PUT /health → 405', async () => {
    const res = await dispatch(makeReq('PUT', '/health'), ctx);
    expect(res.status).toBe(405);
    const body = await res.json();
    expect(body).toEqual({ ok: false, error: 'method not allowed' });
  });
});
