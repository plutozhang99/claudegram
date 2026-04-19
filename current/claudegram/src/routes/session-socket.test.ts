import { describe, it, expect } from 'bun:test';
import type { ServerWebSocket } from 'bun';
import type { Logger } from '../logger.js';
import type { Config } from '../config.js';
import type { SessionRepo } from '../repo/types.js';
import type { SessionRegistry } from '../ws/session-registry.js';
import type { SendResult as RegistrySendResult } from '../ws/session-registry.js';
import type { Hub, BroadcastPayload } from '../ws/hub.js';
import {
  checkSessionSocketAuth,
  sendWithBackpressure,
  handleSessionSocketOpen,
  handleSessionSocketMessage,
  handleSessionSocketClose,
} from './session-socket.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 8788,
    db_path: './data/test.db',
    log_level: 'info',
    trustCfAccess: false,
    wsOutboundBufferCapBytes: 1_048_576,
    wsInboundMaxBadFrames: 5,
    maxPwaConnections: 256,
    maxSessionConnections: 64,
    ...overrides,
  };
}

interface StubWsOptions {
  bufferedAmount?: number;
  onSend?: (data: string) => void;
  onClose?: (code: number, reason: string) => void;
}

function makeStubWs(opts: StubWsOptions = {}): ServerWebSocket<unknown> {
  const _bufferedAmount = opts.bufferedAmount ?? 0;
  return {
    getBufferedAmount: () => _bufferedAmount,
    send: (data: string | ArrayBufferLike | ArrayBufferView) => {
      opts.onSend?.(data as string);
      return 0;
    },
    close: (code?: number, reason?: string) => {
      opts.onClose?.(code ?? 1000, reason ?? '');
    },
    data: undefined,
    readyState: 1,
    remoteAddress: '127.0.0.1',
    terminate: () => {},
    ping: () => 0,
    pong: () => 0,
    cork: (cb: () => void) => { cb(); return 0; },
    subscribe: () => {},
    unsubscribe: () => {},
    isSubscribed: () => false,
    publish: () => 0,
    binaryType: 'nodebuffer',
  } as unknown as ServerWebSocket<unknown>;
}

function makeSessionRepo(overrides: Partial<SessionRepo> = {}): SessionRepo {
  return {
    upsert: () => {},
    findById: () => null,
    findAll: () => [],
    updateLastReadAt: () => {},
    delete: () => false,
    rename: () => false,
    ...overrides,
  };
}

function makeSessionRegistry(overrides: Partial<SessionRegistry> = {}): SessionRegistry {
  let _size = 0;
  const _registered = new Set<string>();
  return {
    register: (_id: string, _ws: ServerWebSocket<unknown>): Disposable => {
      _size++;
      _registered.add(_id);
      return {
        [Symbol.dispose]: () => { _size = Math.max(0, _size - 1); _registered.delete(_id); },
      };
    },
    tryRegister: (_id: string, _ws: ServerWebSocket<unknown>) => {
      _size++;
      _registered.add(_id);
      return {
        ok: true as const,
        disposable: {
          [Symbol.dispose]: () => { _size = Math.max(0, _size - 1); _registered.delete(_id); },
        },
      };
    },
    unregister: (_id: string) => { _size = Math.max(0, _size - 1); _registered.delete(_id); },
    closeBySession: (_id: string) => { _size = Math.max(0, _size - 1); _registered.delete(_id); },
    send: (_id: string, _payload: Parameters<SessionRegistry['send']>[1]): RegistrySendResult => ({ ok: true }),
    has: (_id: string) => _registered.has(_id),
    get size() { return _size; },
    ...overrides,
  };
}

function makeHub(broadcasts: BroadcastPayload[] = []): Hub {
  return {
    add: () => {},
    tryAdd: () => ({ ok: true as const }),
    remove: () => {},
    broadcast: (payload: BroadcastPayload) => { broadcasts.push(payload); },
    get size() { return 0; },
  };
}

function makeUpgradeRequest(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/session-socket', {
    headers: {
      upgrade: 'websocket',
      ...headers,
    },
  });
}

// ── Auth gate tests ───────────────────────────────────────────────────────────

describe('checkSessionSocketAuth', () => {
  it('trustCfAccess=true + both headers present → returns null (allow)', () => {
    const req = makeUpgradeRequest({
      'Cf-Access-Client-Id': 'my-client-id',
      'Cf-Access-Client-Secret': 'my-client-secret',
    });
    const result = checkSessionSocketAuth(req, makeConfig({ trustCfAccess: true }));
    expect(result).toBeNull();
  });

  it('trustCfAccess=true + missing Cf-Access-Client-Id → 401', () => {
    const req = makeUpgradeRequest({
      'Cf-Access-Client-Secret': 'my-client-secret',
    });
    const result = checkSessionSocketAuth(req, makeConfig({ trustCfAccess: true }));
    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
  });

  it('trustCfAccess=true + missing Cf-Access-Client-Secret → 401', () => {
    const req = makeUpgradeRequest({
      'Cf-Access-Client-Id': 'my-client-id',
    });
    const result = checkSessionSocketAuth(req, makeConfig({ trustCfAccess: true }));
    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
  });

  it('trustCfAccess=true + empty Cf-Access-Client-Id → 401', () => {
    const req = makeUpgradeRequest({
      'Cf-Access-Client-Id': '',
      'Cf-Access-Client-Secret': 'my-client-secret',
    });
    const result = checkSessionSocketAuth(req, makeConfig({ trustCfAccess: true }));
    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
  });

  it('trustCfAccess=true + empty Cf-Access-Client-Secret → 401', () => {
    const req = makeUpgradeRequest({
      'Cf-Access-Client-Id': 'my-client-id',
      'Cf-Access-Client-Secret': '',
    });
    const result = checkSessionSocketAuth(req, makeConfig({ trustCfAccess: true }));
    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
  });

  it('trustCfAccess=false → returns null (allow) without headers', () => {
    const req = makeUpgradeRequest();
    const result = checkSessionSocketAuth(req, makeConfig({ trustCfAccess: false }));
    expect(result).toBeNull();
  });

  it('trustCfAccess=true + both headers missing → 401', () => {
    const req = makeUpgradeRequest();
    const result = checkSessionSocketAuth(req, makeConfig({ trustCfAccess: true }));
    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
  });
});

// ── sendWithBackpressure tests ────────────────────────────────────────────────

describe('sendWithBackpressure', () => {
  it('bufferedAmount <= cap → sends and returns { ok: true }', () => {
    const sent: string[] = [];
    const ws = makeStubWs({ bufferedAmount: 0, onSend: (d) => sent.push(d) });
    const result = sendWithBackpressure(ws, 'hello', 1_048_576);
    expect(result).toEqual({ ok: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toBe('hello');
  });

  it('bufferedAmount exactly at cap → sends (> not >=)', () => {
    const sent: string[] = [];
    const ws = makeStubWs({ bufferedAmount: 1_048_576, onSend: (d) => sent.push(d) });
    const result = sendWithBackpressure(ws, 'hello', 1_048_576);
    expect(result).toEqual({ ok: true });
    expect(sent).toHaveLength(1);
  });

  it('bufferedAmount > cap → returns { ok: false, reason: "buffer_full" } without sending', () => {
    const sent: string[] = [];
    const ws = makeStubWs({ bufferedAmount: 1_048_577, onSend: (d) => sent.push(d) });
    const result = sendWithBackpressure(ws, 'hello', 1_048_576);
    expect(result).toEqual({ ok: false, reason: 'buffer_full' });
    expect(sent).toHaveLength(0);
  });
});

// ── Register message handling tests ──────────────────────────────────────────

describe('handleSessionSocketMessage — register', () => {
  it('valid register → sessRepo.upsert called + sessionRegistry.tryRegister called', () => {
    const upsertCalls: Array<{ id: string; name: string }> = [];
    const tryRegisterCalls: string[] = [];

    const sessRepo = makeSessionRepo({
      upsert: (s) => { upsertCalls.push({ id: s.id, name: s.name }); },
    });
    const sessionRegistry = makeSessionRegistry({
      tryRegister: (id, _ws) => {
        tryRegisterCalls.push(id);
        return {
          ok: true as const,
          disposable: { [Symbol.dispose]: () => {} },
        };
      },
    });

    const ws = makeStubWs();
    const deps = {
      config: makeConfig(),
      sessRepo,
      sessionRegistry,
      hub: makeHub(),
      logger: noopLogger,
    };

    handleSessionSocketOpen(ws, deps);
    handleSessionSocketMessage(
      ws,
      JSON.stringify({ type: 'register', channels: ['plugin:fakechat@claude-plugins-official'], session_id: 'sess-abc' }),
      deps,
    );

    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0]!.id).toBe('sess-abc');
    expect(upsertCalls[0]!.name).toBe('sess-abc'); // defaults to session_id
    expect(tryRegisterCalls).toHaveLength(1);
    expect(tryRegisterCalls[0]).toBe('sess-abc');
  });

  it('valid register with session_name → upsert uses provided name', () => {
    const upsertCalls: Array<{ id: string; name: string }> = [];
    const sessRepo = makeSessionRepo({
      upsert: (s) => { upsertCalls.push({ id: s.id, name: s.name }); },
    });

    const ws = makeStubWs();
    const deps = {
      config: makeConfig(),
      sessRepo,
      sessionRegistry: makeSessionRegistry(),
      hub: makeHub(),
      logger: noopLogger,
    };

    handleSessionSocketOpen(ws, deps);
    handleSessionSocketMessage(
      ws,
      JSON.stringify({ type: 'register', channels: ['plugin:fakechat@claude-plugins-official'], session_id: 'sess-xyz', session_name: 'My Session' }),
      deps,
    );

    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0]!.name).toBe('My Session');
  });

  it('malformed JSON → sends error frame, no registry call', () => {
    const sent: string[] = [];
    const tryRegisterCalls: string[] = [];

    const ws = makeStubWs({ onSend: (d) => sent.push(d) });
    const sessionRegistry = makeSessionRegistry({
      tryRegister: (id, _ws) => { tryRegisterCalls.push(id); return { ok: true as const, disposable: { [Symbol.dispose]: () => {} } }; },
    });

    const deps = {
      config: makeConfig(),
      sessRepo: makeSessionRepo(),
      sessionRegistry,
      hub: makeHub(),
      logger: noopLogger,
    };

    handleSessionSocketOpen(ws, deps);
    handleSessionSocketMessage(ws, 'not-valid-json{{{', deps);

    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]!)).toEqual({ type: 'error', reason: 'invalid_payload' });
    expect(tryRegisterCalls).toHaveLength(0);
  });

  it('register frame with missing session_id → sends error frame, no registry call', () => {
    const sent: string[] = [];
    const tryRegisterCalls: string[] = [];

    const ws = makeStubWs({ onSend: (d) => sent.push(d) });
    const sessionRegistry = makeSessionRegistry({
      tryRegister: (id, _ws) => { tryRegisterCalls.push(id); return { ok: true as const, disposable: { [Symbol.dispose]: () => {} } }; },
    });

    const deps = {
      config: makeConfig(),
      sessRepo: makeSessionRepo(),
      sessionRegistry,
      hub: makeHub(),
      logger: noopLogger,
    };

    handleSessionSocketOpen(ws, deps);
    handleSessionSocketMessage(
      ws,
      JSON.stringify({ type: 'register' }), // missing session_id
      deps,
    );

    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]!)).toEqual({ type: 'error', reason: 'invalid_payload' });
    expect(tryRegisterCalls).toHaveLength(0);
  });

  it('register frame with empty session_id → sends error frame, no registry call', () => {
    const sent: string[] = [];
    const tryRegisterCalls: string[] = [];

    const ws = makeStubWs({ onSend: (d) => sent.push(d) });
    const sessionRegistry = makeSessionRegistry({
      tryRegister: (id, _ws) => { tryRegisterCalls.push(id); return { ok: true as const, disposable: { [Symbol.dispose]: () => {} } }; },
    });

    const deps = {
      config: makeConfig(),
      sessRepo: makeSessionRepo(),
      sessionRegistry,
      hub: makeHub(),
      logger: noopLogger,
    };

    handleSessionSocketOpen(ws, deps);
    handleSessionSocketMessage(
      ws,
      JSON.stringify({ type: 'register', channels: ['plugin:fakechat@claude-plugins-official'], session_id: '' }),
      deps,
    );

    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]!)).toEqual({ type: 'error', reason: 'invalid_payload' });
    expect(tryRegisterCalls).toHaveLength(0);
  });

  it('unknown frame type → debug-logged and dropped (no error frame, no registry call)', () => {
    const sent: string[] = [];
    const debugCalls: string[] = [];
    const tryRegisterCalls: string[] = [];

    const ws = makeStubWs({ onSend: (d) => sent.push(d) });
    const sessionRegistry = makeSessionRegistry({
      tryRegister: (id, _ws) => { tryRegisterCalls.push(id); return { ok: true as const, disposable: { [Symbol.dispose]: () => {} } }; },
    });
    const logger: Logger = {
      ...noopLogger,
      debug: (msg) => debugCalls.push(msg),
    };

    const deps = {
      config: makeConfig(),
      sessRepo: makeSessionRepo(),
      sessionRegistry,
      hub: makeHub(),
      logger,
    };

    handleSessionSocketOpen(ws, deps);
    handleSessionSocketMessage(ws, JSON.stringify({ type: 'ping' }), deps);

    expect(sent).toHaveLength(0);
    expect(tryRegisterCalls).toHaveLength(0);
    expect(debugCalls).toContain('session_socket_unknown_frame');
  });

  it('pong frame → no broadcast / no upsert / no error frame / no bad-frame bump', () => {
    const sent: string[] = [];
    const broadcasts: BroadcastPayload[] = [];
    const upsertCalls: string[] = [];
    const tryRegisterCalls: string[] = [];

    const ws = makeStubWs({ onSend: (d) => sent.push(d) });
    const sessRepo = makeSessionRepo({
      upsert: (s) => { upsertCalls.push(s.id); },
    });
    const sessionRegistry = makeSessionRegistry({
      tryRegister: (id, _ws) => { tryRegisterCalls.push(id); return { ok: true as const, disposable: { [Symbol.dispose]: () => {} } }; },
    });
    const hub = makeHub(broadcasts);

    const deps = {
      config: makeConfig(),
      sessRepo,
      sessionRegistry,
      hub,
      logger: noopLogger,
    };

    handleSessionSocketOpen(ws, deps);
    // A pong frame lands before any register frame — must be silently accepted
    // as a heartbeat response and NOT routed to session-upsert / registry.
    handleSessionSocketMessage(ws, JSON.stringify({ type: 'pong' }), deps);

    expect(sent).toHaveLength(0);
    expect(upsertCalls).toHaveLength(0);
    expect(tryRegisterCalls).toHaveLength(0);
    expect(broadcasts).toHaveLength(0);
  });

  // HIGH 3 test: upsert throws → error frame carries reason: 'internal_error'
  it('sessRepo.upsert throws → sends error frame with reason: internal_error, no registry call', () => {
    const sent: string[] = [];
    const tryRegisterCalls: string[] = [];

    const sessRepo = makeSessionRepo({
      upsert: () => { throw new Error('DB write failed'); },
    });
    const sessionRegistry = makeSessionRegistry({
      tryRegister: (id, _ws) => { tryRegisterCalls.push(id); return { ok: true as const, disposable: { [Symbol.dispose]: () => {} } }; },
    });

    const ws = makeStubWs({ onSend: (d) => sent.push(d) });
    const deps = {
      config: makeConfig(),
      sessRepo,
      sessionRegistry,
      hub: makeHub(),
      logger: noopLogger,
    };

    handleSessionSocketOpen(ws, deps);
    handleSessionSocketMessage(
      ws,
      JSON.stringify({ type: 'register', channels: ['plugin:fakechat@claude-plugins-official'], session_id: 'sess-fail' }),
      deps,
    );

    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]!)).toEqual({ type: 'error', reason: 'internal_error' });
    expect(tryRegisterCalls).toHaveLength(0);
  });

  it('register frame WITHOUT channels field → schema rejects (invalid_payload), no upsert, no registry call', () => {
    const sent: string[] = [];
    const tryRegisterCalls: string[] = [];
    const upsertCalls: string[] = [];

    const sessRepo = makeSessionRepo({
      upsert: (s) => { upsertCalls.push(s.id); },
    });
    const sessionRegistry = makeSessionRegistry({
      tryRegister: (id, _ws) => { tryRegisterCalls.push(id); return { ok: true as const, disposable: { [Symbol.dispose]: () => {} } }; },
    });

    const ws = makeStubWs({ onSend: (d) => sent.push(d) });
    const deps = {
      config: makeConfig(),
      sessRepo,
      sessionRegistry,
      hub: makeHub(),
      logger: noopLogger,
    };

    handleSessionSocketOpen(ws, deps);
    // Old-client shape: no `channels` field. This is the exact payload shape
    // that pre-gating fakechat builds send, and must now be rejected BEFORE
    // upsert to prevent ghost sessions in the DB.
    handleSessionSocketMessage(
      ws,
      JSON.stringify({ type: 'register', session_id: 'sess-no-channels' }),
      deps,
    );

    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]!)).toEqual({ type: 'error', reason: 'invalid_payload' });
    expect(upsertCalls).toHaveLength(0);
    expect(tryRegisterCalls).toHaveLength(0);
  });

  it('register frame with channels but missing fakechat marker → rejected + ws.close(1008), no upsert', () => {
    const sent: string[] = [];
    const closedWith: Array<{ code: number; reason: string }> = [];
    const tryRegisterCalls: string[] = [];
    const upsertCalls: string[] = [];
    const warnCalls: string[] = [];

    const sessRepo = makeSessionRepo({
      upsert: (s) => { upsertCalls.push(s.id); },
    });
    const sessionRegistry = makeSessionRegistry({
      tryRegister: (id, _ws) => { tryRegisterCalls.push(id); return { ok: true as const, disposable: { [Symbol.dispose]: () => {} } }; },
    });
    const logger: Logger = {
      ...noopLogger,
      warn: (msg) => warnCalls.push(msg),
    };

    const ws = makeStubWs({
      onSend: (d) => sent.push(d),
      onClose: (code, reason) => closedWith.push({ code, reason }),
    });
    const deps = {
      config: makeConfig(),
      sessRepo,
      sessionRegistry,
      hub: makeHub(),
      logger,
    };

    handleSessionSocketOpen(ws, deps);
    handleSessionSocketMessage(
      ws,
      JSON.stringify({ type: 'register', channels: ['plugin:something-else'], session_id: 'sess-wrong-channel' }),
      deps,
    );

    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]!)).toEqual({ type: 'error', reason: 'invalid_payload' });
    expect(closedWith).toEqual([{ code: 1008, reason: 'no_fakechat_channel' }]);
    expect(upsertCalls).toHaveLength(0);
    expect(tryRegisterCalls).toHaveLength(0);
    expect(warnCalls).toContain('session_socket_register_rejected_no_fakechat_channel');
  });

  it('tryRegister returns cap_exceeded → sends error frame + closes ws with 1008', () => {
    const sent: string[] = [];
    const closedWith: Array<{ code: number; reason: string }> = [];

    const ws = makeStubWs({
      onSend: (d) => sent.push(d),
      onClose: (code, reason) => closedWith.push({ code, reason }),
    });
    const sessionRegistry = makeSessionRegistry({
      tryRegister: (_id, _ws) => ({ ok: false as const, reason: 'cap_exceeded' as const }),
    });

    const deps = {
      config: makeConfig(),
      sessRepo: makeSessionRepo(),
      sessionRegistry,
      hub: makeHub(),
      logger: noopLogger,
    };

    handleSessionSocketOpen(ws, deps);
    handleSessionSocketMessage(
      ws,
      JSON.stringify({ type: 'register', channels: ['plugin:fakechat@claude-plugins-official'], session_id: 'sess-over-cap' }),
      deps,
    );

    // Should have sent an error frame before closing.
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]!)).toEqual({ type: 'error', reason: 'internal_error' });
    // Should close with 1008.
    expect(closedWith).toHaveLength(1);
    expect(closedWith[0]!.code).toBe(1008);
    expect(closedWith[0]!.reason).toBe('cap_exceeded');
  });
});

// ── Close / cleanup tests ─────────────────────────────────────────────────────

describe('handleSessionSocketClose', () => {
  it('close after register → disposable is invoked (unregister called)', () => {
    let disposed = false;
    const sessionRegistry = makeSessionRegistry({
      tryRegister: (_id, _ws) => ({
        ok: true as const,
        disposable: { [Symbol.dispose]: () => { disposed = true; } },
      }),
    });

    const ws = makeStubWs();
    const deps = {
      config: makeConfig(),
      sessRepo: makeSessionRepo(),
      sessionRegistry,
      hub: makeHub(),
      logger: noopLogger,
    };

    handleSessionSocketOpen(ws, deps);
    handleSessionSocketMessage(
      ws,
      JSON.stringify({ type: 'register', channels: ['plugin:fakechat@claude-plugins-official'], session_id: 'sess-close-test' }),
      deps,
    );

    expect(disposed).toBe(false);
    handleSessionSocketClose(ws, { sessionRegistry, hub: makeHub(), sessRepo: makeSessionRepo(), logger: noopLogger });
    expect(disposed).toBe(true);
  });

  it('close without prior register → does not throw', () => {
    const ws = makeStubWs();
    const sessionRegistry = makeSessionRegistry();
    expect(() => handleSessionSocketClose(ws, { sessionRegistry, hub: makeHub(), sessRepo: makeSessionRepo(), logger: noopLogger })).not.toThrow();
  });

  it('duplicate close → idempotent, does not throw', () => {
    let disposeCount = 0;
    const sessionRegistry = makeSessionRegistry({
      tryRegister: (_id, _ws) => ({
        ok: true as const,
        disposable: { [Symbol.dispose]: () => { disposeCount++; } },
      }),
    });

    const ws = makeStubWs();
    const deps = {
      config: makeConfig(),
      sessRepo: makeSessionRepo(),
      sessionRegistry,
      hub: makeHub(),
      logger: noopLogger,
    };

    handleSessionSocketOpen(ws, deps);
    handleSessionSocketMessage(
      ws,
      JSON.stringify({ type: 'register', channels: ['plugin:fakechat@claude-plugins-official'], session_id: 'sess-dup-close' }),
      deps,
    );

    handleSessionSocketClose(ws, { sessionRegistry, hub: makeHub(), sessRepo: makeSessionRepo(), logger: noopLogger });
    expect(() => handleSessionSocketClose(ws, { sessionRegistry, hub: makeHub(), sessRepo: makeSessionRepo(), logger: noopLogger })).not.toThrow();
    // The Disposable is only invoked once because wsState is cleared on first close.
    expect(disposeCount).toBe(1);
  });

  it('dispose throws → WeakMap entries still cleaned up (no throw from close handler)', () => {
    const warnCalls: string[] = [];
    const logger: Logger = {
      ...noopLogger,
      warn: (msg) => warnCalls.push(msg),
    };

    const sessionRegistry = makeSessionRegistry({
      tryRegister: (_id, _ws) => ({
        ok: true as const,
        disposable: { [Symbol.dispose]: () => { throw new Error('dispose exploded'); } },
      }),
    });

    const ws = makeStubWs();
    const deps = {
      config: makeConfig(),
      sessRepo: makeSessionRepo(),
      sessionRegistry,
      hub: makeHub(),
      logger,
    };

    handleSessionSocketOpen(ws, deps);
    handleSessionSocketMessage(
      ws,
      JSON.stringify({ type: 'register', channels: ['plugin:fakechat@claude-plugins-official'], session_id: 'sess-dispose-throws' }),
      deps,
    );

    // close handler must NOT throw even if dispose() throws
    expect(() => handleSessionSocketClose(ws, { sessionRegistry, hub: makeHub(), sessRepo: makeSessionRepo(), logger })).not.toThrow();
    // warn should have been logged
    expect(warnCalls).toContain('session_socket_dispose_failed');

    // second close is idempotent (wsState was already cleaned up)
    expect(() => handleSessionSocketClose(ws, { sessionRegistry, hub: makeHub(), sessRepo: makeSessionRepo(), logger })).not.toThrow();
  });
});

// ── Duplicate register (rebind) test ──────────────────────────────────────────

describe('duplicate register', () => {
  it('second register on same session_id evicts via registry (tryRegister called twice)', () => {
    const tryRegisterCalls: string[] = [];
    const sessionRegistry = makeSessionRegistry({
      tryRegister: (id, _ws) => {
        tryRegisterCalls.push(id);
        return { ok: true as const, disposable: { [Symbol.dispose]: () => {} } };
      },
    });

    const ws1 = makeStubWs();
    const ws2 = makeStubWs();
    const deps = {
      config: makeConfig(),
      sessRepo: makeSessionRepo(),
      sessionRegistry,
      hub: makeHub(),
      logger: noopLogger,
    };

    handleSessionSocketOpen(ws1, deps);
    handleSessionSocketMessage(
      ws1,
      JSON.stringify({ type: 'register', channels: ['plugin:fakechat@claude-plugins-official'], session_id: 'sess-dup' }),
      deps,
    );

    handleSessionSocketOpen(ws2, deps);
    handleSessionSocketMessage(
      ws2,
      JSON.stringify({ type: 'register', channels: ['plugin:fakechat@claude-plugins-official'], session_id: 'sess-dup' }),
      deps,
    );

    // Registry.tryRegister called twice; it handles eviction internally.
    expect(tryRegisterCalls).toHaveLength(2);
    expect(tryRegisterCalls[0]).toBe('sess-dup');
    expect(tryRegisterCalls[1]).toBe('sess-dup');
  });
});

// ── Buffer cap test ───────────────────────────────────────────────────────────

describe('sendWithBackpressure — buffer_full', () => {
  it('bufferedAmount > cap → { ok: false, reason: "buffer_full" }', () => {
    const ws = makeStubWs({ bufferedAmount: 2_000_000 });
    const result = sendWithBackpressure(ws, '{}', 1_048_576);
    expect(result).toEqual({ ok: false, reason: 'buffer_full' });
  });
});

// ── FIX 2/3/4: connected-state broadcast ─────────────────────────────────────

describe('FIX 2/3 — session_socket broadcasts connected:true on register', () => {
  it('successful register → hub.broadcast called with {type:"session_update", session:{...connected:true}}', () => {
    const broadcasts: BroadcastPayload[] = [];
    const hub = makeHub(broadcasts);

    const session = {
      id: 'sess-bc',
      name: 'Broadcast Session',
      first_seen_at: 1000,
      last_seen_at: 2000,
      status: 'active' as const,
      last_read_at: 0,
    };
    const sessRepo = makeSessionRepo({
      findById: (id: string) => id === 'sess-bc' ? session : null,
    });

    const ws = makeStubWs();
    const deps = {
      config: makeConfig(),
      sessRepo,
      sessionRegistry: makeSessionRegistry(),
      hub,
      logger: noopLogger,
    };

    handleSessionSocketOpen(ws, deps);
    handleSessionSocketMessage(
      ws,
      JSON.stringify({ type: 'register', channels: ['plugin:fakechat@claude-plugins-official'], session_id: 'sess-bc' }),
      deps,
    );

    const sessionUpdateBroadcasts = broadcasts.filter((b) => b.type === 'session_update');
    expect(sessionUpdateBroadcasts).toHaveLength(1);
    const payload = sessionUpdateBroadcasts[0] as unknown as { type: 'session_update'; session: Record<string, unknown> };
    expect(payload.session.id).toBe('sess-bc');
    expect(payload.session.connected).toBe(true);
  });
});

describe('FIX 4 — session_socket broadcasts connected:false on close', () => {
  it('close after register → hub.broadcast called with {type:"session_update", session:{...connected:false}}', () => {
    const session = {
      id: 'sess-close-bc',
      name: 'Close Broadcast Session',
      first_seen_at: 1000,
      last_seen_at: 2000,
      status: 'active' as const,
      last_read_at: 0,
    };
    const sessRepo = makeSessionRepo({
      findById: (id: string) => id === 'sess-close-bc' ? session : null,
    });

    const broadcasts: BroadcastPayload[] = [];
    const hub = makeHub(broadcasts);

    const ws = makeStubWs();
    const deps = {
      config: makeConfig(),
      sessRepo,
      sessionRegistry: makeSessionRegistry(),
      hub,
      logger: noopLogger,
    };

    handleSessionSocketOpen(ws, deps);
    handleSessionSocketMessage(
      ws,
      JSON.stringify({ type: 'register', channels: ['plugin:fakechat@claude-plugins-official'], session_id: 'sess-close-bc' }),
      deps,
    );

    // Clear broadcasts from register phase, then close.
    broadcasts.length = 0;
    handleSessionSocketClose(ws, { sessionRegistry: makeSessionRegistry(), hub, sessRepo, logger: noopLogger });

    const sessionUpdateBroadcasts = broadcasts.filter((b) => b.type === 'session_update');
    expect(sessionUpdateBroadcasts).toHaveLength(1);
    const payload = sessionUpdateBroadcasts[0] as unknown as { type: 'session_update'; session: Record<string, unknown> };
    expect(payload.session.id).toBe('sess-close-bc');
    expect(payload.session.connected).toBe(false);
  });
});
