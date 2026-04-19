import type { ServerWebSocket } from 'bun';
import type { Logger } from '../logger.js';

// ── Payload types ─────────────────────────────────────────────────────────────

export type OutboundSessionPayload = {
  readonly type: 'reply';
  readonly text: string;
  readonly reply_to?: string;
  readonly client_msg_id: string;
  readonly origin: 'pwa';
};

// ── Result types ──────────────────────────────────────────────────────────────

/**
 * Tagged result returned by `send()`.
 *
 * Arms:
 * - `'no_session'`   — no socket is registered for the given session_id.
 * - `'send_failed'`  — ws.send() threw (socket in terminal state).
 * - `'buffer_full'`  — the target socket's `bufferedAmount` exceeds the
 *                      configured cap. This is a backpressure signal; added
 *                      in P2.5 so the user-socket exhaustive switch is ready
 *                      for P3 backpressure work.
 */
export type SendResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'no_session' | 'send_failed' | 'buffer_full' };

/** Tagged result returned by `tryRegister()`. */
export type TryRegisterResult =
  | { readonly ok: true; readonly disposable: Disposable }
  | { readonly ok: false; readonly reason: 'cap_exceeded' };

// ── Interface ─────────────────────────────────────────────────────────────────

export interface SessionRegistry {
  /**
   * Register a WebSocket for the given session_id.
   *
   * If a prior socket is already registered for the same session_id it is
   * evicted: `ws.close(1000, 'evicted by new registration')` is called on it
   * before the map entry is replaced.  This is normal behaviour when fakechat
   * restarts — do NOT treat it as an error.
   *
   * Returns a `Disposable` whose `[Symbol.dispose]()` calls `unregister`.
   */
  register(session_id: string, ws: ServerWebSocket<unknown>): Disposable;

  /**
   * Cap-aware register. Returns `{ ok: false, reason: 'cap_exceeded' }` when
   * the registry is already at `maxConnections` and `session_id` is new.
   * Re-registering an existing session_id (eviction/rebind) is always allowed
   * regardless of cap.
   */
  tryRegister(session_id: string, ws: ServerWebSocket<unknown>): TryRegisterResult;

  /**
   * Send a payload to the socket registered for `session_id`.
   * JSON-serialises the payload exactly once.
   * Returns `{ ok: true }` on success, or a tagged error object on failure.
   */
  send(session_id: string, payload: OutboundSessionPayload): SendResult;

  /** Remove the registration for `session_id` (no-op if not registered). */
  unregister(session_id: string): void;

  /** Returns true if a socket is currently registered for session_id. */
  has(session_id: string): boolean;

  /** Number of currently registered sessions. */
  readonly size: number;
}

// ── Implementation ────────────────────────────────────────────────────────────

export class InMemorySessionRegistry implements SessionRegistry {
  private readonly sockets = new Map<string, ServerWebSocket<unknown>>();
  private readonly maxConnections: number;
  private readonly outboundBufferCapBytes: number;
  /** Optional injected logger — falls back to console.warn for test ergonomics. */
  private readonly logger: Logger | undefined;

  constructor(maxConnections = 64, outboundBufferCapBytes = 1_048_576, logger?: Logger) {
    this.maxConnections = maxConnections;
    this.outboundBufferCapBytes = outboundBufferCapBytes;
    this.logger = logger;
  }

  /** Warn via injected logger, falling back to console.warn when logger is not injected. */
  private warn(msg: string, fields?: Record<string, unknown>): void {
    if (this.logger !== undefined) {
      this.logger.warn(msg, fields);
    } else {
      // Fallback for tests that do not inject a logger.
      console.warn(`[SessionRegistry] ${msg}`, fields ?? '');
    }
  }

  register(session_id: string, ws: ServerWebSocket<unknown>): Disposable {
    const existing = this.sockets.get(session_id);
    if (existing !== undefined) {
      try {
        existing.close(1000, 'evicted by new registration');
      } catch (err) {
        // Mirror hub.ts:33-36 — socket may already be in terminal state. Log and proceed.
        this.warn('session_registry_eviction_close_failed', {
          session_id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    this.sockets.set(session_id, ws);

    let disposed = false;
    const registeredWs = ws; // capture at registration time
    return {
      [Symbol.dispose]: () => {
        if (disposed) return;
        disposed = true;
        if (this.sockets.get(session_id) === registeredWs) {
          this.sockets.delete(session_id);
        }
      },
    };
  }

  tryRegister(session_id: string, ws: ServerWebSocket<unknown>): TryRegisterResult {
    // Re-registering an existing session_id (eviction/rebind) is always allowed.
    const isRebind = this.sockets.has(session_id);
    if (!isRebind && this.sockets.size >= this.maxConnections) {
      return { ok: false, reason: 'cap_exceeded' };
    }
    const disposable = this.register(session_id, ws);
    return { ok: true, disposable };
  }

  send(session_id: string, payload: OutboundSessionPayload): SendResult {
    const ws = this.sockets.get(session_id);
    if (ws === undefined) return { ok: false, reason: 'no_session' };

    // HIGH 2 fix: wrap getBufferedAmount() in its own try/catch — Bun's behaviour
    // when called on a socket in terminal state is implementation-defined and may throw.
    let bufferedAmount: number;
    try {
      bufferedAmount = ws.getBufferedAmount();
    } catch (err) {
      this.warn('session_registry_get_buffered_amount_failed', {
        session_id,
        err: err instanceof Error ? err.message : String(err),
      });
      return { ok: false, reason: 'send_failed' };
    }

    // Backpressure check: if the socket's send buffer is over cap, signal buffer_full.
    // This consolidates the bufferedAmount check from the route layer into the registry
    // so callers get a uniform tagged result instead of checking bufferedAmount manually.
    if (bufferedAmount > this.outboundBufferCapBytes) {
      this.warn('session_registry_buffer_full', { session_id, bufferedAmount });
      return { ok: false, reason: 'buffer_full' };
    }

    const text = JSON.stringify(payload);
    try {
      ws.send(text);
      return { ok: true };
    } catch (err) {
      this.warn('session_registry_send_failed', {
        session_id,
        err: err instanceof Error ? err.message : String(err),
      });
      return { ok: false, reason: 'send_failed' };
    }
  }

  unregister(session_id: string): void {
    this.sockets.delete(session_id);
  }

  has(session_id: string): boolean {
    return this.sockets.has(session_id);
  }

  get size(): number {
    return this.sockets.size;
  }
}
