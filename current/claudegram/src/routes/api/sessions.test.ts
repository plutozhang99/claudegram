import { describe, it, expect, mock } from 'bun:test';
import type { SessionRepo, MessageRepo, Session } from '../../repo/types.js';
import type { SessionRegistry } from '../../ws/session-registry.js';
import type { Hub, BroadcastPayload } from '../../ws/hub.js';
import type { Logger } from '../../logger.js';
import { handleApiSessions, handleApiSessionDelete, handleApiSessionPatch } from './sessions.js';

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
    closeBySession: mock(() => {}),
    has: (id: string) => connected[id] === true,
    get size() { return Object.values(connected).filter(Boolean).length; },
  };
}

const noopMsgRepo = {
  insert: () => {},
  findBySession: () => [],
  findBySessionPage: () => ({ messages: [], has_more: false }),
  findById: () => null,
  deleteBySession: () => {},
};
const noopHub = {
  tryAdd: () => ({ ok: true as const }),
  add: () => {},
  remove: () => {},
  broadcast: () => {},
  get size() { return 0; },
};

const emptyRepo = {
  sessRepo: {
    upsert: () => {},
    findById: () => null,
    findAll: () => [],
    updateLastReadAt: () => {},
    delete: () => false,
    rename: () => false,
  } satisfies SessionRepo,
  sessionRegistry: makeRegistry(),
  logger: noopLogger,
  msgRepo: noopMsgRepo as unknown as import('../../repo/types.js').MessageRepo,
  hub: noopHub as unknown as import('../../ws/hub.js').Hub,
};

const twoItemSessRepo: SessionRepo = {
  upsert: () => {},
  findById: () => null,
  rename: () => true,
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
      msgRepo: noopMsgRepo as unknown as import('../../repo/types.js').MessageRepo,
      hub: noopHub as unknown as import('../../ws/hub.js').Hub,
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
      msgRepo: noopMsgRepo as unknown as import('../../repo/types.js').MessageRepo,
      hub: noopHub as unknown as import('../../ws/hub.js').Hub,
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
      msgRepo: noopMsgRepo as unknown as import('../../repo/types.js').MessageRepo,
      hub: noopHub as unknown as import('../../ws/hub.js').Hub,
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
        rename: () => false,
      } satisfies SessionRepo,
      sessionRegistry: makeRegistry(),
      logger: errorLogger,
      msgRepo: noopMsgRepo as unknown as import('../../repo/types.js').MessageRepo,
      hub: noopHub as unknown as import('../../ws/hub.js').Hub,
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
    rename: () => true,
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
    closeBySession: mock(() => {}),
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

  it('DELETE → closeBySession invoked with (id, 1000, "session_deleted")', async () => {
    const deps = makeDeleteDeps();
    const closeBy = deps.sessionRegistry.closeBySession as ReturnType<typeof mock>;
    const req = new Request('http://localhost/api/sessions/sess-del', { method: 'DELETE' });
    await handleApiSessionDelete(req, 'sess-del', deps);

    expect(closeBy).toHaveBeenCalledTimes(1);
    expect(closeBy.mock.calls[0]).toEqual(['sess-del', 1000, 'session_deleted']);
  });
});

describe('handleApiSessions bulk DELETE (?offline=true)', () => {
  const threeItemRepoRows: Session[] = [
    { id: 'online-1', name: 'Online A', first_seen_at: 1, last_seen_at: 2, status: 'active', last_read_at: 0 },
    { id: 'offline-1', name: 'Offline A', first_seen_at: 3, last_seen_at: 4, status: 'active', last_read_at: 0 },
    { id: 'offline-2', name: 'Offline B', first_seen_at: 5, last_seen_at: 6, status: 'active', last_read_at: 0 },
  ];

  function makeBulkDeps() {
    const deletedRows: string[] = [];
    const deletedMessages: string[] = [];
    const broadcasts: BroadcastPayload[] = [];
    const deps = {
      sessRepo: {
        upsert: () => {},
        findById: () => null,
        findAll: () => threeItemRepoRows,
        updateLastReadAt: () => {},
        delete: (id: string) => { deletedRows.push(id); return true; },
        rename: () => false,
      } as unknown as SessionRepo,
      sessionRegistry: makeRegistry({ 'online-1': true }),
      msgRepo: {
        insert: () => {},
        findBySession: () => [],
        findBySessionPage: () => ({ messages: [], has_more: false }),
        findById: () => null,
        deleteBySession: (id: string) => { deletedMessages.push(id); },
      } as unknown as import('../../repo/types.js').MessageRepo,
      hub: {
        tryAdd: () => ({ ok: true as const }),
        add: () => {},
        remove: () => {},
        broadcast: (p: BroadcastPayload) => { broadcasts.push(p); },
        get size() { return 0; },
      } as unknown as import('../../ws/hub.js').Hub,
      logger: noopLogger,
    };
    return { deps, deletedRows, deletedMessages, broadcasts };
  }

  it('DELETE /api/sessions?offline=true → deletes only offline sessions; online ones stay', async () => {
    const { deps, deletedRows } = makeBulkDeps();
    const req = new Request('http://localhost/api/sessions?offline=true', { method: 'DELETE' });
    const res = handleApiSessions(req, deps);
    const r = res instanceof Promise ? await res : res;
    expect(r.status).toBe(200);
    const body = await json(r);
    expect(body.ok).toBe(true);
    expect((body.deleted as string[]).sort()).toEqual(['offline-1', 'offline-2']);
    expect(deletedRows.sort()).toEqual(['offline-1', 'offline-2']);
  });

  it('DELETE /api/sessions?offline=true → broadcasts session_deleted per removed row', async () => {
    const { deps, broadcasts } = makeBulkDeps();
    const req = new Request('http://localhost/api/sessions?offline=true', { method: 'DELETE' });
    const res = handleApiSessions(req, deps);
    await (res instanceof Promise ? res : Promise.resolve(res));

    const deletedEvents = broadcasts.filter((b) => b.type === 'session_deleted');
    expect(deletedEvents).toHaveLength(2);
    const ids = deletedEvents.map((e) => (e as { type: 'session_deleted'; session_id: string }).session_id).sort();
    expect(ids).toEqual(['offline-1', 'offline-2']);
  });

  it('DELETE /api/sessions without ?offline=true → 400 (unscoped bulk delete refused)', async () => {
    const { deps } = makeBulkDeps();
    const req = new Request('http://localhost/api/sessions', { method: 'DELETE' });
    const res = handleApiSessions(req, deps);
    const r = res instanceof Promise ? await res : res;
    expect(r.status).toBe(400);
  });
});

// ── PATCH /api/sessions/:id (rename) tests ────────────────────────────────────

const existingSession = {
  id: 'sess-patch',
  name: 'Original Name',
  first_seen_at: 100,
  last_seen_at: 200,
  status: 'active' as const,
  last_read_at: 0,
};

function makePatchDeps(overrides: {
  findById?: () => ReturnType<SessionRepo['findById']>;
  renameFn?: () => boolean;
  broadcasts?: BroadcastPayload[];
  connected?: Record<string, boolean>;
} = {}) {
  const broadcasts = overrides.broadcasts ?? [];
  const hub: Hub = {
    add: () => {},
    tryAdd: () => ({ ok: true as const }),
    remove: () => {},
    broadcast: (p: BroadcastPayload) => { broadcasts.push(p); },
    get size() { return 0; },
  };

  // By default: first call returns existing session (existence check),
  // second call returns updated session (post-rename fetch).
  let callCount = 0;
  const defaultFindById = () => {
    callCount++;
    if (callCount === 1) return existingSession;
    return { ...existingSession, name: 'New Name' };
  };

  const sessRepo: SessionRepo = {
    upsert: () => {},
    findById: overrides.findById ?? defaultFindById,
    findAll: () => [],
    updateLastReadAt: () => {},
    delete: () => false,
    rename: overrides.renameFn ?? (() => true),
  };

  const sessionRegistry = makeRegistry(overrides.connected ?? {});

  return { sessRepo, hub, sessionRegistry, logger: noopLogger, broadcasts };
}

function makePatchReq(id: string, body: unknown): Request {
  return new Request(`http://localhost/api/sessions/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('handleApiSessionPatch', () => {
  it('PATCH existing session with valid name → 200 with updated session', async () => {
    const deps = makePatchDeps();
    const req = makePatchReq('sess-patch', { name: 'New Name' });
    const res = await handleApiSessionPatch(req, 'sess-patch', deps);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; session: { name: string } };
    expect(body.ok).toBe(true);
    expect(body.session.name).toBe('New Name');
  });

  it('PATCH unknown session → 404', async () => {
    const deps = makePatchDeps({ findById: () => null });
    const req = makePatchReq('no-such-session', { name: 'Whatever' });
    const res = await handleApiSessionPatch(req, 'no-such-session', deps);
    expect(res.status).toBe(404);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(false);
  });

  it('PATCH with empty name string → 400 (validation failed)', async () => {
    const deps = makePatchDeps();
    const req = makePatchReq('sess-patch', { name: '' });
    const res = await handleApiSessionPatch(req, 'sess-patch', deps);
    expect(res.status).toBe(400);
    const body = await res.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe('validation failed');
  });

  it('PATCH with name exceeding 200 chars → 400 (validation failed)', async () => {
    const deps = makePatchDeps();
    const longName = 'a'.repeat(201);
    const req = makePatchReq('sess-patch', { name: longName });
    const res = await handleApiSessionPatch(req, 'sess-patch', deps);
    expect(res.status).toBe(400);
    const body = await res.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe('validation failed');
  });

  it('PATCH with missing name field → 400 (validation failed)', async () => {
    const deps = makePatchDeps();
    const req = makePatchReq('sess-patch', { notName: 'oops' });
    const res = await handleApiSessionPatch(req, 'sess-patch', deps);
    expect(res.status).toBe(400);
    const body = await res.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe('validation failed');
  });

  it('PATCH with invalid JSON → 400', async () => {
    const deps = makePatchDeps();
    const req = new Request('http://localhost/api/sessions/sess-patch', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: 'not json {{{',
    });
    const res = await handleApiSessionPatch(req, 'sess-patch', deps);
    expect(res.status).toBe(400);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(false);
  });

  it('PATCH → broadcasts {type:"session_update", session} with updated name', async () => {
    const broadcasts: BroadcastPayload[] = [];
    const deps = makePatchDeps({ broadcasts });
    const req = makePatchReq('sess-patch', { name: 'New Name' });
    await handleApiSessionPatch(req, 'sess-patch', deps);
    const updateEvents = broadcasts.filter((b) => b.type === 'session_update');
    expect(updateEvents).toHaveLength(1);
    const evt = updateEvents[0] as { type: 'session_update'; session: { name: string } };
    expect(evt.session.name).toBe('New Name');
  });

  it('PATCH → session in response includes connected:true when session is live', async () => {
    const deps = makePatchDeps({ connected: { 'sess-patch': true } });
    const req = makePatchReq('sess-patch', { name: 'New Name' });
    const res = await handleApiSessionPatch(req, 'sess-patch', deps);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; session: { connected: boolean } };
    expect(body.session.connected).toBe(true);
  });

  it('GET to PATCH endpoint → 405', async () => {
    const deps = makePatchDeps();
    const req = new Request('http://localhost/api/sessions/sess-patch', { method: 'GET' });
    const res = await handleApiSessionPatch(req, 'sess-patch', deps);
    expect(res.status).toBe(405);
  });
});
