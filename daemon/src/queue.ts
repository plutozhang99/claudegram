import { EventEmitter } from 'node:events'
import type {
  Decision,
  DecisionStatus,
  DecisionOption,
  DecisionType,
  PermissionCategory,
  SessionId,
  RequestId,
  ISOTimestamp,
  CreateDecisionRequest,
  Result,
  ErrorResponse,
} from '@claudegram/shared'
import { DEFAULT_TTL_SECONDS, ANSWERED_RETENTION_MS } from '@claudegram/shared'

// ─── Typed event map for DecisionQueue ───────────────────────────────────────

export type DecisionEventMap = {
  created: (decision: Decision) => void
  answered: (decision: Decision) => void
  expired: (decision: Decision) => void
  cancelled: (decision: Decision) => void
}

// ─── Internal mutable representation ─────────────────────────────────────────
// Discriminated union mirroring the public Decision type, so the 'answered'
// branch is the only place where `answer`/`answeredAt` exist. This eliminates
// the unsafe `!` assertions previously needed in `_toDecision`.

interface MutableDecisionBase {
  requestId: RequestId
  sessionId: SessionId
  sessionName: string
  type: DecisionType
  title: string
  description: string
  options: DecisionOption[]
  createdAt: ISOTimestamp
  expiresAt: ISOTimestamp
  /**
   * Permission category — only meaningful when `type === 'permission'`.
   * Mirrors the optional field on the public Decision shape.
   */
  category?: PermissionCategory
}

type MutableDecision =
  | (MutableDecisionBase & { status: 'pending' })
  | (MutableDecisionBase & { status: 'answered'; answer: string; answeredAt: ISOTimestamp })
  | (MutableDecisionBase & { status: 'expired' })
  | (MutableDecisionBase & { status: 'cancelled' })

type Poller = {
  resolve: (d: Decision) => void
  timeoutHandle: ReturnType<typeof setTimeout>
}

const TERMINAL_STATUSES = new Set<DecisionStatus>(['answered', 'expired', 'cancelled'])
const MAX_POLLERS_PER_REQUEST = 5
const MAX_TTL_SECONDS = 3600

export class DecisionQueue {
  private decisions = new Map<RequestId, MutableDecision>()
  private pollers = new Map<RequestId, Poller[]>()
  private ttlTimers = new Map<RequestId, ReturnType<typeof setTimeout>>()
  private cleanupTimers = new Map<RequestId, ReturnType<typeof setTimeout>>()
  private readonly emitter = new EventEmitter()

  // ─── Typed event subscription API ──────────────────────────────────────────
  // Cast to `(...args: unknown[]) => void` is safe because:
  //   1. Node's EventEmitter has no native generic event-map support.
  //   2. `_emit` is the only call site that emits, and it is itself typed by
  //      DecisionEventMap, so listeners only ever receive a Decision.
  // Do not "clean up" this cast without preserving the type guarantee.

  on<K extends keyof DecisionEventMap>(event: K, listener: DecisionEventMap[K]): this {
    this.emitter.on(event, listener as (...args: unknown[]) => void)
    return this
  }

  off<K extends keyof DecisionEventMap>(event: K, listener: DecisionEventMap[K]): this {
    this.emitter.off(event, listener as (...args: unknown[]) => void)
    return this
  }

  /** Emit safely — a synchronous throw in a listener would otherwise propagate
   *  out of timer callbacks (`_expire`) as an uncaught exception and crash the
   *  daemon. Listener errors are logged and swallowed. */
  private _emit<K extends keyof DecisionEventMap>(event: K, decision: Decision): void {
    try {
      this.emitter.emit(event, decision)
    } catch (err) {
      console.error(
        `[DecisionQueue] listener error on '${event}':`,
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  /** Create a new pending decision and start its TTL timer. */
  create(req: CreateDecisionRequest): Result<Decision> {
    if (req.options.length < 2 || req.options.length > 6) {
      const err: ErrorResponse = {
        error: 'VALIDATION_ERROR',
        message: 'options must contain between 2 and 6 items.',
      }
      return { ok: false, error: err }
    }

    const requestId = crypto.randomUUID() as RequestId
    const now = new Date()
    const createdAt = now.toISOString() as ISOTimestamp
    // Defense-in-depth clamp: the HTTP route enforces 10..3600 via zod, but
    // queue.create may be called directly by other code paths (Phase 3 bot,
    // unit tests, future internal callers). Cap at MAX_TTL_SECONDS.
    const requestedTtl = req.ttlSeconds ?? DEFAULT_TTL_SECONDS
    const ttlSeconds = Math.min(requestedTtl, MAX_TTL_SECONDS)
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString() as ISOTimestamp

    const decision: MutableDecision = {
      requestId,
      sessionId: req.sessionId,
      sessionName: req.sessionName,
      type: req.type,
      title: req.title,
      description: req.description,
      options: req.options,
      createdAt,
      expiresAt,
      // Persist optional category so downstream consumers (bot rendering,
      // analytics) don't have to reverse-engineer it from options[].label.
      category: req.category,
      status: 'pending',
    }

    this.decisions.set(requestId, decision)

    const timer = setTimeout(() => {
      this._expire(requestId)
    }, ttlSeconds * 1000)
    this.ttlTimers.set(requestId, timer)

    const created = this._toDecision(decision)
    this._emit('created', created)
    return { ok: true, data: created }
  }

  /** Get a decision by ID. */
  get(requestId: RequestId): Decision | undefined {
    const m = this.decisions.get(requestId)
    if (!m) return undefined
    return this._toDecision(m)
  }

  /** Return all non-deleted decisions (all statuses). */
  getAll(): Decision[] {
    return Array.from(this.decisions.values()).map((m) => this._toDecision(m))
  }

  /** Long-poll: resolves when decision is answered/expired/cancelled, or after timeoutMs.
   *  Option A: signal is accepted here so cleanup is centralised in the queue class. */
  async poll(
    requestId: RequestId,
    timeoutMs = 30_000,
    signal?: AbortSignal,
  ): Promise<Decision | undefined> {
    const m = this.decisions.get(requestId)
    if (!m) return undefined

    if (TERMINAL_STATUSES.has(m.status)) {
      return this._toDecision(m)
    }

    // If the request is already aborted before we start, short-circuit.
    if (signal?.aborted) {
      return this._toDecision(m)
    }

    // Cap concurrent pollers per request to prevent resource exhaustion
    const existingPollers = this.pollers.get(requestId) ?? []
    if (existingPollers.length >= MAX_POLLERS_PER_REQUEST) {
      return this._toDecision(m)
    }

    return new Promise<Decision>((resolve) => {
      // Tracks whether resolve has already fired so all paths are idempotent.
      let settled = false

      const removeThisPoller = (): void => {
        const currentPollers = this.pollers.get(requestId)
        if (currentPollers) {
          const filtered = currentPollers.filter((p) => p.timeoutHandle !== timeoutHandle)
          if (filtered.length === 0) {
            this.pollers.delete(requestId)
          } else {
            this.pollers.set(requestId, filtered)
          }
        }
      }

      // Defined up-front so all resolution paths can detach it. Without this,
      // an abort listener stays attached to the request signal until GC even
      // after a normal timeout/answer resolution — a slow leak.
      const onAbort = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timeoutHandle)
        removeThisPoller()
        const current = this.decisions.get(requestId)
        if (current) {
          resolve(this._toDecision(current))
        } else {
          resolve(this._toDecision({ ...m, status: 'expired' }))
        }
      }

      const detachAbort = (): void => {
        if (signal) {
          signal.removeEventListener('abort', onAbort)
        }
      }

      const timeoutHandle = setTimeout(() => {
        if (settled) return
        settled = true
        detachAbort()
        removeThisPoller()
        // Resolve with whatever the current state is
        const current = this.decisions.get(requestId)
        if (current) {
          resolve(this._toDecision(current))
        } else {
          // Decision was cleaned up; resolve with a synthetic expired view —
          // shouldn't normally happen.
          resolve(this._toDecision({ ...m, status: 'expired' }))
        }
      }, timeoutMs)

      // Wrap the original resolve so _resolvePollers (the answered/cancelled/
      // expired path) also detaches the abort listener. Pollers stored in the
      // map carry this wrapped resolve.
      const wrappedResolve = (decision: Decision): void => {
        if (settled) return
        settled = true
        detachAbort()
        // timeoutHandle is cleared by _resolvePollers; no need to clear here.
        resolve(decision)
      }

      const poller: Poller = { resolve: wrappedResolve, timeoutHandle }
      this.pollers.set(requestId, [...existingPollers, poller])

      // When the client disconnects, remove this poller immediately.
      // All resolution paths (timeout, _resolvePollers, abort) are guarded by
      // the `settled` flag so the listener is a safe no-op if abort fires
      // after another path has already resolved.
      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true })
      }
    })
  }

  /** Submit an answer (called by Telegram callback handler in Phase 3). */
  answer(requestId: RequestId, optionId: string): Result<Decision> {
    const m = this.decisions.get(requestId)
    if (!m) {
      const err: ErrorResponse = {
        error: 'DECISION_NOT_FOUND',
        message: `Decision "${requestId}" not found.`,
      }
      return { ok: false, error: err }
    }

    if (m.status !== 'pending') {
      const err: ErrorResponse = {
        error: 'VALIDATION_ERROR',
        message: `Decision "${requestId}" is not pending (status: ${m.status}).`,
      }
      return { ok: false, error: err }
    }

    const validOption = m.options.find((o) => o.id === optionId)
    if (!validOption) {
      const err: ErrorResponse = {
        error: 'VALIDATION_ERROR',
        message: `Option "${optionId}" is not valid for decision "${requestId}".`,
      }
      return { ok: false, error: err }
    }

    // Clear TTL timer
    const timer = this.ttlTimers.get(requestId)
    if (timer) {
      clearTimeout(timer)
      this.ttlTimers.delete(requestId)
    }

    const answeredAt = new Date().toISOString() as ISOTimestamp
    // Build as a fresh discriminated-union variant; spreading `...m` would keep
    // the wider `status: DecisionStatus` type. Listing fields explicitly gives
    // the compiler the exact 'answered' shape with `answer`/`answeredAt`.
    const updated: MutableDecision = {
      requestId: m.requestId,
      sessionId: m.sessionId,
      sessionName: m.sessionName,
      type: m.type,
      title: m.title,
      description: m.description,
      options: m.options,
      createdAt: m.createdAt,
      expiresAt: m.expiresAt,
      category: m.category,
      status: 'answered',
      answer: optionId,
      answeredAt,
    }
    this.decisions.set(requestId, updated)

    // Resolve all waiting pollers
    this._resolvePollers(requestId)

    // Schedule deletion after retention period
    this._scheduleCleanup(requestId)

    const answeredDecision = this._toDecision(updated)
    this._emit('answered', answeredDecision)
    return { ok: true, data: answeredDecision }
  }

  /** Cancel a decision (DELETE /api/decisions/:requestId). */
  cancel(requestId: RequestId): Result<void> {
    const m = this.decisions.get(requestId)
    if (!m) {
      const err: ErrorResponse = {
        error: 'DECISION_NOT_FOUND',
        message: `Decision "${requestId}" not found.`,
      }
      return { ok: false, error: err }
    }

    // Idempotent — if already terminal, return ok
    if (TERMINAL_STATUSES.has(m.status)) {
      return { ok: true, data: undefined }
    }

    // Clear TTL timer
    const timer = this.ttlTimers.get(requestId)
    if (timer) {
      clearTimeout(timer)
      this.ttlTimers.delete(requestId)
    }

    const updated: MutableDecision = {
      requestId: m.requestId,
      sessionId: m.sessionId,
      sessionName: m.sessionName,
      type: m.type,
      title: m.title,
      description: m.description,
      options: m.options,
      createdAt: m.createdAt,
      expiresAt: m.expiresAt,
      category: m.category,
      status: 'cancelled',
    }
    this.decisions.set(requestId, updated)

    // Resolve all waiting pollers
    this._resolvePollers(requestId)

    // Schedule deletion after retention period
    this._scheduleCleanup(requestId)

    this._emit('cancelled', this._toDecision(updated))
    return { ok: true, data: undefined }
  }

  /** Count of decisions currently in 'pending' status. */
  pendingCount(): number {
    let count = 0
    for (const m of this.decisions.values()) {
      if (m.status === 'pending') count++
    }
    return count
  }

  // Private helpers

  private _expire(requestId: RequestId): void {
    const m = this.decisions.get(requestId)
    if (!m || m.status !== 'pending') return

    const updated: MutableDecision = {
      requestId: m.requestId,
      sessionId: m.sessionId,
      sessionName: m.sessionName,
      type: m.type,
      title: m.title,
      description: m.description,
      options: m.options,
      createdAt: m.createdAt,
      expiresAt: m.expiresAt,
      category: m.category,
      status: 'expired',
    }
    this.decisions.set(requestId, updated)
    this.ttlTimers.delete(requestId)

    this._resolvePollers(requestId)
    this._scheduleCleanup(requestId)

    this._emit('expired', this._toDecision(updated))
  }

  private _resolvePollers(requestId: RequestId): void {
    const waiters = this.pollers.get(requestId)
    if (!waiters) return

    const m = this.decisions.get(requestId)
    if (!m) return

    const decision = this._toDecision(m)
    for (const poller of waiters) {
      clearTimeout(poller.timeoutHandle)
      poller.resolve(decision)
    }

    this.pollers.delete(requestId)
  }

  private _scheduleCleanup(requestId: RequestId): void {
    const handle = setTimeout(() => {
      this.decisions.delete(requestId)
      this.ttlTimers.delete(requestId)
      this.cleanupTimers.delete(requestId)
    }, ANSWERED_RETENTION_MS)
    this.cleanupTimers.set(requestId, handle)
  }

  /** Clear all timers and pollers. Call on daemon shutdown. */
  destroy(): void {
    for (const timer of this.ttlTimers.values()) {
      clearTimeout(timer)
    }
    this.ttlTimers.clear()

    for (const timer of this.cleanupTimers.values()) {
      clearTimeout(timer)
    }
    this.cleanupTimers.clear()

    for (const [requestId, waiters] of this.pollers.entries()) {
      const m = this.decisions.get(requestId)
      for (const poller of waiters) {
        clearTimeout(poller.timeoutHandle)
        if (m) {
          const cancelledView: MutableDecision = {
            requestId: m.requestId,
            sessionId: m.sessionId,
            sessionName: m.sessionName,
            type: m.type,
            title: m.title,
            description: m.description,
            options: m.options,
            createdAt: m.createdAt,
            expiresAt: m.expiresAt,
            category: m.category,
            status: 'cancelled',
          }
          poller.resolve(this._toDecision(cancelledView))
        }
      }
    }
    this.pollers.clear()
  }

  private _toDecision(m: MutableDecision): Decision {
    const base = {
      requestId: m.requestId,
      sessionId: m.sessionId,
      sessionName: m.sessionName,
      type: m.type,
      title: m.title,
      description: m.description,
      options: m.options,
      createdAt: m.createdAt,
      expiresAt: m.expiresAt,
      category: m.category,
    }

    // Discriminated-union narrowing — no non-null assertions needed.
    switch (m.status) {
      case 'answered':
        return {
          ...base,
          status: 'answered',
          answer: m.answer,
          answeredAt: m.answeredAt,
        }
      case 'expired':
        return { ...base, status: 'expired' }
      case 'cancelled':
        return { ...base, status: 'cancelled' }
      case 'pending':
        return { ...base, status: 'pending' }
    }
  }
}
