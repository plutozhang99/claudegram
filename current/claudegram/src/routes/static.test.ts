import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from '../logger.js';
import { handleRoot, handleWebAsset, serveStaticFile } from './static.js';

// ── Noop logger stub ──────────────────────────────────────────────────────────
const noopLogger: Logger = {
  debug: () => {},
  info:  () => {},
  warn:  () => {},
  error: () => {},
};

// ── Temporary webRoot ─────────────────────────────────────────────────────────
let webRoot: string;

beforeAll(() => {
  webRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claudegram-static-test-'));

  // Populate: index.html
  fs.writeFileSync(path.join(webRoot, 'index.html'), '<html><body>hello</body></html>');

  // Populate: app.js
  fs.writeFileSync(path.join(webRoot, 'app.js'), 'console.warn("app");');

  // Populate: nested dir + file
  fs.mkdirSync(path.join(webRoot, 'js'));
  fs.writeFileSync(path.join(webRoot, 'js', 'boot.js'), '// boot');

  // Populate: extensionless file (must be rejected by our rule)
  fs.writeFileSync(path.join(webRoot, 'README'), 'no extension');

  // Populate: unmapped extension (must be rejected by allowlist)
  fs.writeFileSync(path.join(webRoot, 'secret.env'), 'DB_PASS=oops');
});

afterAll(() => {
  fs.rmSync(webRoot, { recursive: true, force: true });
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function makeReq(method: string, urlPath: string): Request {
  return new Request(`http://localhost${urlPath}`, { method });
}

function deps() {
  return { webRoot, logger: noopLogger };
}

// ── handleRoot ────────────────────────────────────────────────────────────────
describe('handleRoot', () => {
  it('GET / → 200, text/html, nosniff, correct body', async () => {
    const res = await handleRoot(makeReq('GET', '/'), deps());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    const body = await res.text();
    expect(body).toContain('hello');
  });

  it('GET / → 404 when index.html is missing', async () => {
    const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claudegram-empty-'));
    try {
      const res = await handleRoot(makeReq('GET', '/'), { webRoot: emptyRoot, logger: noopLogger });
      expect(res.status).toBe(404);
      const body = await res.json() as { ok: boolean; error: string };
      expect(body.ok).toBe(false);
      expect(body.error).toBe('not found');
    } finally {
      fs.rmSync(emptyRoot, { recursive: true, force: true });
    }
  });

  it('POST / → 405 method not allowed', async () => {
    const res = await handleRoot(makeReq('POST', '/'), deps());
    expect(res.status).toBe(405);
    const body = await res.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe('method not allowed');
  });
});

// ── handleWebAsset ────────────────────────────────────────────────────────────
describe('handleWebAsset', () => {
  it('GET /web/app.js → 200, application/javascript', async () => {
    const res = await handleWebAsset(makeReq('GET', '/web/app.js'), deps());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/javascript');
  });

  it('GET /web/missing.js → 404 JSON body', async () => {
    const res = await handleWebAsset(makeReq('GET', '/web/missing.js'), deps());
    expect(res.status).toBe(404);
    const body = await res.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe('not found');
  });

  it('GET /web/../outside → 404 (path traversal blocked)', async () => {
    const res = await handleWebAsset(makeReq('GET', '/web/../outside'), deps());
    expect(res.status).toBe(404);
    const body = await res.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe('not found');
  });

  it('GET /web/js/boot.js → 200, served correctly', async () => {
    const res = await handleWebAsset(makeReq('GET', '/web/js/boot.js'), deps());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/javascript');
    const body = await res.text();
    expect(body).toContain('boot');
  });

  it('GET /web/ → 404 (empty rel)', async () => {
    const res = await handleWebAsset(makeReq('GET', '/web/'), deps());
    expect(res.status).toBe(404);
    const body = await res.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe('not found');
  });

  it('GET /web/README → 404 (extensionless file)', async () => {
    const res = await handleWebAsset(makeReq('GET', '/web/README'), deps());
    expect(res.status).toBe(404);
    const body = await res.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe('not found');
  });

  it('GET /web/secret.env → 404 (unmapped extension rejected by allowlist)', async () => {
    const res = await handleWebAsset(makeReq('GET', '/web/secret.env'), deps());
    expect(res.status).toBe(404);
    const body = await res.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe('not found');
  });

  it('GET /web/app.js → includes X-Content-Type-Options: nosniff', async () => {
    const res = await handleWebAsset(makeReq('GET', '/web/app.js'), deps());
    expect(res.status).toBe(200);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('POST /web/app.js → 405 method not allowed', async () => {
    const res = await handleWebAsset(makeReq('POST', '/web/app.js'), deps());
    expect(res.status).toBe(405);
    const body = await res.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe('method not allowed');
  });
});

// ── serveStaticFile — path traversal via resolve ──────────────────────────────
describe('serveStaticFile traversal guard', () => {
  it('a crafted relPath that resolves outside webRoot → 404', async () => {
    // Even if caller passes a raw "../etc/passwd" style string, it must be blocked.
    const res = await serveStaticFile('../etc/passwd', deps());
    expect(res.status).toBe(404);
    const body = await res.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe('not found');
  });
});
