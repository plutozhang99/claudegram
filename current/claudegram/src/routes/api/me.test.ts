import { describe, it, expect } from 'bun:test';
import type { Config } from '../../config.js';
import { handleApiMe } from './me.js';

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 8788,
    db_path: './data/claudegram.db',
    log_level: 'info',
    trustCfAccess: false,
    wsOutboundBufferCapBytes: 1_048_576,
    wsInboundMaxBadFrames: 5,
    maxPwaConnections: 256,
    maxSessionConnections: 64,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<Config> = {}) {
  return { config: makeConfig(overrides) };
}

function makeReq(method: string, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/me', { method, headers });
}

describe('handleApiMe', () => {
  it('GET with valid email header and trustCfAccess=true → 200 with that email', async () => {
    const res = handleApiMe(
      makeReq('GET', { 'Cf-Access-Authenticated-User-Email': 'alice@example.com' }),
      makeDeps({ trustCfAccess: true }),
    );
    const r = res instanceof Promise ? await res : res;
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toEqual({ ok: true, email: 'alice@example.com' });
  });

  it('GET with valid email header and trustCfAccess=false → 200 { ok: true, email: "local@dev" } (header ignored)', async () => {
    const res = handleApiMe(
      makeReq('GET', { 'Cf-Access-Authenticated-User-Email': 'alice@example.com' }),
      makeDeps({ trustCfAccess: false }),
    );
    const r = res instanceof Promise ? await res : res;
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toEqual({ ok: true, email: 'local@dev' });
  });

  it('GET without header → 200 { ok: true, email: "local@dev" }', async () => {
    const res = handleApiMe(makeReq('GET'), makeDeps());
    const r = res instanceof Promise ? await res : res;
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toEqual({ ok: true, email: 'local@dev' });
  });

  it('GET with malformed email header → 200 { ok: true, email: "local@dev" }', async () => {
    const res = handleApiMe(
      makeReq('GET', { 'Cf-Access-Authenticated-User-Email': 'notanemail' }),
      makeDeps({ trustCfAccess: true }),
    );
    const r = res instanceof Promise ? await res : res;
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toEqual({ ok: true, email: 'local@dev' });
  });

  it('POST → 405 method not allowed', async () => {
    const res = handleApiMe(makeReq('POST'), makeDeps());
    const r = res instanceof Promise ? await res : res;
    expect(r.status).toBe(405);
    const body = await r.json();
    expect(body).toEqual({ ok: false, error: 'method not allowed' });
  });
});
