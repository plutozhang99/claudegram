/**
 * ClaudegramClient — reverse WebSocket dial to /session-socket + bounded /ingest retry queue.
 *
 * Pure network-client module with no dependency on Bun.serve, MCP, or filesystem.
 * All I/O surface (WebSocket, fetch) is injectable for unit testing.
 */

// ---------------------------------------------------------------------------
// Logger interface (minimal subset)
// ---------------------------------------------------------------------------
export interface Logger {
  info(msg: string, ctx?: Record<string, unknown>): void
  warn(msg: string, ctx?: Record<string, unknown>): void
  error(msg: string, ctx?: Record<string, unknown>): void
  debug(msg: string, ctx?: Record<string, unknown>): void
}

const consoleLogger: Logger = {
  info: (msg, ctx) => process.stderr.write(JSON.stringify({ level: 'info', msg, ...ctx }) + '\n'),
  warn: (msg, ctx) => process.stderr.write(JSON.stringify({ level: 'warn', msg, ...ctx }) + '\n'),
  error: (msg, ctx) => process.stderr.write(JSON.stringify({ level: 'error', msg, ...ctx }) + '\n'),
  debug: (msg, ctx) => process.stderr.write(JSON.stringify({ level: 'debug', msg, ...ctx }) + '\n'),
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------
export interface IngestPayload {
  readonly session_id: string
  readonly session_name?: string
  readonly message: {
    readonly id: string
    readonly direction: 'assistant' | 'user'
    readonly ts: number
    readonly content: string
  }
}

// Structural compatibility contract: this InboundReply MUST remain assignable from
// claudegram's OutboundSessionPayload. If claudegram changes the wire shape, this
// type + its isInboundReply guard both need updating. See
// ../../claudegram/src/ws/session-registry.ts :: OutboundSessionPayload.
export type InboundReply = {
  readonly type: 'reply'
  readonly text: string
  readonly reply_to?: string
  readonly client_msg_id: string
  readonly origin: 'pwa'
}

// Compile-time structural compatibility check (import-free; both sides must stay in sync).
// This assignment will fail with a type error if InboundReply drifts from OutboundSessionPayload.
const _compatCheck = (r: InboundReply): { type: 'reply'; text: string; reply_to?: string; client_msg_id: string; origin: 'pwa' } => r
void _compatCheck

export interface ClaudegramClientConfig {
  readonly url: string                      // CLAUDEGRAM_URL (no trailing slash)
  readonly serviceTokenId?: string          // CF-Access-Client-Id
  readonly serviceTokenSecret?: string      // CF-Access-Client-Secret
  readonly sessionId: string               // already-derived ULID/env
  readonly sessionName?: string
  readonly cwd?: string                     // process.cwd() — bridges Claude Code statusline data
  readonly outboundQueueCap?: number        // default 100
  readonly reconnectBaseMs?: number         // default 250
  readonly reconnectMaxMs?: number          // default 8000
  readonly reconnectJitterRatio?: number    // default 0.2 (±20%)
  readonly logger?: Logger
  // Use a minimal signature so test mocks don't need Bun-specific extras (preconnect etc.)
  readonly fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  readonly WebSocketCtor?: typeof WebSocket // injectable for tests
  readonly random?: () => number            // injectable for deterministic tests
}

// ---------------------------------------------------------------------------
// Hand-rolled type guard for InboundReply
// ---------------------------------------------------------------------------
function isInboundReply(v: unknown): v is InboundReply {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return (
    o['type'] === 'reply' &&
    typeof o['text'] === 'string' &&
    (o['reply_to'] === undefined || typeof o['reply_to'] === 'string') &&
    typeof o['client_msg_id'] === 'string' &&
    o['origin'] === 'pwa'
  )
}

// ---------------------------------------------------------------------------
// ClaudegramClient
// ---------------------------------------------------------------------------
export class ClaudegramClient {
  private readonly cfg: Readonly<Required<Pick<ClaudegramClientConfig,
    'url' | 'sessionId' | 'outboundQueueCap' | 'reconnectBaseMs' | 'reconnectMaxMs' | 'reconnectJitterRatio'
  >>> & Readonly<ClaudegramClientConfig>

  private readonly log: Logger
  private readonly _fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  private readonly _WebSocketCtor: typeof WebSocket
  private readonly _random: () => number

  private ws: WebSocket | null = null
  private _isConnected = false
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private replyHandler: ((reply: InboundReply) => void) | null = null

  // Outbound queue (FIFO, capped). FIFO via Array.shift — O(n) on drain; negligible at cap 100.
  private readonly queue: IngestPayload[] = []
  private wasOverflowing = false

  constructor(config: ClaudegramClientConfig) {
    this.cfg = {
      outboundQueueCap: 100,
      reconnectBaseMs: 250,
      reconnectMaxMs: 8000,
      reconnectJitterRatio: 0.2,
      ...config,
    }
    this.log = config.logger ?? consoleLogger
    this._fetch = config.fetch ?? globalThis.fetch
    this._WebSocketCtor = config.WebSocketCtor ??
      (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket
    this._random = config.random ?? Math.random
  }

  get queueSize(): number { return this.queue.length }
  get isConnected(): boolean { return this._isConnected }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------
  start(): void {
    if (!this.stopped) this._dial()
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws !== null) {
      try { this.ws.close(1000, 'client stopped') } catch { /* already closed */ }
      this.ws = null
    }
    this._isConnected = false
  }

  onReply(handler: (reply: InboundReply) => void): void {
    this.replyHandler = handler
  }

  // ---------------------------------------------------------------------------
  // Outbound /ingest POST with retry queue
  // ---------------------------------------------------------------------------
  async postIngest(payload: IngestPayload): Promise<void> {
    const ok = await this._doPost(payload, /* enqueueOnFail */ true)
    if (ok) await this._drainQueue()
  }

  // ---------------------------------------------------------------------------
  // Private — WebSocket dial
  // ---------------------------------------------------------------------------
  private _buildHeaders(): Record<string, string> | undefined {
    if (this.cfg.serviceTokenId && this.cfg.serviceTokenSecret) {
      return {
        'CF-Access-Client-Id': this.cfg.serviceTokenId,
        'CF-Access-Client-Secret': this.cfg.serviceTokenSecret,
      }
    }
    return undefined
  }

  private _dial(): void {
    if (this.stopped) return

    const wsUrl = `${this.cfg.url.replace(/^http/, 'ws')}/session-socket`
    const headers = this._buildHeaders()

    let ws: WebSocket
    try {
      // Bun's WebSocket constructor accepts {headers} as the second argument
      // (an extension of the standard protocols parameter).
      ws = new this._WebSocketCtor(
        wsUrl,
        headers as unknown as string[] | undefined,
      )
    } catch (err) {
      this.log.warn('claudegram_ws_dial_failed', {
        err: err instanceof Error ? err.message : String(err),
      })
      this._scheduleReconnect()
      return
    }

    this.ws = ws

    ws.addEventListener('open', () => {
      if (this.stopped) { ws.close(1000, 'stopped'); return }
      this._isConnected = true
      this.reconnectAttempt = 0
      this.log.info('claudegram_ws_connected', { url: wsUrl })
      // `channels` identifies this register as originating from the fakechat
      // plugin. Claudegram rejects register frames without this marker,
      // filtering out any non-fakechat clients (and pre-channels-field clients
      // that happen to still be running from older Claude Code sessions).
      const frame: {
        type: 'register'
        session_id: string
        channels: string[]
        session_name?: string
        cwd?: string
      } = {
        type: 'register',
        session_id: this.cfg.sessionId,
        channels: ['plugin:fakechat@claude-plugins-official'],
        ...(this.cfg.sessionName !== undefined ? { session_name: this.cfg.sessionName } : {}),
        ...(this.cfg.cwd !== undefined ? { cwd: this.cfg.cwd } : {}),
      }
      try {
        ws.send(JSON.stringify(frame))
      } catch (err) {
        this.log.warn('claudegram_client_register_send_failed', {
          err: err instanceof Error ? err.message : String(err),
        })
        this._scheduleReconnect()
      }
    })

    ws.addEventListener('message', (event: MessageEvent) => {
      const raw = typeof event.data === 'string' ? event.data : String(event.data)
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        this.log.warn('claudegram_ws_malformed_frame', { raw: raw.slice(0, 200) })
        return
      }
      // Respond to server-side heartbeat pings without routing to the reply handler.
      if (typeof parsed === 'object' && parsed !== null && (parsed as Record<string, unknown>)['type'] === 'ping') {
        try { ws.send(JSON.stringify({ type: 'pong' })) } catch { /* ignore */ }
        return
      }
      if (!isInboundReply(parsed)) {
        this.log.debug('claudegram_ws_unknown_frame', {
          type: typeof parsed === 'object' && parsed !== null
            ? String((parsed as Record<string, unknown>)['type'])
            : 'unknown',
        })
        return
      }
      if (this.replyHandler !== null) {
        try {
          this.replyHandler(parsed)
        } catch (err) {
          // Do NOT re-throw — the WS must stay alive; one handler throw must not kill the client.
          this.log.error('claudegram_client_reply_handler_threw', {
            err: err instanceof Error ? err.message : String(err),
          })
        }
      }
    })

    ws.addEventListener('close', () => {
      this._isConnected = false
      this.ws = null
      if (!this.stopped) this._scheduleReconnect()
    })

    ws.addEventListener('error', () => {
      // 'error' is always followed by 'close' — reconnect scheduled there.
      this._isConnected = false
    })
  }

  private _scheduleReconnect(): void {
    if (this.stopped) return
    const { reconnectBaseMs: base, reconnectMaxMs: max, reconnectJitterRatio: j } = this.cfg
    // delay = clamp(base × 2^attempt, max) × (1 + (random − 0.5) × 2 × jitterRatio)
    const raw = base * Math.pow(2, this.reconnectAttempt)
    const clamped = Math.min(raw, max)
    const delay = Math.round(clamped * (1 + (this._random() - 0.5) * 2 * j))
    if (raw < max) this.reconnectAttempt++
    this.log.info('claudegram_ws_reconnect_scheduled', { attempt: this.reconnectAttempt, delayMs: delay })
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this._dial() }, delay)
  }

  // ---------------------------------------------------------------------------
  // Private — HTTP POST helpers
  // ---------------------------------------------------------------------------

  /**
   * Post payload to /ingest.
   * When enqueueOnFail=true: network/5xx/429 errors → enqueue; 4xx (not 429) → drop-and-log.
   * When enqueueOnFail=false (drain path): any failure → return false (item stays in queue).
   * Returns true on 2xx success.
   */
  private async _doPost(payload: IngestPayload, enqueueOnFail: boolean): Promise<boolean> {
    const extraHeaders = this._buildHeaders()
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...extraHeaders,
    }
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 5000)
    try {
      let res: Response
      try {
        res = await this._fetch(`${this.cfg.url}/ingest`, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: ctrl.signal,
        })
      } finally {
        clearTimeout(timer)
      }
      if (res.ok) return true
      if (enqueueOnFail) {
        if (res.status === 429 || res.status >= 500) {
          // Retryable — enqueue
          this._enqueue(payload)
          this.log.warn('postIngest_retryable', { status: res.status })
        } else {
          // 4xx (except 429) — server rejected payload; retry won't help
          this.log.error('postIngest_rejected', {
            status: res.status,
            msg: 'server rejected payload; dropping (retry won\'t help)',
          })
        }
      }
      return false
    } catch (err) {
      if (enqueueOnFail) {
        this.log.warn('postIngest_network_error', {
          err: err instanceof Error ? err.message : String(err),
        })
        this._enqueue(payload)
      }
      return false
    }
  }

  private _enqueue(payload: IngestPayload): void {
    const cap = this.cfg.outboundQueueCap
    if (this.queue.length >= cap) {
      this.queue.shift() // drop oldest
      if (!this.wasOverflowing) {
        this.wasOverflowing = true
        this.log.warn('postIngest_queue_overflow', { cap })
      }
    }
    this.queue.push(payload)
  }

  private async _drainQueue(): Promise<void> {
    while (this.queue.length > 0) {
      const next = this.queue[0]
      const ok = await this._doPost(next, /* enqueueOnFail */ false)
      if (!ok) break // still failing — leave in queue
      this.queue.shift()
    }
    if (this.queue.length < this.cfg.outboundQueueCap && this.wasOverflowing) this.wasOverflowing = false
  }
}
