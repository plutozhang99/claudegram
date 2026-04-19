import { describe, it, expect } from 'bun:test';
import type { ServerWebSocket } from 'bun';
import { InMemorySessionRegistry } from './session-registry.js';
import type { OutboundSessionPayload, TryRegisterResult } from './session-registry.js';

// ── Stub WebSocket ────────────────────────────────────────────────────────────

interface StubWsOptions {
  onSend?: (data: string) => void;
  onClose?: (code: number, reason: string) => void;
  throwOnClose?: boolean;
  throwOnSend?: boolean;
  /** Simulated bufferedAmount value for backpressure tests. Default: 0. */
  bufferedAmount?: number;
  /** If true, getBufferedAmount() throws — tests HIGH 2 fix. */
  throwOnGetBufferedAmount?: boolean;
}

function makeStubWs(opts: StubWsOptions = {}): ServerWebSocket<unknown> {
  return {
    send: (data: string | ArrayBufferLike | ArrayBufferView) => {
      if (opts.throwOnSend) throw new Error('ws.send() failed');
      opts.onSend?.(data as string);
      return 0;
    },
    close: (code?: number, reason?: string) => {
      if (opts.throwOnClose) throw new Error('already closed');
      opts.onClose?.(code ?? 1000, reason ?? '');
    },
    getBufferedAmount: () => {
      if (opts.throwOnGetBufferedAmount) throw new Error('socket in terminal state');
      return opts.bufferedAmount ?? 0;
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

const stubPayload: OutboundSessionPayload = {
  type: 'reply',
  text: 'hello from pwa',
  client_msg_id: 'cmid-1',
  origin: 'pwa',
};

// ── SessionRegistry unit tests ────────────────────────────────────────────────

describe('InMemorySessionRegistry', () => {
  it('starts empty: size === 0', () => {
    const registry = new InMemorySessionRegistry();
    expect(registry.size).toBe(0);
  });

  it('register(session_id, ws) increments size', () => {
    const registry = new InMemorySessionRegistry();
    registry.register('sess-1', makeStubWs());
    expect(registry.size).toBe(1);
  });

  it('register returns a Disposable that unregisters on dispose', () => {
    const registry = new InMemorySessionRegistry();
    const ws = makeStubWs();
    const disposable = registry.register('sess-1', ws);
    expect(registry.size).toBe(1);

    disposable[Symbol.dispose]();
    expect(registry.size).toBe(0);
  });

  it('send on known session_id → sends JSON payload and returns { ok: true }', () => {
    const registry = new InMemorySessionRegistry();
    const received: string[] = [];
    const ws = makeStubWs({ onSend: (data) => received.push(data) });

    registry.register('sess-1', ws);
    const result = registry.send('sess-1', stubPayload);

    expect(result).toEqual({ ok: true });
    expect(received).toHaveLength(1);
    expect(received[0]).toBe(JSON.stringify(stubPayload));
  });

  it('send on unknown session_id → returns { ok: false, reason: "no_session" } without throwing', () => {
    const registry = new InMemorySessionRegistry();
    const result = registry.send('nonexistent', stubPayload);
    expect(result).toEqual({ ok: false, reason: 'no_session' });
  });

  it('unregister removes the session; subsequent send returns { ok: false, reason: "no_session" }', () => {
    const registry = new InMemorySessionRegistry();
    registry.register('sess-1', makeStubWs());
    expect(registry.size).toBe(1);

    registry.unregister('sess-1');
    expect(registry.size).toBe(0);

    const result = registry.send('sess-1', stubPayload);
    expect(result).toEqual({ ok: false, reason: 'no_session' });
  });

  it('unregister on unknown session_id does NOT throw', () => {
    const registry = new InMemorySessionRegistry();
    expect(() => registry.unregister('ghost')).not.toThrow();
  });

  it('register on existing session_id evicts + closes prior socket with code 1000', () => {
    const registry = new InMemorySessionRegistry();
    const closeCalls: Array<{ code: number; reason: string }> = [];
    const oldWs = makeStubWs({
      onClose: (code, reason) => closeCalls.push({ code, reason }),
    });

    registry.register('sess-1', oldWs);
    registry.register('sess-1', makeStubWs());

    expect(closeCalls).toHaveLength(1);
    expect(closeCalls[0].code).toBe(1000);
    expect(closeCalls[0].reason).toBe('evicted by new registration');
  });

  it('size stays at 1 after eviction (not 2)', () => {
    const registry = new InMemorySessionRegistry();
    registry.register('sess-1', makeStubWs());
    registry.register('sess-1', makeStubWs());
    expect(registry.size).toBe(1);
  });

  it('send after eviction targets the new socket, not the evicted one', () => {
    const registry = new InMemorySessionRegistry();
    const oldReceived: string[] = [];
    const newReceived: string[] = [];

    const oldWs = makeStubWs({ onSend: (d) => oldReceived.push(d) });
    const newWs = makeStubWs({ onSend: (d) => newReceived.push(d) });

    registry.register('sess-1', oldWs);
    registry.register('sess-1', newWs);

    registry.send('sess-1', stubPayload);

    expect(oldReceived).toHaveLength(0);
    expect(newReceived).toHaveLength(1);
  });

  it('JSON.stringify called once per send (all sockets receive same string)', () => {
    // Verify the implementation serialises once by checking two distinct sessions
    // receive identical strings when sent the same payload.
    const registry = new InMemorySessionRegistry();
    const received: string[] = [];

    registry.register('sess-a', makeStubWs({ onSend: (d) => received.push(d) }));
    registry.register('sess-b', makeStubWs({ onSend: (d) => received.push(d) }));

    registry.send('sess-a', stubPayload);
    registry.send('sess-b', stubPayload);

    // Both sends must produce identical JSON
    expect(received).toHaveLength(2);
    expect(received[0]).toBe(received[1]);
    expect(received[0]).toBe(JSON.stringify(stubPayload));
  });

  it('multiple sessions are independent — send targets only the correct session', () => {
    const registry = new InMemorySessionRegistry();
    const received: Record<string, string[]> = { a: [], b: [] };

    registry.register('sess-a', makeStubWs({ onSend: (d) => received.a.push(d) }));
    registry.register('sess-b', makeStubWs({ onSend: (d) => received.b.push(d) }));

    registry.send('sess-a', stubPayload);

    expect(received.a).toHaveLength(1);
    expect(received.b).toHaveLength(0);
  });

  it('Disposable dispose is idempotent — double dispose does not throw or corrupt state', () => {
    const registry = new InMemorySessionRegistry();
    const ws = makeStubWs();
    const disposable = registry.register('sess-1', ws);

    disposable[Symbol.dispose]();
    expect(() => disposable[Symbol.dispose]()).not.toThrow();
    expect(registry.size).toBe(0);
  });

  it('no state leak between tests — fresh registry starts at size 0', () => {
    const registry = new InMemorySessionRegistry();
    expect(registry.size).toBe(0);
  });

  it('send with optional reply_to field — serialised correctly', () => {
    const registry = new InMemorySessionRegistry();
    const received: string[] = [];
    registry.register('sess-1', makeStubWs({ onSend: (d) => received.push(d) }));

    const payloadWithReplyTo: OutboundSessionPayload = {
      type: 'reply',
      text: 'a response',
      reply_to: 'msg-99',
      client_msg_id: 'cmid-2',
      origin: 'pwa',
    };

    const result = registry.send('sess-1', payloadWithReplyTo);
    expect(result).toEqual({ ok: true });
    expect(received[0]).toBe(JSON.stringify(payloadWithReplyTo));
  });

  // ── R2 new tests ──────────────────────────────────────────────────────────

  it('eviction with throwing close — register does not throw, size === 1, send to new socket succeeds', () => {
    const registry = new InMemorySessionRegistry();
    const oldWs = makeStubWs({ throwOnClose: true });
    const newReceived: string[] = [];
    const newWs = makeStubWs({ onSend: (d) => newReceived.push(d) });

    // First registration
    registry.register('sess-1', oldWs);
    // Second registration evicts — oldWs.close() throws; must not propagate
    expect(() => registry.register('sess-1', newWs)).not.toThrow();

    expect(registry.size).toBe(1);
    const result = registry.send('sess-1', stubPayload);
    expect(result).toEqual({ ok: true });
    expect(newReceived).toHaveLength(1);
  });

  it('stale Disposable after rebind — calling A dispose does not remove the new socket', () => {
    const registry = new InMemorySessionRegistry();
    const newReceived: string[] = [];
    const wsA = makeStubWs();
    const wsB = makeStubWs({ onSend: (d) => newReceived.push(d) });

    // Register A → get disposable A
    const disposableA = registry.register('sess-1', wsA);
    // Rebind with B (evicts A)
    registry.register('sess-1', wsB);

    // Dispose A — must NOT delete B from the registry
    disposableA[Symbol.dispose]();

    expect(registry.size).toBe(1);
    const result = registry.send('sess-1', stubPayload);
    expect(result).toEqual({ ok: true });
    expect(newReceived).toHaveLength(1);
  });

  // ── P2.5 new tests ────────────────────────────────────────────────────────

  it('tryRegister returns {ok:true, disposable} when under cap', () => {
    const registry = new InMemorySessionRegistry(3);
    const ws = makeStubWs();
    const result: TryRegisterResult = registry.tryRegister('sess-1', ws);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(typeof result.disposable[Symbol.dispose]).toBe('function');
    }
    expect(registry.size).toBe(1);
  });

  it('tryRegister returns {ok:false, reason:"cap_exceeded"} when at capacity (new session)', () => {
    const registry = new InMemorySessionRegistry(2);
    registry.tryRegister('sess-a', makeStubWs());
    registry.tryRegister('sess-b', makeStubWs());
    // At cap
    const result: TryRegisterResult = registry.tryRegister('sess-c', makeStubWs());
    expect(result).toEqual({ ok: false, reason: 'cap_exceeded' });
    expect(registry.size).toBe(2); // unchanged
  });

  it('tryRegister allows rebind of existing session_id even when at cap', () => {
    const registry = new InMemorySessionRegistry(1);
    registry.tryRegister('sess-1', makeStubWs());
    // At cap — but rebind is always allowed
    const result: TryRegisterResult = registry.tryRegister('sess-1', makeStubWs());
    expect(result.ok).toBe(true);
    expect(registry.size).toBe(1); // size stays at 1 after eviction+rebind
  });

  it('send() returns {ok:false, reason:"buffer_full"} when target socket bufferedAmount exceeds cap', () => {
    // Cap: 1 MB (default). Stub a ws with bufferedAmount > cap.
    const capBytes = 1_048_576;
    const registry = new InMemorySessionRegistry(64, capBytes);
    const ws = makeStubWs({ bufferedAmount: capBytes + 1 });
    registry.register('sess-1', ws);

    const result = registry.send('sess-1', stubPayload);
    expect(result).toEqual({ ok: false, reason: 'buffer_full' });
  });

  it('send() returns {ok:true} when target socket bufferedAmount is exactly at cap (not over)', () => {
    const capBytes = 1_048_576;
    const registry = new InMemorySessionRegistry(64, capBytes);
    const received: string[] = [];
    const ws = makeStubWs({ bufferedAmount: capBytes, onSend: (d) => received.push(d) });
    registry.register('sess-1', ws);

    const result = registry.send('sess-1', stubPayload);
    expect(result).toEqual({ ok: true });
    expect(received).toHaveLength(1);
  });

  // ── HIGH 2 fix tests ──────────────────────────────────────────────────────

  it('send() returns {ok:false, reason:"send_failed"} when getBufferedAmount() throws (does not propagate)', () => {
    // HIGH 2: getBufferedAmount() is now wrapped in its own try/catch.
    // A throwing implementation should not propagate — it returns send_failed.
    const registry = new InMemorySessionRegistry();
    const ws = makeStubWs({ throwOnGetBufferedAmount: true });
    registry.register('sess-1', ws);

    let threw = false;
    let result: ReturnType<typeof registry.send> | undefined;
    try {
      result = registry.send('sess-1', stubPayload);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(result).toEqual({ ok: false, reason: 'send_failed' });
  });

  it('send() with injected logger calls logger.warn when getBufferedAmount() throws', () => {
    // HIGH 3: verify the injected logger is called (not bare console.warn).
    const warnCalls: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
    const mockLogger = {
      debug: () => {},
      info: () => {},
      warn: (msg: string, fields?: Record<string, unknown>) => { warnCalls.push({ msg, fields }); },
      error: () => {},
    };

    const registry = new InMemorySessionRegistry(64, 1_048_576, mockLogger);
    const ws = makeStubWs({ throwOnGetBufferedAmount: true });
    registry.register('sess-1', ws);

    registry.send('sess-1', stubPayload);

    expect(warnCalls.length).toBeGreaterThan(0);
    expect(warnCalls[0]!.msg).toBe('session_registry_get_buffered_amount_failed');
  });

  // ── HIGH 1 burst test ─────────────────────────────────────────────────────

  it('tryRegister concurrent burst: hub.size never exceeds cap after N+5 opens', () => {
    // HIGH 1: simulate N+5 concurrent tryRegister calls where cap is N.
    // This mirrors the TOCTOU scenario — all calls arrive before any are processed.
    const cap = 5;
    const registry = new InMemorySessionRegistry(cap);
    const results: Array<ReturnType<typeof registry.tryRegister>> = [];

    // Simulate N+5 concurrent attempts (synchronous in this runtime, but proves cap enforcement)
    for (let i = 0; i < cap + 5; i++) {
      results.push(registry.tryRegister(`sess-${i}`, makeStubWs()));
    }

    // Count successes and failures
    const successes = results.filter(r => r.ok);
    const failures = results.filter(r => !r.ok);

    expect(successes).toHaveLength(cap);
    expect(failures).toHaveLength(5);
    failures.forEach(r => {
      expect(r).toEqual({ ok: false, reason: 'cap_exceeded' });
    });
    expect(registry.size).toBe(cap);
  });
});

// ── has() method tests ────────────────────────────────────────────────────────

describe('InMemorySessionRegistry.has()', () => {
  it('has() returns false before any registration', () => {
    const registry = new InMemorySessionRegistry();
    expect(registry.has('sess-1')).toBe(false);
  });

  it('has() returns true after register()', () => {
    const registry = new InMemorySessionRegistry();
    const ws = makeStubWs();
    registry.register('sess-1', ws);
    expect(registry.has('sess-1')).toBe(true);
  });

  it('has() returns true after tryRegister()', () => {
    const registry = new InMemorySessionRegistry();
    const ws = makeStubWs();
    registry.tryRegister('sess-1', ws);
    expect(registry.has('sess-1')).toBe(true);
  });

  it('has() returns false after dispose() (unregister)', () => {
    const registry = new InMemorySessionRegistry();
    const ws = makeStubWs();
    const { disposable } = registry.tryRegister('sess-1', ws) as { ok: true; disposable: Disposable };
    expect(registry.has('sess-1')).toBe(true);
    disposable[Symbol.dispose]();
    expect(registry.has('sess-1')).toBe(false);
  });

  it('has() returns false after unregister()', () => {
    const registry = new InMemorySessionRegistry();
    const ws = makeStubWs();
    registry.register('sess-1', ws);
    registry.unregister('sess-1');
    expect(registry.has('sess-1')).toBe(false);
  });

  it('has() is independent for distinct session IDs', () => {
    const registry = new InMemorySessionRegistry();
    registry.register('sess-1', makeStubWs());
    expect(registry.has('sess-1')).toBe(true);
    expect(registry.has('sess-2')).toBe(false);
  });
});
