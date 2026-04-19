/**
 * integration.test.ts — Full E2E: boot server → connect WS client → POST /ingest → assert WS receives events.
 *
 * Uses port 0 so Bun assigns an ephemeral port, avoiding collisions with other test suites.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import path from 'node:path';
import { openDatabase, closeDatabase } from './db/client.js';
import type { Database } from './db/client.js';
import { createServer } from './server.js';
import type { RunningServer } from './server.js';
import { createLogger } from './logger.js';
import type { Config } from './config.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeConfig(): Config {
  // Cast to bypass Zod's port 1-65535 constraint — Bun accepts 0 for ephemeral.
  return { port: 0 as unknown as number, db_path: ':memory:', log_level: 'error', trustCfAccess: false, wsOutboundBufferCapBytes: 1_048_576 };
}

const logger = createLogger({ level: 'error', stream: { write: () => {} } });

const VALID_INGEST_PAYLOAD = {
  session_id: 's-int1',
  message: {
    id: 'm1',
    direction: 'user' as const,
    ts: 1_700_000_000_000,
    content: 'hi',
  },
};

/** Open a WebSocket and wait for it to connect. Returns the connected WebSocket. */
async function openWs(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://localhost:${port}/user-socket`);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('ws open timeout')), 3000);
    ws.addEventListener('open', () => { clearTimeout(timeout); resolve(); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('ws error')); }, { once: true });
  });
  return ws;
}

/**
 * Collect `expectedCount` message events from `ws` within `timeoutMs`.
 * If expectedCount === 0, resolves after timeoutMs with an empty array.
 */
function collectMessages(
  ws: WebSocket,
  expectedCount: number,
  timeoutMs: number,
): Promise<unknown[]> {
  return new Promise<unknown[]>((resolve) => {
    if (expectedCount === 0) {
      setTimeout(() => resolve([]), timeoutMs);
      return;
    }

    const events: unknown[] = [];
    const timer = setTimeout(() => resolve(events), timeoutMs);

    ws.addEventListener('message', function handler(e: MessageEvent) {
      events.push(JSON.parse(e.data as string));
      if (events.length >= expectedCount) {
        clearTimeout(timer);
        ws.removeEventListener('message', handler);
        resolve(events);
      }
    });
  });
}

/** POST to /ingest with a JSON body. */
async function postIngest(port: number, body: unknown): Promise<Response> {
  return fetch(`http://localhost:${port}/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ── Suite setup ──────────────────────────────────────────────────────────────

describe('WebSocket E2E integration', () => {
  let db: Database;
  let srv: RunningServer;

  beforeAll(() => {
    db = openDatabase(':memory:');
    srv = createServer({
      config: makeConfig(),
      db,
      logger,
      webRoot: path.resolve(process.cwd(), 'web'),
    });
  });

  afterAll(async () => {
    await srv.stop(true);
    closeDatabase(db);
  });

  // ── Test 1: WS receives {type:'message'} + {type:'session_update'} ─────────

  it("WS client receives {type:'message'} + {type:'session_update'} when /ingest succeeds", async () => {
    const ws = await openWs(srv.port);

    try {
      const collector = collectMessages(ws, 2, 2000);

      const beforeTs = Date.now();
      const res = await postIngest(srv.port, VALID_INGEST_PAYLOAD);
      expect(res.status).toBe(200);

      const events = await collector;
      expect(events).toHaveLength(2);

      // First event: type:'message'
      const ev0 = events[0] as Record<string, unknown>;
      expect(ev0['type']).toBe('message');
      expect(ev0['session_id']).toBe('s-int1');

      const msg = ev0['message'] as Record<string, unknown>;
      expect(msg['id']).toBe('m1');
      expect(msg['direction']).toBe('user');
      expect(msg['ts']).toBe(1_700_000_000_000);
      expect(msg['content']).toBe('hi');
      expect(msg['session_id']).toBe('s-int1');
      expect(typeof msg['ingested_at']).toBe('number');

      const ingestedAt = msg['ingested_at'] as number;
      expect(ingestedAt).toBeGreaterThanOrEqual(beforeTs);
      expect(ingestedAt).toBeLessThanOrEqual(Date.now());

      // Second event: type:'session_update'
      const ev1 = events[1] as Record<string, unknown>;
      expect(ev1['type']).toBe('session_update');

      const sess = ev1['session'] as Record<string, unknown>;
      expect(sess['id']).toBe('s-int1');
      expect(sess['name']).toBe('s-int1');
      expect(sess['status']).toBe('active');
      expect(sess['last_read_at']).toBe(0);
    } finally {
      ws.close();
      // Allow the close event to propagate.
      await new Promise<void>((r) => setTimeout(r, 50));
    }
  });

  // ── Test 2: WS does NOT receive events when /ingest returns 400 ────────────

  it("WS client does NOT receive events when /ingest returns 400", async () => {
    // Re-open DB + server for test isolation isn't needed since we're using the
    // same shared server — test ordering shouldn't matter for no-event assertions.
    const ws = await openWs(srv.port);

    try {
      // Expected = 0 means: wait 500ms and assert nothing arrived.
      const collector = collectMessages(ws, 0, 500);

      // Missing session_id → 400
      const res = await postIngest(srv.port, {
        message: { id: 'm-bad', direction: 'user', ts: 0, content: 'oops' },
      });
      expect(res.status).toBe(400);

      const events = await collector;
      expect(events).toHaveLength(0);
    } finally {
      ws.close();
      await new Promise<void>((r) => setTimeout(r, 50));
    }
  });

  // ── Test 3: fan-out — second WS client also receives broadcasts ────────────

  it("second WS client also receives broadcasts (fan-out)", async () => {
    const ws1 = await openWs(srv.port);
    const ws2 = await openWs(srv.port);

    try {
      const c1 = collectMessages(ws1, 2, 2000);
      const c2 = collectMessages(ws2, 2, 2000);

      const res = await postIngest(srv.port, {
        session_id: 's-fanout',
        message: { id: 'mf1', direction: 'assistant', ts: 1_700_000_001_000, content: 'fanout' },
      });
      expect(res.status).toBe(200);

      const [events1, events2] = await Promise.all([c1, c2]);

      expect(events1).toHaveLength(2);
      expect(events2).toHaveLength(2);

      // Both clients should get identical payloads.
      expect(JSON.stringify(events1)).toBe(JSON.stringify(events2));

      // Sanity-check the event types.
      expect((events1[0] as Record<string, unknown>)['type']).toBe('message');
      expect((events1[1] as Record<string, unknown>)['type']).toBe('session_update');
    } finally {
      ws1.close();
      ws2.close();
      await new Promise<void>((r) => setTimeout(r, 50));
    }
  });

  // ── Test 4: ingested_at is a plausible recent timestamp ────────────────────

  it("ingested_at in the broadcast message is a plausible recent timestamp", async () => {
    const ws = await openWs(srv.port);

    try {
      const collector = collectMessages(ws, 2, 2000);

      const beforePost = Date.now();
      const res = await postIngest(srv.port, {
        session_id: 's-ts-check',
        message: { id: 'mts1', direction: 'user', ts: 1_700_000_002_000, content: 'ts test' },
      });
      expect(res.status).toBe(200);
      const afterPost = Date.now();

      const events = await collector;
      expect(events).toHaveLength(2);

      const ev0 = events[0] as Record<string, unknown>;
      const msg = ev0['message'] as Record<string, unknown>;
      const ingestedAt = msg['ingested_at'] as number;

      expect(typeof ingestedAt).toBe('number');
      expect(ingestedAt).toBeGreaterThanOrEqual(beforePost);
      expect(ingestedAt).toBeLessThanOrEqual(afterPost + 50); // allow 50ms clock skew
    } finally {
      ws.close();
      await new Promise<void>((r) => setTimeout(r, 50));
    }
  });
});
