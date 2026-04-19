import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { openDatabase, closeDatabase } from './db/client.js';
import type { Database } from './db/client.js';
import { createServer } from './server.js';
import type { RunningServer } from './server.js';
import { InMemoryHub } from './ws/hub.js';
import type { Config } from './config.js';
import { createLogger } from './logger.js';
import { InMemorySessionRegistry } from './ws/session-registry.js';
import type { Hub, TryAddResult } from './ws/hub.js';

// Use a port range that avoids collision with common services.
const BASE_PORT = 38000 + (process.pid % 1000);

function makeConfig(port: number): Config {
  // Bypass Zod to allow port=0-style ephemeral. Tests use explicit high ports.
  return { port, db_path: ':memory:', log_level: 'error', trustCfAccess: false, wsOutboundBufferCapBytes: 1_048_576, wsInboundMaxBadFrames: 5, maxPwaConnections: 256, maxSessionConnections: 64 };
}

const logger = createLogger({ level: 'error' });

let db: Database;
let server: RunningServer;
let portCounter = 0;

function nextPort(): number {
  return BASE_PORT + portCounter++;
}

beforeEach(() => {
  db = openDatabase(':memory:');
});

afterEach(async () => {
  if (server) {
    await server.stop(true);
  }
  closeDatabase(db);
});

describe('createServer', () => {
  it('returns object with port > 0 and a stop function', () => {
    server = createServer({ config: makeConfig(nextPort()), db, logger });
    expect(server.port).toBeGreaterThan(0);
    expect(typeof server.stop).toBe('function');
  });

  it('GET /nope returns 404 with JSON body', async () => {
    server = createServer({ config: makeConfig(nextPort()), db, logger });
    const res = await fetch(`http://localhost:${server.port}/nope`, {
      signal: AbortSignal.timeout(2000),
    });
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json();
    expect(body).toEqual({ ok: false, error: 'not found' });
  });

  it('stop() stops the server — subsequent fetch fails', async () => {
    const s = createServer({ config: makeConfig(nextPort()), db, logger });
    const port = s.port;
    await s.stop(true);
    // server is left null so afterEach's stop() is skipped for this case.
    server = null as unknown as RunningServer;

    let threw = false;
    try {
      await fetch(`http://localhost:${port}/nope`, {
        signal: AbortSignal.timeout(1000),
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it('migrate runs before Bun.serve — tables exist immediately after createServer', () => {
    server = createServer({ config: makeConfig(nextPort()), db, logger });
    type Row = { name: string };
    const tables = db
      .query<Row, []>(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
      )
      .all();
    const names = tables.map((r) => r.name);
    expect(names).toContain('messages');
    expect(names).toContain('sessions');
  });

  it('tables exist on the same DB instance passed to createServer (invariant 2)', () => {
    server = createServer({ config: makeConfig(nextPort()), db, logger });
    type Row = { cnt: number };
    const row = db
      .query<Row, []>(
        "SELECT count(*) as cnt FROM sqlite_master WHERE type='table' AND name IN ('messages','sessions')"
      )
      .get();
    expect(row?.cnt).toBe(2);
  });
});

describe('WebSocket /user-socket', () => {
  it('connecting to /user-socket increases hub size to 1', async () => {
    const hub = new InMemoryHub();
    server = createServer({ config: makeConfig(nextPort()), db, logger, hub });

    const ws = new WebSocket(`ws://localhost:${server.port}/user-socket`);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('ws error'));
      setTimeout(() => reject(new Error('ws open timeout')), 3000);
    });

    // Give the open handler time to run
    await new Promise<void>((r) => setTimeout(r, 20));
    expect(hub.size).toBe(1);

    ws.close();
    // Give the close handler time to run
    await new Promise<void>((r) => setTimeout(r, 50));
    expect(hub.size).toBe(0);
  });

  it('non-websocket request to /user-socket returns HTTP response (not upgraded)', async () => {
    const hub = new InMemoryHub();
    server = createServer({ config: makeConfig(nextPort()), db, logger, hub });

    // Plain HTTP GET to /user-socket without upgrade header
    const res = await fetch(`http://localhost:${server.port}/user-socket`, {
      signal: AbortSignal.timeout(2000),
    });
    // Should be a 404 (no upgrade header, falls through to dispatch)
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(hub.size).toBe(0);
  });
});

// ── P2.5: pre-upgrade 503 cap tests ──────────────────────────────────────────

describe('pre-upgrade 503 cap enforcement', () => {
  it('/user-socket: upgrade attempt when hub is at capacity returns 503', async () => {
    // Create a hub that reports it's at cap (size >= maxPwaConnections).
    // Use a stub hub with size === maxPwaConnections so the cap check fires.
    const maxPwa = 2;
    const config = makeConfig(nextPort());
    const cappedConfig: Config = { ...config, maxPwaConnections: maxPwa };

    // A real hub filled to cap
    const hub = new InMemoryHub(maxPwa);
    // Fill with stubs using the deprecated add() to bypass cap for setup purposes
    hub.add({ send: () => 0 } as unknown as Parameters<typeof hub.add>[0]);
    hub.add({ send: () => 0 } as unknown as Parameters<typeof hub.add>[0]);
    expect(hub.size).toBe(maxPwa);

    server = createServer({ config: cappedConfig, db, logger, hub });

    // WebSocket upgrade request (plain HTTP with Upgrade header)
    const res = await fetch(`http://localhost:${server.port}/user-socket`, {
      headers: { Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '13' },
      signal: AbortSignal.timeout(2000),
    });
    expect(res.status).toBe(503);
    const body = await res.text();
    expect(body).toBe('too many connections');
  });

  it('/session-socket: upgrade attempt when registry is at capacity returns 503', async () => {
    const maxSession = 1;
    const config = makeConfig(nextPort());
    const cappedConfig: Config = { ...config, maxSessionConnections: maxSession };

    // A real registry filled to cap
    const sessionRegistry = new InMemorySessionRegistry(maxSession);
    // Fill with a stub ws using register() directly
    sessionRegistry.register('fake-sess', { send: () => 0, close: () => {} } as unknown as Parameters<typeof sessionRegistry.register>[1]);
    expect(sessionRegistry.size).toBe(maxSession);

    server = createServer({ config: cappedConfig, db, logger, sessionRegistry });

    const res = await fetch(`http://localhost:${server.port}/session-socket`, {
      headers: { Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '13' },
      signal: AbortSignal.timeout(2000),
    });
    expect(res.status).toBe(503);
    const body = await res.text();
    expect(body).toBe('too many connections');
  });
});

// ── HIGH 1 TOCTOU: tryAdd called in open handler, hub.size never exceeds cap ──
//
// Integration-level proof: open cap+3 real WS connections where hub.size always
// reports 0 (TOCTOU simulation). tryAdd enforces cap; surplus get 1008.
// Done here as a single sequential-connect test to avoid Bun test-runner hang
// when multiple WebSocket promises are awaited concurrently.

describe('HIGH 1 TOCTOU — tryAdd authoritative gate in open handler', () => {
  it('open() calls tryAdd() — hub.size cannot exceed cap even if pre-upgrade check is bypassed', async () => {
    const cap = 2;
    let tryAddCallCount = 0;
    let tryAddCapExceededCount = 0;

    const realHub = new InMemoryHub(cap);
    const stubHub: Hub = {
      tryAdd: (ws) => {
        tryAddCallCount++;
        const result: TryAddResult = realHub.tryAdd(ws);
        if (!result.ok) tryAddCapExceededCount++;
        return result;
      },
      add: (ws) => realHub.add(ws),
      remove: (ws) => realHub.remove(ws),
      broadcast: (payload) => realHub.broadcast(payload),
      // size always reports 0 so all upgrades bypass the pre-upgrade 503 check.
      // The open() handler's tryAdd() is the real enforcement point.
      get size() { return 0; },
    };

    const config: Config = { ...makeConfig(nextPort()), maxPwaConnections: cap };
    server = createServer({ config, db, logger, hub: stubHub });
    const testPort = server.port;

    // Open cap+3 connections sequentially; each waits for open/close/error before
    // the next. This avoids the Bun test-runner event-loop interaction that causes
    // Promise.all on concurrent WS connections to hang.
    const burst = cap + 3;
    const sockets: WebSocket[] = [];

    for (let i = 0; i < burst; i++) {
      const ws = new WebSocket(`ws://localhost:${testPort}/user-socket`);
      sockets.push(ws);
      await new Promise<void>((resolve) => {
        ws.onopen = () => resolve();
        ws.onclose = () => resolve();
        ws.onerror = () => resolve();
        setTimeout(resolve, 2000);
      });
      // Short yield so the server open-handler runs before the next connect.
      await new Promise<void>((r) => setTimeout(r, 10));
    }

    // Allow all server-side open handlers to complete.
    await new Promise<void>((r) => setTimeout(r, 50));

    // Every socket was upgraded (hub.size=0 bypasses pre-upgrade 503).
    expect(tryAddCallCount).toBe(burst);
    // tryAdd rejected the surplus.
    expect(tryAddCapExceededCount).toBe(burst - cap);
    // The hub never exceeded cap.
    expect(realHub.size).toBeLessThanOrEqual(cap);

    // Close client sockets first.
    for (const ws of sockets) {
      try { ws.close(); } catch { /* already closed by server */ }
    }
    // Give server close handlers time to run, then stop without drain.
    // We set server=null to skip the afterEach's stop(true) which would hang
    // waiting for Bun to drain connections that are in TCP FIN_WAIT state.
    await new Promise<void>((r) => setTimeout(r, 200));
    void server.stop(false); // fire-and-forget; non-awaited to avoid Bun hang
    server = null as unknown as RunningServer;
  });
});

// ── HIGH 1 cross-route routing isolation test ─────────────────────────────────

describe('WebSocket routing isolation', () => {
  it('/user-socket inbound register frame does NOT trigger session-socket handler (no upsert)', async () => {
    const hub = new InMemoryHub();
    const sessionRegistry = new InMemorySessionRegistry();
    server = createServer({ config: makeConfig(nextPort()), db, logger, hub, sessionRegistry });

    // Connect via /user-socket (NOT /session-socket)
    const ws = new WebSocket(`ws://localhost:${server.port}/user-socket`);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('ws error'));
      setTimeout(() => reject(new Error('ws open timeout')), 3000);
    });

    // Give the open handler time to run
    await new Promise<void>((r) => setTimeout(r, 20));

    // Send a {type:'register'} frame — this would trigger session-socket handler
    // if routing was incorrectly merged. The session registry should remain empty.
    ws.send(JSON.stringify({ type: 'register', session_id: 'fake-session-via-user-socket' }));

    // Allow message processing time
    await new Promise<void>((r) => setTimeout(r, 50));

    // The session registry must NOT have any registered sessions — the
    // user-socket path must NOT route to the session-socket message handler.
    expect(sessionRegistry.size).toBe(0);

    // Hub should have the user-socket connected
    expect(hub.size).toBe(1);

    ws.close();
    await new Promise<void>((r) => setTimeout(r, 50));
    expect(hub.size).toBe(0);
  });
});

