import type { RequestId, Result, PermissionCategory } from './types.js'
import { PERMISSION_CATEGORIES } from './types.js'

// ─── Permission option identifiers ───────────────────────────────────────────

export const PERMISSION_OPTION_IDS = ['yes', 'yes_all', 'no'] as const
export type PermissionOptionId = (typeof PERMISSION_OPTION_IDS)[number]

// ─── Permission categories ────────────────────────────────────────────────────
// PERMISSION_CATEGORIES / PermissionCategory live in types.ts (so that the
// Decision shape can reference them without a circular import).  They are
// re-exported here to preserve the previous public surface where consumers
// imported them from this module.
//
// Note: `import` (not `export ... from`) is required so that the names are in
// this module's scope and can be referenced by interfaces below
// (PermissionNotification.category).  A bare `export { ... } from` is a
// transit-only re-export and does not bind the name locally.
export { PERMISSION_CATEGORIES }
export type { PermissionCategory }

// ─── Permission notification (Claude Code → channel-server) ───────────────────

/**
 * Validated payload of a `claude/channel/permission` MCP notification, after
 * the channel-server has parsed it. Shared between:
 *   - channel-server (Phase 2A): receives and validates
 *   - channel-server (Phase 2B): forwards to daemon as a CreateDecisionRequest
 *   - bot (Phase 3B): renders title/description in the Telegram message
 *
 * Defined here so all three phases reference a single source of truth.
 *
 * Field budgets (enforced by parsePermissionNotification at the boundary):
 *   - title         ≤  256 chars
 *   - description   ≤ 4096 chars
 *   - toolName      ≤  128 chars
 *   - sessionId     ≤  128 chars
 *   - correlationId ≤  128 chars
 */
export interface PermissionNotification {
  readonly category: PermissionCategory
  readonly title: string
  readonly description: string
  readonly toolName?: string
  readonly sessionId?: string
  /**
   * Opaque token supplied by Claude Code to correlate the
   * `claude/channel/permission/result` notification back to the originating
   * permission prompt.  When present, the channel-server echoes it verbatim
   * in the result notification's `correlationId` field; when absent, the
   * result still fires with `correlationId: null`.
   *
   * Format is intentionally unconstrained beyond the length budget — Claude
   * Code may use a UUID, a sequence number, or any other string.
   */
  readonly correlationId?: string
}

// ─── Telegram callback_data encoding ─────────────────────────────────────────

/** Prefix that identifies a Claudegram callback payload. */
export const CALLBACK_DATA_PREFIX = 'cg:'

/** Telegram hard limit on callback_data size in bytes (UTF-8). */
export const CALLBACK_DATA_MAX_BYTES = 64

export type CallbackParseError = 'invalid_format' | 'wrong_prefix' | 'too_long'
export type EncodeCallbackError = 'too_long' | 'invalid_option_id'

/** UUID v4-ish regex used to validate the requestId segment after parsing. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** UTF-8 byte length helper (works in any modern runtime, no @types/node needed). */
function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).byteLength
}

/**
 * Encode a requestId + optionId into a Telegram callback_data string.
 * Format: `cg:<requestId>:<optionId>`.
 *
 * Returns a typed Result instead of throwing — Phase 3A bot callers MUST
 * handle the failure branch (an unhandled throw inside the daemon's
 * EventEmitter pipeline would crash the daemon, since there is no catch
 * boundary around listener invocations).
 *
 * Failure modes:
 * - `'too_long'`           — encoded result exceeds CALLBACK_DATA_MAX_BYTES (64 UTF-8 bytes)
 * - `'invalid_option_id'`  — optionId contains `:` (would break the parser invariant)
 *
 * Note: `optionId` is intentionally typed as `string` (not `PermissionOptionId`)
 * because the same codec must serve future custom-decision option ids (Phase F3).
 * Validity is enforced at runtime instead of at the type level.
 */
export function encodeCallbackData(
  requestId: RequestId,
  optionId: string,
): Result<string, EncodeCallbackError> {
  if (optionId.includes(':')) {
    return { ok: false, error: 'invalid_option_id' }
  }

  const result = `${CALLBACK_DATA_PREFIX}${requestId}:${optionId}`
  if (utf8ByteLength(result) > CALLBACK_DATA_MAX_BYTES) {
    return { ok: false, error: 'too_long' }
  }

  return { ok: true, data: result }
}

/**
 * Parse a Telegram callback_data string back into its components.
 * Returns a typed Result — inspect `.ok` to distinguish success from error.
 *
 * Failure modes:
 * - `'too_long'`       — input exceeds CALLBACK_DATA_MAX_BYTES (64 UTF-8 bytes)
 * - `'wrong_prefix'`   — input does not start with `'cg:'`
 * - `'invalid_format'` — wrong segment count, empty segments, or requestId is not a valid UUID
 */
export function parseCallbackData(
  data: string,
): Result<{ requestId: RequestId; optionId: string }, CallbackParseError> {
  // Defensive UTF-8 byte-length guard. Telegram should enforce this, but
  // multi-byte characters could otherwise bypass a naive `.length` check.
  if (utf8ByteLength(data) > CALLBACK_DATA_MAX_BYTES) {
    return { ok: false, error: 'too_long' }
  }

  if (!data.startsWith(CALLBACK_DATA_PREFIX)) {
    return { ok: false, error: 'wrong_prefix' }
  }

  // Expected format: "cg:<requestId>:<optionId>"
  // A UUID has the form xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx (no colons),
  // so splitting on `:` must yield exactly 3 non-empty parts.
  const parts = data.split(':')
  if (parts.length !== 3 || parts[1] === '' || parts[2] === '') {
    return { ok: false, error: 'invalid_format' }
  }

  // Validate the requestId segment is a real UUID before casting to the brand —
  // an unchecked `as RequestId` would be a structural lie.
  if (!UUID_RE.test(parts[1])) {
    return { ok: false, error: 'invalid_format' }
  }

  return {
    ok: true,
    data: {
      requestId: parts[1] as RequestId,
      optionId: parts[2],
    },
  }
}
