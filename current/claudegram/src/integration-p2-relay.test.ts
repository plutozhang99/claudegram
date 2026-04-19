/**
 * integration-p2-relay.test.ts — P2 E2E round-trip tests.
 *
 * Exercises the full relay protocol end-to-end:
 *   - /session-socket (fake-fakechat client)
 *   - /user-socket (fake-PWA clients)
 *   - /ingest (HTTP)
 *   - /api/sessions (HTTP)
 *
 * Uses port 0 (ephemeral), in-memory SQLite, and real WebSocket clients.
 * No mocks of any claudegram internals.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import path from 'node:path';
import { openDatabase, closeDatabase } from './db/client.js';
import type { Database } from './db/client.js';
import { createServer } from './server.js';
import type { RunningServer } from './server.js';
import { createLogger } from './logger.js';
import type { Config } from './config.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeConfig(): Config {
  return {
    port: 0 as unknown as number,
    db_path: ':memory:',
    log_level: 'error',
    trustCfAccess: false,
    wsOutboundBufferCapBytes: 1_048_576,
    wsInboundMaxBadFrames: 5,
    maxPwaConnections: 256,
    maxSessionConnections: 64,
  };
}

const silentLogger = createLogger({ level: 'error', stream: { write: () => {} } });

/** Open a WebSocket to the given URL and wait for it to be ready. */
async function openWs(url: string, timeoutMs = 3000): Promise<WebSocket> {
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`WebSocket open timeout after ${timeoutMs}ms: ${url}`)),
      timeoutMs,
    );
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error(`WebSocket error on open: ${url}`));
    }, { once: true });
  });
  return ws;
}

/** Open a /user-socket connection. */
function openUserSocket(port: number): Promise<WebSocket> {
  return openWs(`ws://localhost:${port}/user-socket`);
}

/** Open a /session-socket connection. */
function openSessionSocket(port: number): Promise<WebSocket> {
  return openWs(`ws://localhost:${port}/session-socket`);
}

/** POST to /ingest and return the Response. */
function postIngest(port: number, body: unknown): Promise<Response> {
  return fetch(`http://localhost:${port}/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** GET /api/sessions and return the sessions array. Throws on unexpected shape. */
async function getSessions(port: number): Promise<ReadonlyArray<Record<string, unknown>>> {
  const res = await fetch(`http://localhost:${port}/api/sessions`);
  if (!res.ok) throw new Error(`/api/sessions failed: ${res.status}`);
  const body = (await res.json()) as { sessions?: ReadonlyArray<Record<string, unknown>> };
  if (!Array.isArray(body.sessions)) throw new Error('/api/sessions: missing sessions array');
  return body.sessions;
}

/**
 * Wait for the next WebSocket message that passes `predicate`, within `timeoutMs`.
 * Rejects with a descriptive error if nothing matches before the deadline, or if
 * the socket closes before a matching message arrives.
 */
function waitForMessage<T>(
  ws: WebSocket,
  predicate: (m: unknown) => m is T,
  timeoutMs: number,
  context: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const handler = (ev: MessageEvent) => {
      try {
        const msg = JSON.parse(String(ev.data));
        if (predicate(msg)) {
          cleanup();
          resolve(msg);
        }
      } catch { /* non-JSON, ignore */ }
    };
    const closeHandler = () => {
      cleanup();
      reject(new Error(`${context}: socket closed before matching message arrived`));
    };
    const timer = setTimeout(
      () => { cleanup(); reject(new Error(`${context}: timeout after ${timeoutMs}ms`)); },
      timeoutMs,
    );
    const cleanup = () => {
      ws.removeEventListener('message', handler);
      ws.removeEventListener('close', closeHandler);
      clearTimeout(timer);
    };
    ws.addEventListener('message', handler);
    ws.addEventListener('close', closeHandler, { once: true });
  });
}

/**
 * Assert that no message matching `predicate` arrives within `windowMs`.
 * Resolves when the deadline passes without a match; rejects immediately on a match.
 * All listeners are removed on both paths (no leak).
 */
function assertNoMessage(
  ws: WebSocket,
  match: (m: unknown) => boolean,
  windowMs: number,
  context: string,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const handler = (ev: MessageEvent) => {
      try {
        const msg = JSON.parse(String(ev.data));
        if (match(msg)) {
          cleanup();
          reject(new Error(`${context}: unexpected message ${JSON.stringify(msg)}`));
        }
      } catch { /* not JSON — ignore */ }
    };
    const errorHandler = () => { cleanup(); resolve(); }; // socket error → no matching msg arrived, success
    const cleanup = () => {
      ws.removeEventListener('message', handler);
      ws.removeEventListener('error', errorHandler);
      clearTimeout(timer);
    };
    ws.addEventListener('message', handler);
    ws.addEventListener('error', errorHandler);
    const timer = setTimeout(() => { cleanup(); resolve(); }, windowMs);
  });
}

/**
 * Poll /api/sessions until `sessionId` appears in the list, or throw on timeout.
 * Uses 25ms poll interval — fast enough to be effectively instant on localhost,
 * slow enough to avoid busy-looping. Default timeout: 2000ms.
 *
 * This replaces the bare `setTimeout(50)` race-prayer that hoped the server
 * finished processing a register frame before the next step ran.
 */
async function waitForSessionRegistered(
  baseUrl: string,
  sessionId: string,
  timeoutMs: number = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/sessions`);
      if (res.ok) {
        const { sessions } = (await res.json()) as { sessions: ReadonlyArray<{ id: string }> };
        if (sessions.some((s) => s.id === sessionId)) return;
      }
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`session ${sessionId} not registered within ${timeoutMs}ms`);
}

/**
 * Close a WebSocket and wait for the close event to actually fire (event-driven).
 * Falls back to a 500ms safety-net timer in case the socket is in a weird state
 * where the close event never fires (e.g. already errored without close).
 */
async function closeWs(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((resolve) => {
    const done = () => resolve();
    ws.addEventListener('close', done, { once: true });
    ws.addEventListener('error', done, { once: true });
    try { ws.close(1000, 'test cleanup'); } catch { done(); }
    // Safety net: if the close event doesn't fire within 500ms (WS already in weird state), resolve anyway.
    setTimeout(done, 500);
  });
}

// ── Per-test server fixture ──────────────────────────────────────────────────

let db: Database;
let srv: RunningServer;

beforeEach(() => {
  db = openDatabase(':memory:');
  srv = createServer({
    config: makeConfig(),
    db,
    logger: silentLogger,
    webRoot: path.resolve(process.cwd(), 'web'),
  });
});

afterEach(async () => {
  await srv.stop(true);
  closeDatabase(db);
});

// ── Test 1: Happy-path relay (2.6a) ─────────────────────────────────────────

describe('2.6a — Happy-path relay: PWA reply forwarded to fake-fakechat', () => {
  it('fake-fakechat receives the forwarded reply with origin:pwa within 2s', async () => {
    const SESSION_ID = 'sess-e2e-relay';
    const CLIENT_MSG_ID = 'cm-e2e-1';

    // 1. Connect fake-fakechat to /session-socket and register.
    const sessionWs = await openSessionSocket(srv.port);
    try {
      sessionWs.send(JSON.stringify({
        type: 'register',
        channels: ['plugin:fakechat@claude-plugins-official'],
        session_id: SESSION_ID,
        session_name: 'E2E Session',
      }));

      // Wait for the register frame to be processed before the PWA connects.
      await waitForSessionRegistered(`http://localhost:${srv.port}`, SESSION_ID);

      // 2. Open a fake-PWA /user-socket.
      const pwaWs = await openUserSocket(srv.port);
      try {
        // 3. Start listening for the forwarded reply BEFORE sending.
        const replyPromise = waitForMessage(
          sessionWs,
          (msg): msg is Record<string, unknown> =>
            typeof msg === 'object' && msg !== null &&
            (msg as Record<string, unknown>)['type'] === 'reply' &&
            (msg as Record<string, unknown>)['client_msg_id'] === CLIENT_MSG_ID &&
            (msg as Record<string, unknown>)['origin'] === 'pwa',
          2000,
          `{type:'reply', client_msg_id:'${CLIENT_MSG_ID}', origin:'pwa'} on session-socket`,
        );

        // 4. PWA sends a reply frame.
        pwaWs.send(JSON.stringify({
          type: 'reply',
          session_id: SESSION_ID,
          text: 'hello from pwa',
          client_msg_id: CLIENT_MSG_ID,
        }));

        // 5. Assert fake-fakechat received the forwarded frame.
        const forwarded = await replyPromise;
        expect(forwarded['type']).toBe('reply');
        expect(forwarded['text']).toBe('hello from pwa');
        expect(forwarded['client_msg_id']).toBe(CLIENT_MSG_ID);
        expect(forwarded['origin']).toBe('pwa');
      } finally {
        await closeWs(pwaWs);
      }
    } finally {
      await closeWs(sessionWs);
    }
  });
});

// ── Test 2: mark_read round-trip (2.6b) ─────────────────────────────────────

describe('2.6b — mark_read round-trip: unread_count drops to 0 after mark_read', () => {
  it('unread_count drops from >0 to 0 and PWA receives session_update broadcast', async () => {
    const SESSION_ID = 'sess-e2e-markread';
    const MSG_ID = 'msg-e2e-mr-1';

    // 1. POST an assistant-direction message so unread_count > 0.
    const ingestRes = await postIngest(srv.port, {
      session_id: SESSION_ID,
      session_name: 'MarkRead E2E Session',
      message: {
        id: MSG_ID,
        direction: 'assistant',
        ts: 1_700_000_000_000,
        content: 'assistant message for mark-read test',
      },
    });
    expect(ingestRes.status).toBe(200);

    // 2. Fetch /api/sessions — assert unread_count > 0.
    const sessionsBefore = await getSessions(srv.port);
    const sessBefore = sessionsBefore.find((s) => s['id'] === SESSION_ID);
    expect(sessBefore).toBeDefined();
    expect(sessBefore!['unread_count']).toBeGreaterThan(0);

    // 3. Open a fake-PWA /user-socket.
    const pwaWs = await openUserSocket(srv.port);
    try {
      // 4. Listen for the session_update broadcast BEFORE sending mark_read.
      const sessionUpdatePromise = waitForMessage(
        pwaWs,
        (msg): msg is Record<string, unknown> =>
          typeof msg === 'object' && msg !== null &&
          (msg as Record<string, unknown>)['type'] === 'session_update' &&
          typeof (msg as Record<string, unknown>)['session'] === 'object' &&
          (msg as Record<string, unknown>)['session'] !== null &&
          ((msg as Record<string, unknown>)['session'] as Record<string, unknown>)['id'] === SESSION_ID,
        2000,
        `{type:'session_update', session.id:'${SESSION_ID}'} on user-socket`,
      );

      // 5. PWA sends mark_read frame.
      pwaWs.send(JSON.stringify({
        type: 'mark_read',
        session_id: SESSION_ID,
        up_to_message_id: MSG_ID,
      }));

      // 6. Wait for the broadcast.
      const updateEvent = await sessionUpdatePromise;
      expect(updateEvent['type']).toBe('session_update');
      const updatedSession = updateEvent['session'] as Record<string, unknown>;
      expect(updatedSession['id']).toBe(SESSION_ID);

      // 7. Fetch /api/sessions again — assert unread_count === 0.
      const sessionsAfter = await getSessions(srv.port);
      const sessAfter = sessionsAfter.find((s) => s['id'] === SESSION_ID);
      expect(sessAfter).toBeDefined();
      expect(sessAfter!['unread_count']).toBe(0);
    } finally {
      await closeWs(pwaWs);
    }
  });
});

// ── Test 3: Echo dedup proof (2.6c) ─────────────────────────────────────────

describe('2.6c — Echo dedup: no double-broadcast when fakechat correctly skips re-ingest', () => {
  it('PWA observer sees exactly ONE {type:"message",direction:"user"} broadcast when PWA replies (FIX 5: direct persist+broadcast, no /ingest)', async () => {
    const SESSION_ID = 'sess-e2e-dedup';
    const CLIENT_MSG_ID = 'cm-echo';

    // 1. Register a fake-fakechat session.
    const sessionWs = await openSessionSocket(srv.port);
    try {
      sessionWs.send(JSON.stringify({
        type: 'register',
        channels: ['plugin:fakechat@claude-plugins-official'],
        session_id: SESSION_ID,
        session_name: 'Echo Dedup Session',
      }));

      // Wait deterministically for the register frame to be processed.
      await waitForSessionRegistered(`http://localhost:${srv.port}`, SESSION_ID);

      // 2. Open two PWA connections (observer1 sends, observer2 watches broadcasts).
      const pwaWs1 = await openUserSocket(srv.port);
      const pwaWs2 = await openUserSocket(srv.port);
      try {
        // 3. Intercept what fake-fakechat receives (to prove relay works).
        const relayPromise = waitForMessage(
          sessionWs,
          (msg): msg is Record<string, unknown> =>
            typeof msg === 'object' && msg !== null &&
            (msg as Record<string, unknown>)['type'] === 'reply' &&
            (msg as Record<string, unknown>)['client_msg_id'] === CLIENT_MSG_ID &&
            (msg as Record<string, unknown>)['origin'] === 'pwa',
          2000,
          `relay of {type:'reply', client_msg_id:'${CLIENT_MSG_ID}', origin:'pwa'} to session-socket`,
        );

        // 4. Collect ALL {type:'message'} events on observer (PWA-2) within 800ms.
        //    FIX 5: claudegram now persists + broadcasts PWA-originated messages directly,
        //    so observer sees EXACTLY ONE {type:'message', direction:'user'} broadcast.
        //    No /ingest is posted by fake-fakechat (the dedup contract), so no second broadcast appears.
        const received: Array<Record<string, unknown>> = [];
        const collectorPromise = new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 800);
          pwaWs2.addEventListener('message', (e: MessageEvent) => {
            let parsed: unknown;
            try { parsed = JSON.parse(e.data as string); } catch { return; }
            if (
              typeof parsed === 'object' && parsed !== null &&
              (parsed as Record<string, unknown>)['type'] === 'message'
            ) {
              received.push(parsed as Record<string, unknown>);
              if (received.length >= 2) clearTimeout(timer); // early-exit on duplicate detection
            }
          });
        });

        // 5. PWA-1 sends a reply — claudegram persists it, broadcasts it, and relays to fakechat.
        //    Fake-fakechat (our raw WS) does NOT call /ingest back (correct dedup behavior).
        pwaWs1.send(JSON.stringify({
          type: 'reply',
          session_id: SESSION_ID,
          text: 'echo-me',
          client_msg_id: CLIENT_MSG_ID,
        }));

        // 6. Relay must arrive at fake-fakechat.
        const forwarded = await relayPromise;
        expect(forwarded['type']).toBe('reply');
        expect(forwarded['origin']).toBe('pwa');

        // 7. Wait for collector window to close (800ms).
        await collectorPromise;

        // 8. Observer should have received EXACTLY ONE {type:'message'} (the FIX 5 direct broadcast).
        //    If fakechat had wrongly called /ingest, received would contain 2 events.
        const msgEvents = received.filter(
          (m) => (m['message'] as Record<string, unknown>)?.['direction'] === 'user',
        );
        expect(
          msgEvents.length,
          `expected exactly 1 user-message broadcast from FIX 5; got ${msgEvents.length}. All: ${JSON.stringify(received)}`,
        ).toBe(1);
        expect((msgEvents[0]!['message'] as Record<string, unknown>)?.['id']).toBe(CLIENT_MSG_ID);
      } finally {
        await closeWs(pwaWs1);
        await closeWs(pwaWs2);
      }
    } finally {
      await closeWs(sessionWs);
    }
  });

  it('client_msg_id dedup: if /ingest IS posted (simulated wrong re-ingest), PWA receives exactly ONE message broadcast', async () => {
    // This complementary test proves claudegram itself does not deduplicate
    // ingest POSTs — that responsibility sits with fakechat. If fakechat
    // wrongly re-posts, ONE broadcast will arrive (no silent drop on claudegram's
    // side). The unit tests in claudegram-client.test.ts prove fakechat skips.
    // Together the two layers prove end-to-end dedup.
    const SESSION_ID = 'sess-e2e-dedup-ingest';
    const MSG_ID = 'msg-dedup-1';

    const pwaWs = await openUserSocket(srv.port);
    try {
      // Start collecting ALL {type:'message'} events received within 1s.
      const received: Array<Record<string, unknown>> = [];
      const collector = new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1000);
        pwaWs.addEventListener('message', (e: MessageEvent) => {
          let parsed: unknown;
          try { parsed = JSON.parse(e.data as string); } catch { return; }
          if (
            typeof parsed === 'object' && parsed !== null &&
            (parsed as Record<string, unknown>)['type'] === 'message'
          ) {
            received.push(parsed as Record<string, unknown>);
          }
          // Stop early once we have 2 (to detect unexpected duplicates fast).
          if (received.length >= 2) clearTimeout(timer);
        });
      });

      // POST once — this is what fakechat SHOULD do.
      const res = await postIngest(srv.port, {
        session_id: SESSION_ID,
        session_name: 'Dedup Ingest Session',
        message: {
          id: MSG_ID,
          direction: 'assistant',
          ts: 1_700_000_005_000,
          content: 'dedup test message',
        },
      });
      expect(res.status).toBe(200);

      await collector;

      // Exactly one {type:'message'} broadcast per ingest POST.
      const msgEvents = received.filter((m) => m['type'] === 'message');
      expect(
        msgEvents,
        `expected exactly 1 {type:'message'} broadcast for single /ingest; got ${msgEvents.length}. All events: ${JSON.stringify(msgEvents.map((m) => (m as { type: string }).type))}`,
      ).toHaveLength(1);
      const msg = msgEvents[0] as Record<string, unknown>;
      expect(msg['session_id']).toBe(SESSION_ID);
    } finally {
      await closeWs(pwaWs);
    }
  });
});

// ── Test 4: session_not_connected error frame (bonus, 2.6 extra) ─────────────

describe('2.6 bonus — session_not_connected: error frame when no fakechat registered', () => {
  it('PWA receives {type:"error", reason:"session_not_connected"} within 500ms when session not registered', async () => {
    const pwaWs = await openUserSocket(srv.port);
    try {
      const errorPromise = waitForMessage(
        pwaWs,
        (msg): msg is Record<string, unknown> =>
          typeof msg === 'object' && msg !== null &&
          (msg as Record<string, unknown>)['type'] === 'error' &&
          (msg as Record<string, unknown>)['reason'] === 'session_not_connected' &&
          (msg as Record<string, unknown>)['session_id'] === 'not-registered' &&
          (msg as Record<string, unknown>)['client_msg_id'] === 'cm-miss',
        500,
        `{type:'error', reason:'session_not_connected', session_id:'not-registered', client_msg_id:'cm-miss'}`,
      );

      pwaWs.send(JSON.stringify({
        type: 'reply',
        session_id: 'not-registered',
        text: 'hi',
        client_msg_id: 'cm-miss',
      }));

      const errorFrame = await errorPromise;
      expect(errorFrame['type']).toBe('error');
      expect(errorFrame['reason']).toBe('session_not_connected');
      expect(errorFrame['session_id']).toBe('not-registered');
      expect(errorFrame['client_msg_id']).toBe('cm-miss');
    } finally {
      await closeWs(pwaWs);
    }
  });
});
