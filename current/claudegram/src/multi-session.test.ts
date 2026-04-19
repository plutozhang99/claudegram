import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { openDatabase, closeDatabase } from './db/client.js';
import type { Database } from './db/client.js';
import { createServer } from './server.js';
import type { RunningServer } from './server.js';
import type { Config } from './config.js';
import { createLogger } from './logger.js';

// Use a port range distinct from server.test.ts (38000 + pid%1000) to avoid collision.
const port = 39000 + (process.pid % 1000);

describe('multi-session ingest', () => {
  let server: RunningServer;
  let db: Database;

  beforeAll(() => {
    db = openDatabase(':memory:');
    const cfg: Config = { port, db_path: ':memory:', log_level: 'error', trustCfAccess: false, wsOutboundBufferCapBytes: 1_048_576, wsInboundMaxBadFrames: 5, maxPwaConnections: 256, maxSessionConnections: 64 };
    const logger = createLogger({ level: 'error', stream: { write: () => {} } });
    server = createServer({ config: cfg, db, logger });
  });

  afterAll(async () => {
    await server.stop(true);
    closeDatabase(db);
  });

  it('two sessions ingest independently and attribute correctly', async () => {
    const baseUrl = `http://localhost:${server.port}`;

    const postIngest = (body: unknown): Promise<Response> =>
      fetch(`${baseUrl}/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    // Session A posts 2 messages
    const a1 = await postIngest({
      session_id: 'session-A',
      session_name: 'A',
      message: { id: 'a1', direction: 'user', ts: 1000, content: 'hi from A' },
    });
    expect(a1.status).toBe(200);

    const a2 = await postIngest({
      session_id: 'session-A',
      session_name: 'A',
      message: { id: 'a2', direction: 'assistant', ts: 1100, content: 'reply in A' },
    });
    expect(a2.status).toBe(200);

    // Session B posts 1 message
    const b1 = await postIngest({
      session_id: 'session-B',
      session_name: 'B',
      message: { id: 'b1', direction: 'user', ts: 2000, content: 'hi from B' },
    });
    expect(b1.status).toBe(200);

    // Verify DB: 2 sessions, correctly attributed
    const sessions = db
      .query<{ id: string; name: string }, []>(
        'SELECT id, name FROM sessions ORDER BY id',
      )
      .all();
    expect(sessions.length).toBe(2);
    expect(sessions[0]!.id).toBe('session-A');
    expect(sessions[1]!.id).toBe('session-B');

    // Session A has 2 messages
    const msgsA = db
      .query<{ id: string; content: string }, [string]>(
        'SELECT id, content FROM messages WHERE session_id=? ORDER BY ts',
      )
      .all('session-A');
    expect(msgsA.length).toBe(2);
    expect(msgsA[0]!.content).toBe('hi from A');
    expect(msgsA[1]!.content).toBe('reply in A');

    // Session B has 1 message
    const msgsB = db
      .query<{ id: string; content: string }, [string]>(
        'SELECT id, content FROM messages WHERE session_id=? ORDER BY ts',
      )
      .all('session-B');
    expect(msgsB.length).toBe(1);
    expect(msgsB[0]!.content).toBe('hi from B');

    // Bonus: same message id in different sessions does not collide
    const collide = await postIngest({
      session_id: 'session-B',
      session_name: 'B',
      message: { id: 'a1', direction: 'user', ts: 2100, content: 'different message, same id' },
    });
    expect(collide.status).toBe(200);

    const afterCollide = db
      .query<{ session_id: string; content: string }, [string]>(
        'SELECT session_id, content FROM messages WHERE id=?',
      )
      .all('a1');
    // One in session-A and one in session-B — no collision
    expect(afterCollide.length).toBe(2);
  });
});
