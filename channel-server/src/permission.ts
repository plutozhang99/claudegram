import { z } from 'zod'
import { PERMISSION_CATEGORIES } from '@claudegram/shared'
import type {
  PermissionCategory,
  PermissionNotification,
  PermissionVerdict,
  CreateDecisionRequest,
  SessionId,
} from '@claudegram/shared'
import type { ISessionPermissionAllowlist } from './allowlist.js'
import type { ChannelConfig } from './config.js'
import type { DaemonClient } from './relay.js'
import { formatRelayError } from './relay.js'

// ─── Field length budgets ────────────────────────────────────────────────────
// Bounded to prevent a compromised Claude Code process from sending unbounded
// payloads that would cause stderr DoS here or daemon body bloat.

const MAX_TITLE_LEN = 256
const MAX_DESCRIPTION_LEN = 4096
const MAX_TOOL_NAME_LEN = 128
const MAX_SESSION_ID_LEN = 128
const MAX_CORRELATION_ID_LEN = 128

// ─── Handler context ──────────────────────────────────────────────────────────

export interface PermissionContext {
  readonly config: ChannelConfig
  readonly allowlist: ISessionPermissionAllowlist
  /**
   * HTTP client for the daemon.  Injected so tests can supply a stub without
   * spinning up a real daemon process.
   */
  readonly daemon: DaemonClient
  /**
   * The channel-server's session identity as registered with the daemon.
   *
   * Phase 2B: derived as a `crypto.randomUUID()` at process start (see index.ts).
   * Phase 2C: replaced with the real SessionId returned by POST /api/sessions.
   */
  readonly sessionId: SessionId
}

// ─── Option label helper ──────────────────────────────────────────────────────

/**
 * Returns the three button labels for the given permission category, matching
 * the copy defined in PRD §F2.
 */
function categoryOptionLabels(category: PermissionCategory): {
  readonly yes: string
  readonly yesAll: string
  readonly no: string
} {
  switch (category) {
    case 'file_edit':
      return {
        yes: 'Yes',
        yesAll: 'Yes, allow all edits this session',
        no: 'No',
      }
    case 'bash':
      return {
        yes: 'Yes',
        yesAll: 'Yes, allow all Bash this session',
        no: 'No',
      }
    case 'mcp_tool':
      return {
        yes: 'Yes',
        yesAll: 'Yes, allow all MCP this session',
        no: 'No',
      }
  }
}

// ─── Decision handler ─────────────────────────────────────────────────────────

/**
 * Handles a single `claude/channel/permission` notification.
 *
 * Flow:
 *   1. Allowlist fast-path — if the category already has a session-level grant
 *      (from a prior yes_all), return `allow` immediately, no daemon call.
 *   2. Build a CreateDecisionRequest with three options (yes / yes_all / no).
 *   3. POST to daemon POST /api/decisions.
 *   4. Long-poll GET /api/decisions/:requestId (35 s budget, slightly above the
 *      daemon's own 30 s hold so the daemon always resolves first).
 *   5. Map the answered/expired/cancelled decision to a PermissionVerdict.
 *      yes_all also updates the in-memory allowlist for future fast-path hits.
 *
 * Never throws — all error branches return a `deny` verdict with a descriptive
 * reason string that surfaces in channel-server's stderr log.
 */
export async function handlePermission(
  notification: PermissionNotification,
  ctx: PermissionContext,
): Promise<PermissionVerdict> {
  // ── 1. Allowlist fast-path ────────────────────────────────────────────────
  if (ctx.allowlist.has(notification.category)) {
    return { behavior: 'allow' }
  }

  // ── 2. Build CreateDecisionRequest ───────────────────────────────────────
  const labels = categoryOptionLabels(notification.category)
  const req: CreateDecisionRequest = {
    sessionId: ctx.sessionId,
    sessionName: ctx.config.CLAUDEGRAM_SESSION_NAME,
    type: 'permission',
    // Persist category on the decision so the bot (Phase 3B) can pick the
    // right copy for callback rendering without inspecting options[].label.
    category: notification.category,
    title: notification.title,
    description: notification.description,
    options: [
      { id: 'yes', label: labels.yes },
      { id: 'yes_all', label: labels.yesAll },
      { id: 'no', label: labels.no },
    ],
    // ttlSeconds omitted — daemon defaults to DEFAULT_TTL_SECONDS (300 s).
  }

  // ── 3. POST to daemon ─────────────────────────────────────────────────────
  const created = await ctx.daemon.createDecision(req)
  if (!created.ok) {
    process.stderr.write(
      `[handlePermission] createDecision failed: ${formatRelayError(created.error)}\n`,
    )
    return {
      behavior: 'deny',
      reason: `daemon_unreachable_${created.error.kind}`,
    }
  }

  const { requestId } = created.data

  // ── 4. Long-poll for verdict ──────────────────────────────────────────────
  // 35 000 ms is intentionally longer than the daemon's 30 s hold so that the
  // daemon's poll resolves first and the channel-server never times out before
  // receiving the answer.
  const polled = await ctx.daemon.pollDecision(requestId, 35_000)
  if (!polled.ok) {
    process.stderr.write(
      `[handlePermission] pollDecision failed (requestId=${requestId}): ${formatRelayError(polled.error)}\n`,
    )
    return {
      behavior: 'deny',
      reason: `poll_failed_${polled.error.kind}`,
    }
  }

  // ── 5. Map decision to verdict ────────────────────────────────────────────
  const decision = polled.data

  if (decision.status === 'answered') {
    if (decision.answer === 'yes') {
      return { behavior: 'allow' }
    }

    if (decision.answer === 'yes_all') {
      // Persist category grant for the rest of this session.
      ctx.allowlist.add(notification.category)
      return { behavior: 'allow' }
    }

    // answer === 'no' (or any other unexpected answer value)
    return {
      behavior: 'deny',
      reason: `decision_answered_${decision.answer}`,
    }
  }

  // status === 'expired' | 'cancelled' | 'pending' (poll timed out at daemon)
  const answerSuffix =
    'answer' in decision && typeof decision.answer === 'string'
      ? `_${decision.answer}`
      : '_none'
  return {
    behavior: 'deny',
    reason: `decision_${decision.status}${answerSuffix}`,
  }
}

// ─── MCP notification → typed notification helper ────────────────────────────

/**
 * Parses and validates the raw `claude/channel/permission` notification
 * payload into a {@link PermissionNotification}.  Returns a typed Result so
 * callers can handle validation failures without throwing.
 *
 * All string fields are length-bounded — see field budgets at top of file.
 * The schema is `.strict()` so unknown keys are rejected (defence-in-depth
 * against a compromised Claude Code process smuggling extra fields downstream).
 */
export function parsePermissionNotification(
  params: unknown,
): { ok: true; data: PermissionNotification } | { ok: false; error: string } {
  const schema = z
    .object({
      category: z.enum(PERMISSION_CATEGORIES),
      title: z.string().min(1).max(MAX_TITLE_LEN),
      description: z.string().min(1).max(MAX_DESCRIPTION_LEN),
      toolName: z.string().max(MAX_TOOL_NAME_LEN).optional(),
      sessionId: z.string().max(MAX_SESSION_ID_LEN).optional(),
      // Opaque token Claude Code uses to correlate the result notification
      // back to the originating prompt.  Echoed verbatim in the
      // `claude/channel/permission/result` send-back payload.
      correlationId: z.string().max(MAX_CORRELATION_ID_LEN).optional(),
    })
    .strict()

  const result = schema.safeParse(params)

  if (!result.success) {
    return {
      ok: false,
      error: result.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; '),
    }
  }

  return { ok: true, data: result.data }
}
