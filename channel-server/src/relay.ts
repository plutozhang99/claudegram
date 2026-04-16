/**
 * relay.ts — Pure HTTP client functions for daemon communication.
 *
 * All functions return a typed Result — they NEVER throw.  Errors are
 * classified into four kinds so callers can produce actionable log messages
 * and denial reasons without inspecting raw Error objects.
 *
 * Design notes:
 * - Uses Bun's built-in `fetch`; no external HTTP library needed.
 * - No retries inside relay.  handlePermission may retry with bounded delay.
 * - AbortSignal is propagated directly to fetch() so the daemon long-poll is
 *   cancelled when the caller is done.
 */

import type {
  Decision,
  CreateDecisionRequest,
  RequestId,
  Result,
} from '@claudegram/shared'

// ─── Error types ──────────────────────────────────────────────────────────────

export type RelayError =
  | { readonly kind: 'network'; readonly message: string }
  | { readonly kind: 'http'; readonly status: number; readonly body: string }
  | { readonly kind: 'parse'; readonly message: string }
  | { readonly kind: 'timeout'; readonly message: string }

// ─── DaemonClient interface ───────────────────────────────────────────────────

export interface DaemonClient {
  /**
   * POST /api/decisions — create a new pending decision in the daemon.
   * Returns the requestId on success.
   */
  createDecision(
    req: CreateDecisionRequest,
  ): Promise<Result<{ readonly requestId: RequestId }, RelayError>>

  /**
   * GET /api/decisions/:requestId — long-poll until the decision reaches a
   * terminal state (answered, expired, cancelled) or timeoutMs elapses.
   *
   * @param requestId  The opaque ID returned by createDecision.
   * @param timeoutMs  Client-side timeout, should exceed the daemon's 30 s
   *                   long-poll so the daemon always resolves first (35 000 ms
   *                   recommended).
   * @param signal     Optional AbortSignal forwarded to fetch(); use to cancel
   *                   the poll when the overall permission operation is aborted.
   */
  pollDecision(
    requestId: RequestId,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Result<Decision, RelayError>>
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Read the response body as text, capped at `maxBytes`.
 *
 * The cap defends against a misconfigured or hostile daemon URL returning
 * an oversized error body that would otherwise be buffered into a RelayError
 * and logged verbatim.  When the limit is exceeded, the reader is cancelled
 * (releasing the underlying socket) and the literal string `'[truncated]'`
 * is returned in place of the body.
 *
 * Returns an empty string if the body cannot be consumed (e.g., already
 * consumed, or a network-level error).
 */
async function safeBodyText(response: Response, maxBytes = 8192): Promise<string> {
  try {
    const reader = response.body?.getReader()
    if (!reader) return ''
    const chunks: Uint8Array[] = []
    let total = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done || !value) break
      total += value.byteLength
      if (total > maxBytes) {
        // Cancel the stream so the socket is released immediately rather
        // than draining the rest of the body in the background.
        await reader.cancel()
        return '[truncated]'
      }
      chunks.push(value)
    }
    const merged = new Uint8Array(total)
    let offset = 0
    for (const c of chunks) {
      merged.set(c, offset)
      offset += c.length
    }
    return new TextDecoder().decode(merged)
  } catch {
    return ''
  }
}

/**
 * Map a caught fetch() error to a typed RelayError.
 *
 * `fetch` throws:
 *   - `DOMException` with name `'AbortError'` when aborted or timed out.
 *   - `TypeError` for network failures (DNS, refused connection, etc.).
 *   - Other errors are treated as network failures.
 */
function classifyFetchError(err: unknown): RelayError {
  if (err instanceof Error) {
    if (err.name === 'AbortError' || err.name === 'TimeoutError') {
      return { kind: 'timeout', message: err.message }
    }
    return { kind: 'network', message: err.message }
  }
  return { kind: 'network', message: String(err) }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create a DaemonClient that talks to the daemon at `baseUrl`.
 *
 * @param baseUrl  e.g. "http://localhost:3582" — no trailing slash.
 */
export function createDaemonClient(baseUrl: string): DaemonClient {
  return {
    // ── createDecision ────────────────────────────────────────────────────────
    async createDecision(
      req: CreateDecisionRequest,
    ): Promise<Result<{ readonly requestId: RequestId }, RelayError>> {
      let response: Response
      try {
        response = await fetch(`${baseUrl}/api/decisions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(req),
        })
      } catch (err: unknown) {
        return { ok: false, error: classifyFetchError(err) }
      }

      if (response.status !== 201) {
        const body = await safeBodyText(response)
        return {
          ok: false,
          error: { kind: 'http', status: response.status, body },
        }
      }

      let json: unknown
      try {
        json = await response.json()
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        return { ok: false, error: { kind: 'parse', message } }
      }

      // Narrow to the shape we expect: { requestId: string }
      if (
        typeof json !== 'object' ||
        json === null ||
        !('requestId' in json) ||
        typeof (json as Record<string, unknown>).requestId !== 'string'
      ) {
        return {
          ok: false,
          error: {
            kind: 'parse',
            message: `createDecision: unexpected response shape: ${JSON.stringify(json)}`,
          },
        }
      }

      const requestId = (json as Record<string, unknown>).requestId as RequestId
      return { ok: true, data: { requestId } }
    },

    // ── pollDecision ──────────────────────────────────────────────────────────
    async pollDecision(
      requestId: RequestId,
      timeoutMs: number,
      signal?: AbortSignal,
    ): Promise<Result<Decision, RelayError>> {
      // Wrap a TimeoutSignal around the provided signal so we abort after
      // timeoutMs regardless of what the daemon returns.  If the caller also
      // provides a signal, we combine both so either side can abort.
      const timeoutController = new AbortController()
      const timeoutHandle = setTimeout(() => {
        timeoutController.abort()
      }, timeoutMs)

      // Build a composite signal if the caller supplied one.
      const effectiveSignal: AbortSignal = signal
        ? AbortSignal.any([signal, timeoutController.signal])
        : timeoutController.signal

      let response: Response
      try {
        response = await fetch(`${baseUrl}/api/decisions/${requestId}`, {
          signal: effectiveSignal,
        })
      } catch (err: unknown) {
        clearTimeout(timeoutHandle)
        return { ok: false, error: classifyFetchError(err) }
      } finally {
        clearTimeout(timeoutHandle)
      }

      if (response.status === 404) {
        const body = await safeBodyText(response)
        return {
          ok: false,
          error: {
            kind: 'parse',
            message: `pollDecision: decision ${requestId} not found: ${body}`,
          },
        }
      }

      if (response.status !== 200) {
        const body = await safeBodyText(response)
        return {
          ok: false,
          error: { kind: 'http', status: response.status, body },
        }
      }

      let json: unknown
      try {
        json = await response.json()
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        return { ok: false, error: { kind: 'parse', message } }
      }

      // Validate the response is a PollDecisionResponse-compatible object.
      // We need at minimum: { requestId, status }.  For 'answered', also { answer }.
      if (
        typeof json !== 'object' ||
        json === null ||
        !('requestId' in json) ||
        !('status' in json) ||
        typeof (json as Record<string, unknown>).status !== 'string'
      ) {
        return {
          ok: false,
          error: {
            kind: 'parse',
            message: `pollDecision: unexpected response shape: ${JSON.stringify(json)}`,
          },
        }
      }

      // The daemon poll endpoint returns a subset of the full Decision shape.
      // Cast it to Decision — callers narrow on `status` before reading any
      // answered-only fields.
      return { ok: true, data: json as unknown as Decision }
    },
  }
}

// ─── Error formatting ─────────────────────────────────────────────────────────

/** Human-readable one-liner for logging a RelayError. */
export function formatRelayError(err: RelayError): string {
  switch (err.kind) {
    case 'network':
      return `network error: ${err.message}`
    case 'http':
      return `HTTP ${err.status}: ${err.body}`
    case 'parse':
      return `parse error: ${err.message}`
    case 'timeout':
      return `timeout: ${err.message}`
  }
}
