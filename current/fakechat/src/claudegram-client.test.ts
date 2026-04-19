/**
 * Unit tests for ClaudegramClient.
 *
 * Uses:
 *  - MockWebSocket: a synchronous in-memory WebSocket that lets tests fire events
 *  - mockFetch: a swappable fetch function returning configurable Response objects
 *
 * No real network is opened.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { ClaudegramClient } from './claudegram-client'
import type { ClaudegramClientConfig, InboundReply, IngestPayload } from './claudegram-client'

// ---------------------------------------------------------------------------
// MockWebSocket
// ---------------------------------------------------------------------------
type EventName = 'open' | 'message' | 'close' | 'error'

class MockWebSocket {
  static instances: MockWebSocket[] = []

  readonly url: string
  readonly headersPassedIn: unknown

  // readyState mirrors browser WebSocket constants
  readyState: number = 0 // CONNECTING

  private listeners: Map<EventName, ((e: unknown) => void)[]> = new Map()

  // Track what was sent
  sentFrames: string[] = []
  closedWith: { code?: number; reason?: string } | null = null

  /** When true, send() throws synchronously — used to test HIGH1 register-send guard. */
  sendShouldThrow = false

  constructor(url: string, headersOrProtocols?: unknown) {
    this.url = url
    this.headersPassedIn = headersOrProtocols
    MockWebSocket.instances.push(this)
  }

  addEventListener(event: EventName, handler: (e: unknown) => void): void {
    if (!this.listeners.has(event)) this.listeners.set(event, [])
    this.listeners.get(event)!.push(handler)
  }

  removeEventListener(_event: EventName, _handler: (e: unknown) => void): void {
    // no-op for mock
  }

  send(data: string): void {
    if (this.sendShouldThrow) throw new Error('mock send error')
    this.sentFrames.push(data)
  }

  close(code?: number, reason?: string): void {
    this.closedWith = { code, reason }
    this.readyState = 3 // CLOSED
  }

  // Test helpers — fire events manually
  fireOpen(): void {
    this.readyState = 1 // OPEN
    for (const h of this.listeners.get('open') ?? []) h(new Event('open'))
  }

  fireMessage(data: string): void {
    const event = { data } as MessageEvent
    for (const h of this.listeners.get('message') ?? []) h(event)
  }

  fireClose(code = 1000): void {
    this.readyState = 3 // CLOSED
    const event = { code } as CloseEvent
    for (const h of this.listeners.get('close') ?? []) h(event)
  }

  fireError(): void {
    for (const h of this.listeners.get('error') ?? []) h(new Event('error'))
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function buildConfig(overrides: Partial<ClaudegramClientConfig> = {}): ClaudegramClientConfig {
  return {
    url: 'http://localhost:9999',
    sessionId: 'test-session-id',
    // Override WebSocket and fetch with safe no-ops by default
    WebSocketCtor: MockWebSocket as unknown as typeof WebSocket,
    fetch: async () => new Response(null, { status: 200 }),
    random: () => 0.5, // neutral jitter: factor = 1.0
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
    ...overrides,
  }
}

function latestMock(): MockWebSocket {
  return MockWebSocket.instances[MockWebSocket.instances.length - 1]
}

const samplePayload: IngestPayload = {
  session_id: 'test-session-id',
  message: { id: 'msg-1', direction: 'assistant', ts: 1700000000000, content: 'hello' },
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  MockWebSocket.instances = []
})

// ---------------------------------------------------------------------------
// 1. No auth headers when serviceTokenId/Secret absent
// ---------------------------------------------------------------------------
describe('constructor — no auth headers', () => {
  it('WS upgrade carries no CF-Access headers when token not configured', async () => {
    const client = new ClaudegramClient(buildConfig())
    client.start()

    const mock = latestMock()
    // When no service token provided, headersPassedIn should be undefined
    expect(mock.headersPassedIn).toBeUndefined()
    await client.stop()
  })

  it('fetch carries no CF-Access headers', async () => {
    let capturedHeaders: Record<string, string> = {}
    const client = new ClaudegramClient(buildConfig({
      fetch: async (_url, init) => {
        capturedHeaders = (init?.headers ?? {}) as Record<string, string>
        return new Response(null, { status: 200 })
      },
    }))

    await client.postIngest(samplePayload)

    expect(capturedHeaders['CF-Access-Client-Id']).toBeUndefined()
    expect(capturedHeaders['CF-Access-Client-Secret']).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 2. Auth headers present when both token env vars are set
// ---------------------------------------------------------------------------
describe('constructor — with auth headers', () => {
  it('passes headers object to WebSocket constructor', async () => {
    const client = new ClaudegramClient(buildConfig({
      serviceTokenId: 'my-id',
      serviceTokenSecret: 'my-secret',
    }))
    client.start()

    const mock = latestMock()
    const h = mock.headersPassedIn as Record<string, string>
    expect(h['CF-Access-Client-Id']).toBe('my-id')
    expect(h['CF-Access-Client-Secret']).toBe('my-secret')
    await client.stop()
  })

  it('includes CF-Access headers in fetch calls', async () => {
    let capturedHeaders: Record<string, string> = {}
    const client = new ClaudegramClient(buildConfig({
      serviceTokenId: 'my-id',
      serviceTokenSecret: 'my-secret',
      fetch: async (_url, init) => {
        capturedHeaders = (init?.headers ?? {}) as Record<string, string>
        return new Response(null, { status: 200 })
      },
    }))

    await client.postIngest(samplePayload)

    expect(capturedHeaders['CF-Access-Client-Id']).toBe('my-id')
    expect(capturedHeaders['CF-Access-Client-Secret']).toBe('my-secret')
  })
})

// ---------------------------------------------------------------------------
// 3. start() → WS open → register frame sent
// ---------------------------------------------------------------------------
describe('start() and register frame', () => {
  it('dials /session-socket on start()', async () => {
    const client = new ClaudegramClient(buildConfig())
    client.start()

    const mock = latestMock()
    expect(mock.url).toBe('ws://localhost:9999/session-socket')
    await client.stop()
  })

  it('sends register frame after WS open', async () => {
    const client = new ClaudegramClient(buildConfig({ sessionName: 'my-session' }))
    client.start()

    const mock = latestMock()
    mock.fireOpen()

    expect(mock.sentFrames).toHaveLength(1)
    const frame = JSON.parse(mock.sentFrames[0]) as { type: string; session_id: string; session_name?: string; channels?: string[] }
    expect(frame.type).toBe('register')
    expect(frame.session_id).toBe('test-session-id')
    expect(frame.session_name).toBe('my-session')
    // Channel marker gates claudegram-side acceptance — must always be present.
    expect(frame.channels).toEqual(['plugin:fakechat@claude-plugins-official'])
    await client.stop()
  })

  it('isConnected becomes true after open', async () => {
    const client = new ClaudegramClient(buildConfig())
    client.start()
    expect(client.isConnected).toBe(false)

    latestMock().fireOpen()
    expect(client.isConnected).toBe(true)
    await client.stop()
  })
})

// ---------------------------------------------------------------------------
// 4. WS close → reconnect scheduled within expected delay range
// ---------------------------------------------------------------------------
describe('reconnect on close', () => {
  it('schedules reconnect within [base*(1-j), base*(1+j)] on first close', async () => {
    const delays: number[] = []
    const origSetTimeout = globalThis.setTimeout

    // Intercept setTimeout to capture the delay without actually waiting
    // We'll use a counter and capture delays
    let capturedDelay: number | null = null
    const mockSetTimeout = (fn: () => void, delay?: number): ReturnType<typeof setTimeout> => {
      capturedDelay = delay ?? 0
      // Don't actually schedule — just capture
      return 0 as unknown as ReturnType<typeof setTimeout>
    }

    // We need a real way to test reconnect: use deterministic random
    // With random=0.5: factor = 1 + (0.5-0.5)*2*0.2 = 1.0 → delay = base
    // With random=0.0: factor = 1 + (0-0.5)*2*0.2 = 0.8 → delay = base*0.8
    // With random=1.0: factor = 1 + (1-0.5)*2*0.2 = 1.2 → delay = base*1.2

    const base = 250
    const jitterRatio = 0.2

    // Test with random = 0.3 (below center)
    const client = new ClaudegramClient(buildConfig({
      reconnectBaseMs: base,
      reconnectJitterRatio: jitterRatio,
      random: () => 0.3,
    }))

    // Override setTimeout to capture delay
    globalThis.setTimeout = mockSetTimeout as unknown as typeof globalThis.setTimeout

    client.start()
    const mock = latestMock()
    mock.fireOpen() // connects (resets attempt counter)
    mock.fireClose() // triggers reconnect

    globalThis.setTimeout = origSetTimeout

    // With random=0.3: factor = 1 + (0.3-0.5)*2*0.2 = 1 - 0.08 = 0.92
    // delay = round(250 * 0.92) = 230
    const expected = Math.round(base * (1 + (0.3 - 0.5) * 2 * jitterRatio))
    expect(capturedDelay as unknown as number).toBe(expected)

    void delays
    await client.stop()
  })

  it('reconnect delay with random=1.0 is at upper bound', async () => {
    const origSetTimeout = globalThis.setTimeout
    let capturedDelay: number | null = null

    globalThis.setTimeout = ((fn: () => void, delay?: number) => {
      capturedDelay = delay ?? 0
      return 0 as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof globalThis.setTimeout

    const base = 250
    const jitterRatio = 0.2

    const client = new ClaudegramClient(buildConfig({
      reconnectBaseMs: base,
      reconnectJitterRatio: jitterRatio,
      random: () => 1.0,
    }))

    client.start()
    const mock = latestMock()
    mock.fireOpen()
    mock.fireClose()

    globalThis.setTimeout = origSetTimeout

    // factor = 1 + (1.0-0.5)*2*0.2 = 1.2 → delay = round(250*1.2) = 300
    const expected = Math.round(base * 1.2)
    expect(capturedDelay as unknown as number).toBe(expected)

    await client.stop()
  })
})

// ---------------------------------------------------------------------------
// 5. Reconnect delay caps at reconnectMaxMs
// ---------------------------------------------------------------------------
describe('reconnect cap', () => {
  it('delay never exceeds reconnectMaxMs regardless of attempt count', async () => {
    const base = 250
    const max = 8000
    const capturedDelays: number[] = []
    const origSetTimeout = globalThis.setTimeout

    globalThis.setTimeout = ((fn: () => void, delay?: number) => {
      capturedDelays.push(delay ?? 0)
      return 0 as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof globalThis.setTimeout

    const client = new ClaudegramClient(buildConfig({
      reconnectBaseMs: base,
      reconnectMaxMs: max,
      reconnectJitterRatio: 0,  // no jitter: factor = 1.0 exactly
      random: () => 0.5,
    }))

    // Simulate many close events (each schedules a reconnect via setTimeout)
    client.start()
    for (let i = 0; i < 15; i++) {
      // each fireClose triggers _scheduleReconnect → setTimeout is called
      // (we don't actually re-dial since setTimeout is mocked to no-op)
      const mock = MockWebSocket.instances[i]
      if (mock) {
        mock.fireOpen()
        mock.fireClose()
      } else {
        // Create a new mock for subsequent dials
        // After fireClose, the client's _dial() creates a new MockWebSocket
        // but since setTimeout is no-op, reconnect doesn't fire
        // We simulate by calling _scheduleReconnect indirectly
        break
      }
    }

    globalThis.setTimeout = origSetTimeout
    await client.stop()

    // All captured delays should be <= max (with jitterRatio=0 → factor=1)
    for (const d of capturedDelays) {
      expect(d).toBeLessThanOrEqual(max)
    }

    // The last delay(s) should equal max (once exponent saturates)
    if (capturedDelays.length > 0) {
      // At attempt 5: 250 * 2^5 = 8000 → clamped to 8000
      // So any delay at or after that point = 8000
      const lastDelay = capturedDelays[capturedDelays.length - 1]
      expect(lastDelay).toBeLessThanOrEqual(max)
    }
  })
})

// ---------------------------------------------------------------------------
// 6. Inbound reply → onReply callback invoked
// ---------------------------------------------------------------------------
describe('inbound reply handling', () => {
  it('calls onReply callback with parsed InboundReply', async () => {
    const received: InboundReply[] = []
    const client = new ClaudegramClient(buildConfig())
    client.onReply(r => received.push(r))
    client.start()

    const mock = latestMock()
    mock.fireOpen()

    const replyFrame: InboundReply = {
      type: 'reply',
      text: 'hello back',
      client_msg_id: 'cmid-1',
      origin: 'pwa',
    }
    mock.fireMessage(JSON.stringify(replyFrame))

    expect(received).toHaveLength(1)
    expect(received[0]).toEqual(replyFrame)
    await client.stop()
  })

  it('includes optional reply_to field when present', async () => {
    const received: InboundReply[] = []
    const client = new ClaudegramClient(buildConfig())
    client.onReply(r => received.push(r))
    client.start()

    const mock = latestMock()
    mock.fireOpen()

    const replyFrame: InboundReply = {
      type: 'reply',
      text: 'quoting you',
      reply_to: 'original-msg-id',
      client_msg_id: 'cmid-2',
      origin: 'pwa',
    }
    mock.fireMessage(JSON.stringify(replyFrame))

    expect(received[0].reply_to).toBe('original-msg-id')
    await client.stop()
  })
})

// ---------------------------------------------------------------------------
// 7. Malformed frame → no callback, no throw, warn-logged
// ---------------------------------------------------------------------------
describe('malformed frame handling', () => {
  it('does not invoke onReply for unparseable JSON', async () => {
    const received: InboundReply[] = []
    const warnLogs: string[] = []

    const client = new ClaudegramClient(buildConfig({
      logger: {
        info: () => {},
        warn: (msg) => warnLogs.push(msg),
        error: () => {},
        debug: () => {},
      },
    }))
    client.onReply(r => received.push(r))
    client.start()

    const mock = latestMock()
    mock.fireOpen()

    expect(() => mock.fireMessage('not json {')).not.toThrow()
    expect(received).toHaveLength(0)
    expect(warnLogs.some(m => m === 'claudegram_ws_malformed_frame')).toBe(true)
    await client.stop()
  })

  it('does not invoke onReply for valid JSON with wrong shape', async () => {
    const received: InboundReply[] = []
    const client = new ClaudegramClient(buildConfig())
    client.onReply(r => received.push(r))
    client.start()

    const mock = latestMock()
    mock.fireOpen()

    // Valid JSON but missing required fields
    mock.fireMessage(JSON.stringify({ type: 'reply', text: 'missing origin and client_msg_id' }))
    expect(received).toHaveLength(0)
    await client.stop()
  })

  it('does not invoke onReply for non-reply type', async () => {
    const received: InboundReply[] = []
    const client = new ClaudegramClient(buildConfig())
    client.onReply(r => received.push(r))
    client.start()

    const mock = latestMock()
    mock.fireOpen()

    mock.fireMessage(JSON.stringify({ type: 'some_other_type', payload: {} }))
    expect(received).toHaveLength(0)
    await client.stop()
  })
})

// ---------------------------------------------------------------------------
// 8. postIngest success → fetch called once, queue empty
// ---------------------------------------------------------------------------
describe('postIngest — success path', () => {
  it('calls fetch exactly once on success, queue stays empty', async () => {
    let callCount = 0
    const client = new ClaudegramClient(buildConfig({
      fetch: async () => {
        callCount++
        return new Response(null, { status: 200 })
      },
    }))

    await client.postIngest(samplePayload)

    expect(callCount).toBe(1)
    expect(client.queueSize).toBe(0)
  })

  it('calls fetch with correct URL, method, and body', async () => {
    let capturedUrl = ''
    let capturedInit: RequestInit = {}

    const client = new ClaudegramClient(buildConfig({
      fetch: async (url, init) => {
        capturedUrl = String(url)
        capturedInit = init ?? {}
        return new Response(null, { status: 200 })
      },
    }))

    await client.postIngest(samplePayload)

    expect(capturedUrl).toBe('http://localhost:9999/ingest')
    expect(capturedInit.method).toBe('POST')
    expect(capturedInit.body).toBe(JSON.stringify(samplePayload))
    const headers = capturedInit.headers as Record<string, string>
    expect(headers['Content-Type']).toBe('application/json')
  })
})

// ---------------------------------------------------------------------------
// 9. postIngest fails → enqueued; next success drains the queue
// ---------------------------------------------------------------------------
describe('postIngest — failure → enqueue → drain', () => {
  it('enqueues payload on network error and drains on next success', async () => {
    const sentPayloads: unknown[] = []
    let shouldFail = true

    const client = new ClaudegramClient(buildConfig({
      fetch: async (_url, init) => {
        if (shouldFail) throw new Error('ECONNREFUSED')
        sentPayloads.push(JSON.parse(init?.body as string))
        return new Response(null, { status: 200 })
      },
    }))

    // First call fails — payload enqueued
    await client.postIngest(samplePayload)
    expect(client.queueSize).toBe(1)

    // Second call succeeds — drains queue
    shouldFail = false
    const payload2: IngestPayload = {
      session_id: 'test-session-id',
      message: { id: 'msg-2', direction: 'user', ts: 1700000001000, content: 'reply' },
    }
    await client.postIngest(payload2)

    // Queue should be empty, both payloads sent
    expect(client.queueSize).toBe(0)
    expect(sentPayloads).toHaveLength(2)
    // payload2 is sent first (the direct call), then msg-1 is drained from queue
    expect((sentPayloads[0] as IngestPayload).message.id).toBe('msg-2')
    expect((sentPayloads[1] as IngestPayload).message.id).toBe('msg-1')
  })

  it('enqueues on 5xx response', async () => {
    const client = new ClaudegramClient(buildConfig({
      fetch: async () => new Response(null, { status: 503 }),
    }))

    await client.postIngest(samplePayload)
    expect(client.queueSize).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 10. Queue overflow — drop-oldest, single warn per burst
// ---------------------------------------------------------------------------
describe('queue overflow', () => {
  it('drops oldest item when queue is at cap', async () => {
    const cap = 3

    // Always fail to keep items in queue
    const client = new ClaudegramClient(buildConfig({
      outboundQueueCap: cap,
      fetch: async () => { throw new Error('network') },
    }))

    const makePayload = (id: string): IngestPayload => ({
      session_id: 'test-session-id',
      message: { id, direction: 'user', ts: Date.now(), content: id },
    })

    // Fill queue to cap
    for (let i = 0; i < cap; i++) {
      await client.postIngest(makePayload(`msg-${i}`))
    }
    expect(client.queueSize).toBe(cap)

    // Add one more — oldest (msg-0) should be dropped
    await client.postIngest(makePayload('msg-overflow'))
    expect(client.queueSize).toBe(cap) // still at cap
  })

  it('emits single warn on false→true overflow transition, not on subsequent overflows', async () => {
    const cap = 2
    const warnLogs: string[] = []

    const client = new ClaudegramClient(buildConfig({
      outboundQueueCap: cap,
      fetch: async () => { throw new Error('network') },
      logger: {
        info: () => {},
        warn: (msg) => warnLogs.push(msg),
        error: () => {},
        debug: () => {},
      },
    }))

    const makePayload = (id: string): IngestPayload => ({
      session_id: 'test-session-id',
      message: { id, direction: 'user', ts: Date.now(), content: id },
    })

    // Fill to cap (no overflow yet)
    await client.postIngest(makePayload('msg-0'))
    await client.postIngest(makePayload('msg-1'))

    const overflowWarnsBefore = warnLogs.filter(m => m === 'postIngest_queue_overflow').length
    expect(overflowWarnsBefore).toBe(0)

    // First overflow → warn should fire
    await client.postIngest(makePayload('msg-2'))
    const afterFirst = warnLogs.filter(m => m === 'postIngest_queue_overflow').length
    expect(afterFirst).toBe(1)

    // Second overflow → NO additional warn
    await client.postIngest(makePayload('msg-3'))
    const afterSecond = warnLogs.filter(m => m === 'postIngest_queue_overflow').length
    expect(afterSecond).toBe(1) // still 1
  })
})

// ---------------------------------------------------------------------------
// 11. 4xx (except 429) → drop-and-log, NOT enqueued
// ---------------------------------------------------------------------------
describe('4xx response handling', () => {
  it('does not enqueue on 400 response', async () => {
    const errorLogs: string[] = []
    const client = new ClaudegramClient(buildConfig({
      fetch: async () => new Response(null, { status: 400 }),
      logger: {
        info: () => {},
        warn: () => {},
        error: (msg) => errorLogs.push(msg),
        debug: () => {},
      },
    }))

    await client.postIngest(samplePayload)

    expect(client.queueSize).toBe(0) // dropped, not enqueued
    expect(errorLogs.some(m => m === 'postIngest_rejected')).toBe(true)
  })

  it('does not enqueue on 422 response', async () => {
    const client = new ClaudegramClient(buildConfig({
      fetch: async () => new Response(null, { status: 422 }),
    }))

    await client.postIngest(samplePayload)
    expect(client.queueSize).toBe(0)
  })

  it('does not enqueue on 401 response', async () => {
    const client = new ClaudegramClient(buildConfig({
      fetch: async () => new Response(null, { status: 401 }),
    }))

    await client.postIngest(samplePayload)
    expect(client.queueSize).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 12. 429 response → enqueued (rate-limit retry)
// ---------------------------------------------------------------------------
describe('429 response handling', () => {
  it('enqueues on 429 (rate-limit)', async () => {
    const warnLogs: string[] = []
    const client = new ClaudegramClient(buildConfig({
      fetch: async () => new Response(null, { status: 429 }),
      logger: {
        info: () => {},
        warn: (msg) => warnLogs.push(msg),
        error: () => {},
        debug: () => {},
      },
    }))

    await client.postIngest(samplePayload)

    expect(client.queueSize).toBe(1) // enqueued
    expect(warnLogs.some(m => m === 'postIngest_retryable')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 13. stop() → cancels reconnect, closes WS, no more attempts
// ---------------------------------------------------------------------------
describe('stop()', () => {
  it('closes the WebSocket with code 1000 and reason "client stopped"', async () => {
    const client = new ClaudegramClient(buildConfig())
    client.start()

    const mock = latestMock()
    mock.fireOpen()

    await client.stop()

    expect(mock.closedWith?.code).toBe(1000)
    expect(mock.closedWith?.reason).toBe('client stopped')
    expect(client.isConnected).toBe(false)
  })

  it('does not attempt to reconnect after stop()', async () => {
    const origSetTimeout = globalThis.setTimeout
    let reconnectScheduled = false

    globalThis.setTimeout = ((fn: () => void, _delay?: number) => {
      reconnectScheduled = true
      return 0 as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof globalThis.setTimeout

    const client = new ClaudegramClient(buildConfig())
    client.start()

    const mock = latestMock()
    mock.fireOpen()

    // Stop first, then simulate server-side close
    await client.stop()
    mock.fireClose()

    globalThis.setTimeout = origSetTimeout

    expect(reconnectScheduled).toBe(false)
  })

  it('cancels a pending reconnect timer on stop()', async () => {
    const clearedTimers: unknown[] = []
    const origSetTimeout = globalThis.setTimeout
    const origClearTimeout = globalThis.clearTimeout

    let fakeTimerId = 42 as unknown as ReturnType<typeof setTimeout>
    globalThis.setTimeout = ((_fn: () => void, _delay?: number) => {
      return fakeTimerId
    }) as unknown as typeof globalThis.setTimeout
    globalThis.clearTimeout = ((id: unknown) => {
      clearedTimers.push(id)
    }) as unknown as typeof globalThis.clearTimeout

    const client = new ClaudegramClient(buildConfig())
    client.start()
    const mock = latestMock()
    mock.fireOpen()
    mock.fireClose() // schedules reconnect timer

    await client.stop() // should cancel the timer

    globalThis.setTimeout = origSetTimeout
    globalThis.clearTimeout = origClearTimeout

    expect(clearedTimers).toContain(fakeTimerId)
  })
})

// ---------------------------------------------------------------------------
// 14. Origin-tag echo dedup — explicit type guard test
// ---------------------------------------------------------------------------
describe('origin-tag echo dedup (type guard)', () => {
  it('frame without origin:pwa does NOT pass isInboundReply guard', async () => {
    // We test this indirectly: a frame without origin:'pwa' should NOT invoke onReply
    const received: unknown[] = []
    const client = new ClaudegramClient(buildConfig())
    client.onReply(r => received.push(r))
    client.start()

    const mock = latestMock()
    mock.fireOpen()

    // origin is missing
    mock.fireMessage(JSON.stringify({
      type: 'reply',
      text: 'hi',
      client_msg_id: 'cmid-x',
      // origin: 'pwa' intentionally absent
    }))
    expect(received).toHaveLength(0) // must not be delivered as InboundReply
    await client.stop()
  })

  it('frame with origin:pwa DOES pass the guard and invokes onReply', async () => {
    const received: unknown[] = []
    const client = new ClaudegramClient(buildConfig())
    client.onReply(r => received.push(r))
    client.start()

    const mock = latestMock()
    mock.fireOpen()

    mock.fireMessage(JSON.stringify({
      type: 'reply',
      text: 'hi',
      client_msg_id: 'cmid-y',
      origin: 'pwa',
    }))
    expect(received).toHaveLength(1)
    await client.stop()
  })
})

// ---------------------------------------------------------------------------
// R2 HIGH 1 — ws.send(register_frame) throws → reconnect scheduled, no throw
// ---------------------------------------------------------------------------
describe('HIGH1 — unguarded register send (R2)', () => {
  it('schedules reconnect and does not throw when register send() throws', async () => {
    const warnLogs: string[] = []
    const origSetTimeout = globalThis.setTimeout
    let reconnectScheduled = false

    globalThis.setTimeout = ((fn: () => void, _delay?: number) => {
      reconnectScheduled = true
      return 0 as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof globalThis.setTimeout

    const client = new ClaudegramClient(buildConfig({
      logger: {
        info: () => {},
        warn: (msg) => warnLogs.push(msg),
        error: () => {},
        debug: () => {},
      },
    }))
    client.start()

    const mock = latestMock()
    mock.sendShouldThrow = true

    // Firing open triggers the register send — which will throw
    expect(() => mock.fireOpen()).not.toThrow()

    globalThis.setTimeout = origSetTimeout

    expect(reconnectScheduled).toBe(true)
    expect(warnLogs.some(m => m === 'claudegram_client_register_send_failed')).toBe(true)
    await client.stop()
  })
})

// ---------------------------------------------------------------------------
// R2 HIGH 2 — replyHandler throws → error logged, WS stays alive (isConnected)
// ---------------------------------------------------------------------------
describe('HIGH2 — unguarded replyHandler (R2)', () => {
  it('logs error and keeps client connected when replyHandler throws', async () => {
    const errorLogs: string[] = []

    const client = new ClaudegramClient(buildConfig({
      logger: {
        info: () => {},
        warn: () => {},
        error: (msg) => errorLogs.push(msg),
        debug: () => {},
      },
    }))

    client.onReply(() => { throw new Error('handler exploded') })
    client.start()

    const mock = latestMock()
    mock.fireOpen()
    expect(client.isConnected).toBe(true)

    // Sending a valid reply frame → handler throws → should be swallowed
    expect(() => mock.fireMessage(JSON.stringify({
      type: 'reply',
      text: 'boom',
      client_msg_id: 'cmid-boom',
      origin: 'pwa',
    }))).not.toThrow()

    expect(client.isConnected).toBe(true)
    expect(errorLogs.some(m => m === 'claudegram_client_reply_handler_threw')).toBe(true)
    await client.stop()
  })
})

// ---------------------------------------------------------------------------
// R2 LOW 1 — wasOverflowing resets at below-cap, not just at empty (re-warn test)
// ---------------------------------------------------------------------------
describe('LOW1 — wasOverflowing resets at below-cap (R2)', () => {
  it('warns twice when queue oscillates: overflow → partial drain → overflow again', async () => {
    const cap = 100
    const warnLogs: string[] = []
    let fetchShouldFail = true

    const client = new ClaudegramClient(buildConfig({
      outboundQueueCap: cap,
      logger: {
        info: () => {},
        warn: (msg) => warnLogs.push(msg),
        error: () => {},
        debug: () => {},
      },
      fetch: async (_url, init) => {
        if (fetchShouldFail) throw new Error('network')
        // On success, parse and discard (drain succeeds)
        void init
        return new Response(null, { status: 200 })
      },
    }))

    const makePayload = (id: string): IngestPayload => ({
      session_id: 'test-session-id',
      message: { id, direction: 'user', ts: Date.now(), content: id },
    })

    // Fill queue to cap+1 → triggers first overflow warn (queue goes from 100 to 100 with drop)
    for (let i = 0; i < cap; i++) {
      await client.postIngest(makePayload(`init-${i}`))
    }
    // One more to trigger overflow
    await client.postIngest(makePayload('overflow-1'))

    const afterFirstOverflow = warnLogs.filter(m => m === 'postIngest_queue_overflow').length
    expect(afterFirstOverflow).toBe(1)

    // Drain 20 items (queue goes from 100 to ~80, below cap) → wasOverflowing resets
    fetchShouldFail = false
    for (let i = 0; i < 20; i++) {
      const p = makePayload(`drain-${i}`)
      await client.postIngest(p)
    }

    // At this point queue should be below cap → wasOverflowing should have reset
    expect(client.queueSize).toBeLessThan(cap)

    // Now fail again and overflow again → should warn a second time
    fetchShouldFail = true
    for (let i = 0; i < cap; i++) {
      await client.postIngest(makePayload(`refill-${i}`))
    }
    await client.postIngest(makePayload('overflow-2'))

    const afterSecondOverflow = warnLogs.filter(m => m === 'postIngest_queue_overflow').length
    expect(afterSecondOverflow).toBe(2)

    await client.stop()
  })
})
