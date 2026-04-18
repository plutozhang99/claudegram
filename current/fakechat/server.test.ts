/**
 * Tests for pure helper functions in server.ts.
 *
 * Does NOT start a server or bind any ports.
 * Port auto-pick logic is not tested here (requires real port binding — flaky).
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { generateUlid, getSessionId, postIngest } from './server'

// ---------------------------------------------------------------------------
// generateUlid
// ---------------------------------------------------------------------------
describe('generateUlid', () => {
  it('returns a 26-character string', () => {
    const id = generateUlid()
    expect(id).toHaveLength(26)
  })

  it('uses only Crockford base32 alphabet characters', () => {
    const id = generateUlid()
    // Crockford base32: digits + uppercase excluding I, L, O, U
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
  })

  it('two consecutive calls produce different values', () => {
    const a = generateUlid()
    const b = generateUlid()
    expect(a).not.toBe(b)
  })
})

// ---------------------------------------------------------------------------
// getSessionId
// ---------------------------------------------------------------------------
describe('getSessionId', () => {
  let tmpDir: string
  const ENV_KEY = 'CLAUDE_SESSION_ID'
  let originalEnv: string | undefined

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fakechat-test-'))
    originalEnv = process.env[ENV_KEY]
  })

  afterAll(() => {
    // Restore env
    if (originalEnv === undefined) {
      delete process.env[ENV_KEY]
    } else {
      process.env[ENV_KEY] = originalEnv
    }
    // Clean up tmpdir
    try {
      rmSync(tmpDir, { recursive: true, force: true })
    } catch {}
  })

  it('returns CLAUDE_SESSION_ID env var when set', () => {
    process.env[ENV_KEY] = 'test-session-abc123'
    const id = getSessionId(tmpDir)
    expect(id).toBe('test-session-abc123')
  })

  it('generates and persists a ULID when env var is not set', () => {
    delete process.env[ENV_KEY]
    const id = getSessionId(tmpDir)
    // Should be a 26-char ULID
    expect(id).toHaveLength(26)
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
  })

  it('returns the same persisted ID on repeated calls (stable across restarts)', () => {
    delete process.env[ENV_KEY]
    // Use a fresh tmpdir to avoid interference from the previous test
    const freshDir = mkdtempSync(join(tmpdir(), 'fakechat-stable-'))
    try {
      const id1 = getSessionId(freshDir)
      const id2 = getSessionId(freshDir)
      expect(id1).toBe(id2)
    } finally {
      rmSync(freshDir, { recursive: true, force: true })
    }
  })

  it('generates a new ULID when session file exists but is empty', () => {
    delete process.env[ENV_KEY]
    const freshDir = mkdtempSync(join(tmpdir(), 'fakechat-empty-'))
    try {
      // Pre-create an empty session_id file
      writeFileSync(join(freshDir, 'session_id'), '')
      const id = getSessionId(freshDir)
      // Should generate a fresh ULID
      expect(id).toHaveLength(26)
      expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    } finally {
      rmSync(freshDir, { recursive: true, force: true })
    }
  })

  it('env var takes priority over persisted file', () => {
    // Write a session file first
    const freshDir = mkdtempSync(join(tmpdir(), 'fakechat-priority-'))
    try {
      delete process.env[ENV_KEY]
      const persisted = getSessionId(freshDir) // creates session_id file

      // Now set env var to something different
      process.env[ENV_KEY] = 'env-takes-priority'
      const result = getSessionId(freshDir)

      expect(result).toBe('env-takes-priority')
      expect(result).not.toBe(persisted)
    } finally {
      delete process.env[ENV_KEY]
      rmSync(freshDir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// postIngest
// ---------------------------------------------------------------------------
describe('postIngest', () => {
  type FetchArgs = { url: string; init: RequestInit }
  const origFetch = globalThis.fetch
  let fetchCalls: FetchArgs[] = []

  // Capture stderr writes
  const origWrite = process.stderr.write.bind(process.stderr)
  let writes: string[] = []

  afterEach(() => {
    globalThis.fetch = origFetch
    fetchCalls = []
    process.stderr.write = origWrite as typeof process.stderr.write
    writes = []
  })

  function captureSterr() {
    writes = []
    process.stderr.write = ((s: string | Uint8Array) => {
      writes.push(String(s))
      return true
    }) as typeof process.stderr.write
  }

  const samplePayload = {
    session_id: 'test-session',
    message: {
      id: 'msg-1',
      direction: 'assistant' as const,
      ts: 1700000000000,
      content: 'hello',
    },
  }

  it('does not call fetch when url is empty', async () => {
    let fetchCalled = false
    globalThis.fetch = (async () => {
      fetchCalled = true
      return new Response('ok', { status: 200 })
    }) as unknown as typeof fetch

    await postIngest(samplePayload, { url: '', tokenId: '', tokenSecret: '' })

    expect(fetchCalled).toBe(false)
  })

  it('calls fetch with correct URL, method, Content-Type, and body', async () => {
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init: init ?? {} })
      return new Response('ok', { status: 200 })
    }) as unknown as typeof fetch

    await postIngest(samplePayload, {
      url: 'http://localhost:9999',
      tokenId: '',
      tokenSecret: '',
    })

    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0].url).toBe('http://localhost:9999/ingest')
    expect(fetchCalls[0].init.method).toBe('POST')
    const headers = fetchCalls[0].init.headers as Record<string, string>
    expect(headers['Content-Type']).toBe('application/json')
    expect(fetchCalls[0].init.body).toBe(JSON.stringify(samplePayload))
  })

  it('includes CF-Access headers when both token env vars are set', async () => {
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init: init ?? {} })
      return new Response('ok', { status: 200 })
    }) as unknown as typeof fetch

    await postIngest(samplePayload, {
      url: 'http://localhost:9999',
      tokenId: 'my-client-id',
      tokenSecret: 'my-client-secret',
    })

    const headers = fetchCalls[0].init.headers as Record<string, string>
    expect(headers['CF-Access-Client-Id']).toBe('my-client-id')
    expect(headers['CF-Access-Client-Secret']).toBe('my-client-secret')
  })

  it('logs non-2xx kind to stderr when res.ok is false, does not throw', async () => {
    captureSterr()
    globalThis.fetch = (async () => {
      return new Response('error', { status: 500 })
    }) as unknown as typeof fetch

    await expect(
      postIngest(samplePayload, { url: 'http://localhost:9999', tokenId: '', tokenSecret: '' }),
    ).resolves.toBeUndefined()

    expect(writes).toHaveLength(1)
    const log = JSON.parse(writes[0].trim())
    expect(log.level).toBe('warn')
    expect(log.msg).toBe('ingest_webhook_failure')
    expect(log.kind).toBe('non-2xx')
    expect(log.status).toBe(500)
  })

  it('logs timeout kind when fetch throws TimeoutError, does not throw', async () => {
    captureSterr()
    globalThis.fetch = (async () => {
      const err = new Error('The operation timed out')
      err.name = 'TimeoutError'
      throw err
    }) as unknown as typeof fetch

    await expect(
      postIngest(samplePayload, { url: 'http://localhost:9999', tokenId: '', tokenSecret: '' }),
    ).resolves.toBeUndefined()

    const log = JSON.parse(writes[0].trim())
    expect(log.kind).toBe('timeout')
    expect(log.status).toBeNull()
  })

  it('logs refused kind when fetch throws with ECONNREFUSED, does not throw', async () => {
    captureSterr()
    globalThis.fetch = (async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:1')
    }) as unknown as typeof fetch

    await expect(
      postIngest(samplePayload, { url: 'http://localhost:1', tokenId: '', tokenSecret: '' }),
    ).resolves.toBeUndefined()

    const log = JSON.parse(writes[0].trim())
    expect(log.kind).toBe('refused')
    expect(log.status).toBeNull()
  })

  it('logs network kind for a generic fetch error, does not throw', async () => {
    captureSterr()
    globalThis.fetch = (async () => {
      throw new Error('some generic network failure')
    }) as unknown as typeof fetch

    await expect(
      postIngest(samplePayload, { url: 'http://localhost:9999', tokenId: '', tokenSecret: '' }),
    ).resolves.toBeUndefined()

    const log = JSON.parse(writes[0].trim())
    expect(log.kind).toBe('network')
    expect(log.status).toBeNull()
    expect(typeof log.err).toBe('string')
  })
})
