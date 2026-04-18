import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import path from 'node:path';
import { createServer } from './server.js';
import type { RunningServer } from './server.js';
import { openDatabase, closeDatabase } from './db/client.js';
import type { Database } from './db/client.js';
import { createLogger } from './logger.js';
import type { Config } from './config.js';

describe('PWA static shell is served', () => {
  let srv: RunningServer;
  let db: Database;

  beforeAll(() => {
    db = openDatabase(':memory:');
    // Bypass Zod min-port constraint for ephemeral allocation (same pattern as server.test.ts).
    const cfg = { port: 0, db_path: ':memory:', log_level: 'error', trustCfAccess: false } as unknown as Config;
    srv = createServer({
      config: cfg,
      db,
      logger: createLogger({ level: 'error' }),
      webRoot: path.resolve(process.cwd(), 'web'),
    });
  });

  afterAll(async () => {
    await srv.stop(true);
    closeDatabase(db);
  });

  const paths = [
    ['/', 'text/html'],
    ['/sw.js', 'application/javascript'], // served at origin root so its default scope is `/`
    ['/web/style.css', 'text/css'],
    ['/web/manifest.webmanifest', 'application/manifest+json'],
    ['/web/sw.js', 'application/javascript'], // still reachable via legacy path
    ['/web/icons/icon-192.png', 'image/png'],
    ['/web/icons/icon-512.png', 'image/png'],
    ['/web/js/index.js', 'application/javascript'],
  ] as const;

  for (const [p, ct] of paths) {
    it(`GET ${p} => 200 with content-type ${ct}`, async () => {
      const r = await fetch(`http://localhost:${srv.port}${p}`);
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toContain(ct);
    });
  }
});
