import { describe, it, expect } from 'bun:test';
import type { ServerWebSocket } from 'bun';
import { InMemoryHub } from './hub.js';
import type { BroadcastPayload } from './hub.js';
import type { TryAddResult } from './hub.js';

// ── Stub WebSocket ────────────────────────────────────────────────────────────

function makeStubWs(onSend?: (data: string) => void): ServerWebSocket<unknown> {
  return {
    send: (data: string | ArrayBufferLike | ArrayBufferView) => {
      onSend?.(data as string);
      return 0;
    },
    // Minimal shape — only `send` is exercised by Hub
    close: () => {},
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

// Minimal valid Message shape for test payloads
const stubMessage = {
  session_id: 's1',
  id: 'm1',
  direction: 'user' as const,
  ts: 1000,
  ingested_at: 1001,
  content: 'hello',
};

// ── Hub unit tests ────────────────────────────────────────────────────────────

describe('InMemoryHub', () => {
  it('starts empty: size === 0', () => {
    const hub = new InMemoryHub();
    expect(hub.size).toBe(0);
  });

  it('add(ws) increments size; remove(ws) decrements size', () => {
    const hub = new InMemoryHub();
    const ws = makeStubWs();
    hub.add(ws);
    expect(hub.size).toBe(1);
    hub.remove(ws);
    expect(hub.size).toBe(0);
  });

  it('broadcast sends JSON-serialised payload to the socket', () => {
    const hub = new InMemoryHub();
    const received: string[] = [];
    const ws = makeStubWs((data) => received.push(data));
    hub.add(ws);

    const payload: BroadcastPayload = { type: 'message', session_id: 's1', message: stubMessage };
    hub.broadcast(payload);

    expect(received).toHaveLength(1);
    expect(received[0]).toBe(JSON.stringify(payload));
  });

  it('broadcast with 3 sockets — each receives exactly once', () => {
    const hub = new InMemoryHub();
    const counts = [0, 0, 0];

    const ws0 = makeStubWs(() => { counts[0]++; });
    const ws1 = makeStubWs(() => { counts[1]++; });
    const ws2 = makeStubWs(() => { counts[2]++; });

    hub.add(ws0);
    hub.add(ws1);
    hub.add(ws2);

    const stubSession = {
      id: 'sess-1',
      name: 'Session One',
      first_seen_at: 1000,
      last_seen_at: 2000,
      status: 'active' as const,
      last_read_at: 1500,
    };
    hub.broadcast({ type: 'session_update', session: stubSession });

    expect(counts[0]).toBe(1);
    expect(counts[1]).toBe(1);
    expect(counts[2]).toBe(1);
  });

  it('broadcast when one ws throws — other sockets still receive (catch isolation)', () => {
    const hub = new InMemoryHub();
    const received: string[] = [];

    const throwing = {
      send: () => { throw new Error('socket dead'); },
    } as unknown as ServerWebSocket<unknown>;

    const working = makeStubWs((data) => received.push(data));

    hub.add(throwing);
    hub.add(working);

    const payload: BroadcastPayload = { type: 'message', session_id: 's1', message: stubMessage };
    expect(() => hub.broadcast(payload)).not.toThrow();
    expect(received).toHaveLength(1);
  });

  it('remove called after add — next broadcast skips removed socket', () => {
    const hub = new InMemoryHub();
    const received: string[] = [];
    const ws = makeStubWs((data) => received.push(data));

    hub.add(ws);
    hub.remove(ws);

    hub.broadcast({ type: 'message', session_id: 's1', message: stubMessage });
    expect(received).toHaveLength(0);
  });

  it('all sockets receive the same serialised string (JSON.stringify called once per broadcast)', () => {
    const hub = new InMemoryHub();
    const seen: string[] = [];

    const ws1 = makeStubWs((d) => seen.push(d));
    const ws2 = makeStubWs((d) => seen.push(d));
    hub.add(ws1);
    hub.add(ws2);

    const payload: BroadcastPayload = { type: 'message', session_id: 's1', message: stubMessage };
    hub.broadcast(payload);

    expect(seen).toHaveLength(2);
    // Same string identity is guaranteed because all sends use the one `text` var
    expect(seen[0]).toBe(seen[1]);
    expect(seen[0]).toBe(JSON.stringify(payload));
  });

  // ── P2.5 cap-enforcement tests ────────────────────────────────────────────

  it('tryAdd returns {ok:true} when under cap', () => {
    const hub = new InMemoryHub(3);
    const ws = makeStubWs();
    const result: TryAddResult = hub.tryAdd(ws);
    expect(result).toEqual({ ok: true });
    expect(hub.size).toBe(1);
  });

  it('tryAdd returns {ok:false, reason:"cap_exceeded"} when at capacity', () => {
    const hub = new InMemoryHub(2);
    hub.tryAdd(makeStubWs());
    hub.tryAdd(makeStubWs());
    // Now at cap
    const result: TryAddResult = hub.tryAdd(makeStubWs());
    expect(result).toEqual({ ok: false, reason: 'cap_exceeded' });
    expect(hub.size).toBe(2); // size unchanged
  });

  it('tryAdd: fill to cap N, N+1 is rejected, remove one and N+1 succeeds', () => {
    const cap = 3;
    const hub = new InMemoryHub(cap);
    const sockets: ServerWebSocket<unknown>[] = [];
    for (let i = 0; i < cap; i++) {
      const ws = makeStubWs();
      sockets.push(ws);
      hub.tryAdd(ws);
    }
    expect(hub.size).toBe(cap);

    // N+1 rejected
    expect(hub.tryAdd(makeStubWs())).toEqual({ ok: false, reason: 'cap_exceeded' });

    // Remove one → slot freed → next tryAdd succeeds
    hub.remove(sockets[0]!);
    expect(hub.tryAdd(makeStubWs())).toEqual({ ok: true });
    expect(hub.size).toBe(cap);
  });

  it('deprecated add() does not enforce cap (backward compat)', () => {
    const hub = new InMemoryHub(1);
    hub.tryAdd(makeStubWs()); // fills cap
    hub.add(makeStubWs());    // deprecated path — no cap check
    expect(hub.size).toBe(2);
  });
});
