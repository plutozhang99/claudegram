import { describe, it, expect, mock } from 'bun:test';
import type { SessionRepo, MessageRepo } from '../../repo/types.js';
import type { SessionRegistry } from '../../ws/session-registry.js';
import type { Hub, BroadcastPayload } from '../../ws/hub.js';
import type { Logger } from '../../logger.js';
import { handleApiSessions, handleApiSessionDelete } from './sessions.js';

async function json(res: Response): Promise<Record<string, unknown>> {
  return res.json() as Promise<Record<string, unknown>>;
}

function makeReq(method: string, path = '/api/sessions'): Request {
  return new Request(`http://localhost${path}`, { method });
}

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** Minimal SessionRegistry stub — all sessions offline by default. */
function makeRegistry(connected: Record<string, boolean> = {}): SessionRegistry {
  return {
    register: mock(() => ({ [Symbol.dispose]: () => {} })),
    tryRegister: mock(() => ({ ok: true as const, disposable: { [Symbol.dispose]: () => {} } })),
    send: mock(() => ({ ok: true as const })),
    unregister: mock(() => {}),
    has: (id: string) => connected[id] === true,
    get size() { return Object.values(connected).filter(Boolean).length; },
  };
}

const emptyRepo = {
  sessRepo: {
    upsert: () => {},
    findById: () => null,
    findAll: () => [],
    updateLastReadAt: () => {},
    delete: () => false,
  } satisfies SessionRepo,
  sessionRegistry: makeRegistry(),
  logger: noopLogger,
};

const twoItemSessRepo: SessionRepo = {
  upsert: () => {},
  findById: () => null,
  findAll: () => [
    {
      id: 'sess-1',
      name: 'Session One',
      first_seen_at: 1000,
      last_seen_at: 2000,
      status: 'active',
      last_read_at: 1500,
      unread_count: 3,
    },
    {
      id: 'sess-2',
      name: 'Session Two',
      first_seen_at: 3000,
      last_seen_at: 4000,
      status: 'ended',
      last_read_at: 3500,
      unread_count: 0,
    },
  ],
  updateLastReadAt: () => {},
  delete: () => false,
};

describe('handleApiSessions', () => {
  it('GET with empty findAll → 200 { ok: true, sessions: [] }', async () => {
    const res = handleApiSessions(makeReq('GET'), emptyRepo);
    const r = res instanceof Promise ? await res : res;
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('application/json');
    const body = await json(r);
    expect(body).toEqual({ ok: true, sessions: [] });
  });

  it('GET with 2 items → returns both in order', async () => {
    const twoItemRepo = {
      sessRepo: twoItemSessRepo,
      sessionRegistry: makeRegistry(),
      logger: noopLogger,
    };
    const res = handleApiSessions(makeReq('GET'), twoItemRepo);
    const r = res instanceof Promise ? await res : res;
    expect(r.status).toBe(200);
    const body = await json(r);
    expect(body.ok).toBe(true);
    const sessions = body.sessions as Array<Record<string, unknown>>;
    expect(sessions).toHaveLength(2);
    expect(sessions[0].id).toBe('sess-1');
    expect(sessions[1].id).toBe('sess-2');
  });

  it('GET → sessions include connected:false when registry has no live sockets', async () => {
    const twoItemRepo = {
      sessRepo: twoItemSessRepo,
      sessionRegistry: makeRegistry(), // both offline
      logger: noopLogger,
    };
    const res = handleApiSessions(makeReq('GET'), twoItemRepo);
    const r = res instanceof Promise ? await res : res;
    expect(r.status).toBe(200);
    const body = await json(r);
    const sessions = body.sessions as Array<Record<string, unknown>>;
    expect(sessions[0].connected).toBe(false);
    expect(sessions[1].connected).toBe(false);
  });

  it('GET → sessions include connected:true for live sessions', async () => {
    const twoItemRepo = {
      sessRepo: twoItemSessRepo,
      sessionRegistry: makeRegistry({ 'sess-1': true }), // sess-1 online
      logger: noopLogger,
    };
    const res = handleApiSessions(makeReq('GET'), twoItemRepo);
    const r = res instanceof Promise ? await res : res;
    expect(r.status).toBe(200);
    const body = await json(r);
    const sessions = body.sessions as Array<Record<string, unknown>>;
    expect(sessions[0].connected).toBe(true);  // sess-1
    expect(sessions[1].connected).toBe(false); // sess-2
  });

  it('POST → 405 method not allowed', async () => {
    const res = handleApiSessions(makeReq('POST'), emptyRepo);
    const r = res instanceof Promise ? await res : res;
    expect(r.status).toBe(405);
    const body = await json(r);
    expect(body).toEqual({ ok: false, error: 'method not allowed' });
  });

  it('returns 500 when repo throws', async () => {
    const errors: Array<[string, Record<string, unknown>]> = [];
    const errorLogger: Logger = {
      ...noopLogger,
      error: (msg, fields) => { errors.push([msg, fields ?? {}]); },
    };

    const throwingRepo = {
      sessRepo: {
        upsert: () => {},
        findById: () => null,
        findAll: (): never[] => { throw new Error('DB exploded'); },
        updateLastReadAt: () => {},
        delete: () => false,
      } satisfies SessionRepo,
      sessionRegistry: makeRegistry(),
      logger: errorLogger,
    };

    const res = handleApiSessions(makeReq('GET'), throwingRepo);
    const r = res instanceof Promise ? await res : res;
    expect(r.status).toBe(500);
    const body = await json(r);
    expect(body).toEqual({ ok: false, error: 'internal error' });
    expect(errors.length).toBe(1);
    expect(errors[0]![0]).toBe('sessions_list_failed');
  });
});

// ── DELETE /api/sessions/:id tests ────────────────────────────────────────────

function makeDeleteDeps(overrides: {
  findById?: () => ReturnType<SessionRepo['findById']>;
  deleteFn?: () => boolean;
  deleteBySession?: () => void;
  broadcasts?: BroadcastPayload[];
  has?: () => boolean;
} = {}) {
  const broadcasts = overrides.broadcasts ?? [];
  const hub: Hub = {
    add: () => {},
    tryAdd: () => ({ ok: true as const }),
    remove: () => {},
    broadcast: (p: BroadcastPayload) => { broadcasts.push(p); },
    get size() { return 0; },
  };

  const sessRepo: SessionRepo = {
    upsert: () => {},
    findById: overrides.findById ?? (() => ({
      id: 'sess-del',
      name: 'Delete Me',
      first_seen_at: 100,
      last_seen_at: 200,
      status: 'active' as const,
      last_read_at: 0,
    })),
    findAll: () => [],
    updateLastReadAt: () => {},
    delete: overrides.deleteFn ?? (() => true),
  };

  const msgRepo: MessageRepo = {
    insert: () => {},
    findBySession: () => [],
    findBySessionPage: () => ({ messages: [], has_more: false }),
    findById: () => null,
    deleteBySession: overrides.deleteBySession ?? (() => {}),
  };

  const sessionRegistry: SessionRegistry = {
    register: mock(() => ({ [Symbol.dispose]: () => {} })),
    tryRegister: mock(() => ({ ok: true as const, disposable: { [Symbol.dispose]: () => {} } })),
    send: mock(() => ({ ok: true as const })),
    unregister: mock(() => {}),
    has: overrides.has ?? (() => false),
    get size() { return 0; },
  };

  return { sessRepo, msgRepo, sessionRegistry, hub, logger: noopLogger, broadcasts };
}

describe('handleApiSessionDelete', () => {
  it('DELETE existing session → 200 { ok: true }', async () => {
    const deps = makeDeleteDeps();
    const req = new Request('http://localhost/api/sessions/sess-del', { method: 'DELETE' });
    const res = await handleApiSessionDelete(req, 'sess-del', deps);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it('DELETE non-existent session → 404', async () => {
    const deps = makeDeleteDeps({ findById: () => null });
    const req = new Request('http://localhost/api/sessions/sess-nope', { method: 'DELETE' });
    const res = await handleApiSessionDelete(req, 'sess-nope', deps);
    expect(res.status).toBe(404);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(false);
  });

  it('DELETE → broadcasts {type:"session_deleted", session_id}', async () => {
    const broadcasts: BroadcastPayload[] = [];
    const deps = makeDeleteDeps({ broadcasts });
    const req = new Request('http://localhost/api/sessions/sess-del', { method: 'DELETE' });
    await handleApiSessionDelete(req, 'sess-del', deps);

    const deletedEvents = broadcasts.filter((b) => b.type === 'session_deleted');
    expect(deletedEvents).toHaveLength(1);
    expect((deletedEvents[0] as { type: 'session_deleted'; session_id: string }).session_id).toBe('sess-del');
  });

  it('DELETE → msgRepo.deleteBySession called before sessRepo.delete', async () => {
    const callOrder: string[] = [];
    const deps = makeDeleteDeps({
      deleteBySession: () => { callOrder.push('deleteBySession'); },
      deleteFn: () => { callOrder.push('sessDelete'); return true; },
    });
    const req = new Request('http://localhost/api/sessions/sess-del', { method: 'DELETE' });
    await handleApiSessionDelete(req, 'sess-del', deps);

    expect(callOrder).toEqual(['deleteBySession', 'sessDelete']);
  });

  it('GET /api/sessions/:id → 405 (only DELETE allowed)', async () => {
    const deps = makeDeleteDeps();
    const req = new Request('http://localhost/api/sessions/sess-del', { method: 'GET' });
    const res = await handleApiSessionDelete(req, 'sess-del', deps);
    expect(res.status).toBe(405);
  });
});
