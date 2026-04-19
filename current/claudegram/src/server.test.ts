import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { openDatabase, closeDatabase } from './db/client.js';
import type { Database } from './db/client.js';
import { createServer } from './server.js';
import type { RunningServer } from './server.js';
import { InMemoryHub } from './ws/hub.js';
import type { Config } from './config.js';
import { createLogger } from './logger.js';
import { InMemorySessionRegistry } from './ws/session-registry.js';

// Use a port range that avoids collision with common services.
const BASE_PORT = 38000 + (process.pid % 1000);

function makeConfig(port: number): Config {
  // Bypass Zod to allow port=0-style ephemeral. Tests use explicit high ports.
  return { port, db_path: ':memory:', log_level: 'error', trustCfAccess: false, wsOutboundBufferCapBytes: 1_048_576 };
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

