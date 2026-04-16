import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { Notification } from '@modelcontextprotocol/sdk/types.js'
import type { PermissionVerdict, SessionId } from '@claudegram/shared'
import { loadChannelConfig } from './config.js'
import { SessionPermissionAllowlist } from './allowlist.js'
import { handlePermission, parsePermissionNotification } from './permission.js'
import { createDaemonClient } from './relay.js'

// ─── Bootstrap ───────────────────────────────────────────────────────────────

// Fail fast on bad environment; loadChannelConfig calls process.exit(1) if
// CLAUDEGRAM_SESSION_NAME is missing or CLAUDEGRAM_DAEMON_URL is invalid.
const config = loadChannelConfig()

// ─── Phase 2B: ephemeral session identity ────────────────────────────────────
//
// A stable UUID is generated once per process lifetime and used as the
// sessionId in every CreateDecisionRequest sent to the daemon.
//
// Limitation (to be resolved in Phase 2C):
//   This UUID is NOT registered with the daemon via POST /api/sessions, so the
//   daemon's session registry has no record of it.  The daemon route currently
//   calls `registry.touch(req.sessionId)` which silently no-ops on unknown IDs,
//   so decision creation still succeeds.  Phase 2C will replace this UUID with
//   the real SessionId returned by a proper session registration handshake at
//   startup.
const sessionId = crypto.randomUUID() as SessionId

process.stderr.write(
  `[claudegram/channel-server] starting — session="${config.CLAUDEGRAM_SESSION_NAME}" daemon="${config.CLAUDEGRAM_DAEMON_URL}" sessionId="${sessionId}"\n`,
)

// ─── Session-scoped state ─────────────────────────────────────────────────────

const allowlist = new SessionPermissionAllowlist()

// ─── Daemon HTTP client ───────────────────────────────────────────────────────

const daemon = createDaemonClient(config.CLAUDEGRAM_DAEMON_URL)

// ─── MCP Server setup ─────────────────────────────────────────────────────────

/**
 * The MCP Server instance.
 *
 * We advertise the `claude/channel/permission` capability under `experimental`
 * because it is a Claudegram-specific extension not part of the base MCP spec.
 *
 * SDK: @modelcontextprotocol/sdk@1.29.0
 * API: new Server(info, { capabilities }) + server.setNotificationHandler(schema, handler)
 *      The `method` literal in the Zod schema is used by the SDK to route
 *      incoming notifications (see zod-json-schema-compat.js getMethodLiteral).
 */
const server = new Server(
  {
    name: 'claudegram-channel-server',
    version: '0.1.0',
  },
  {
    capabilities: {
      experimental: {
        'claude/channel/permission': {},
        // Advertise the verdict send-back capability so Claude Code knows we
        // will emit result notifications.
        'claude/channel/permission/result': {},
      },
    },
  },
)

// ─── Notification handler ─────────────────────────────────────────────────────

/**
 * Handle incoming `claude/channel/permission` notifications from Claude Code.
 *
 * We use `fallbackNotificationHandler` rather than `setNotificationHandler`
 * because the channel permission method is a Claudegram-specific extension
 * not present in the base MCP spec.  `fallbackNotificationHandler` receives
 * all methods that lack a dedicated handler, so we guard with a method check.
 *
 * Verdict send-back (Phase 2B):
 *   JSON-RPC 2.0 does not permit a response to a notification (it has no id
 *   field). Therefore the verdict is returned via a separate **server →
 *   client** notification with method `claude/channel/permission/result`.
 *
 *   Payload:
 *     {
 *       correlationId: string,   // value of notification.params.correlationId
 *       verdict: PermissionVerdict
 *     }
 *
 *   Claude Code MUST:
 *     a) include a stable `correlationId` field in each
 *        `claude/channel/permission` notification payload; and
 *     b) listen for `claude/channel/permission/result` notifications and match
 *        on `correlationId` to unblock the corresponding permission prompt.
 *
 *   Open question for Phase 4A: agree the exact `correlationId` format with
 *   Claude Code (a UUID is the simplest option).
 *
 *   If Claude Code does not include `correlationId` in the payload, the result
 *   notification is still sent with `correlationId: null` so the client can
 *   observe the verdict even if it cannot correlate to a specific prompt.
 */
server.fallbackNotificationHandler = async (notification: Notification): Promise<void> => {
  // Outer try/catch: prevents any unexpected throw from escaping into the SDK
  // message loop, which could either crash the process or silently terminate
  // the stdio session.  All errors are logged and swallowed.
  try {
    if (notification.method !== 'claude/channel/permission') {
      process.stderr.write(
        `[claudegram/channel-server] unhandled notification method: ${notification.method}\n`,
      )
      return
    }

    const parsed = parsePermissionNotification(notification.params)

    if (!parsed.ok) {
      process.stderr.write(
        `[claudegram/channel-server] invalid permission notification payload: ${parsed.error}\n`,
      )
      return
    }

    // Extract correlationId from the validated payload (may be absent — the
    // schema marks it `.optional()`).  We pull it out of `parsed.data` rather
    // than the raw `notification.params` so it has been bounded-length-checked
    // and type-narrowed to `string | undefined` by zod.
    const correlationId: string | null = parsed.data.correlationId ?? null

    // Inner try/catch around handlePermission: contract requires that we
    // always have a verdict to act on.  A throw inside handlePermission must
    // degrade to a safe `deny` rather than skipping the send-back entirely.
    let verdict: PermissionVerdict
    try {
      verdict = await handlePermission(parsed.data, {
        config,
        allowlist,
        daemon,
        sessionId,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      process.stderr.write(
        `[claudegram/channel-server] handlePermission error: ${message}\n`,
      )
      verdict = { behavior: 'deny', reason: 'internal_error' }
    }

    process.stderr.write(
      `[claudegram/channel-server] permission verdict: behavior=${verdict.behavior}` +
        (verdict.behavior === 'deny' && verdict.reason ? ` reason=${verdict.reason}` : '') +
        ` category=${parsed.data.category} title="${parsed.data.title}"\n`,
    )

    // ── Verdict send-back ──────────────────────────────────────────────────
    // JSON-RPC 2.0 forbids replying to a notification.  We instead emit a
    // separate server→client notification so Claude Code can unblock the
    // permission prompt.
    //
    // The `server.notification()` method sends arbitrary JSON-RPC
    // notification frames to the connected client.  Per MCP SDK 1.29.0, this
    // call will silently no-op if the transport is not connected, so it is
    // safe to call unconditionally here.
    try {
      // `server.notification()` is typed to the SDK's ServerNotification union,
      // which does not include our custom extension method.  We use a
      // `as unknown as` cast to emit the raw JSON-RPC notification frame;
      // the SDK's runtime path is method-agnostic for outbound notifications.
      type CustomNotification = {
        method: string
        params?: Record<string, unknown>
      }
      await (server.notification as (n: CustomNotification) => Promise<void>)({
        method: 'claude/channel/permission/result',
        params: {
          correlationId,
          verdict,
        },
      })
    } catch (notifyErr) {
      // Sending the result notification is best-effort; if it fails (e.g.,
      // client already disconnected) we log and continue rather than treating
      // it as a fatal error.  The correlationId is included so operators can
      // tie the failure to the specific permission decision that lost its
      // verdict send-back (otherwise indistinguishable from any other prompt).
      const message = notifyErr instanceof Error ? notifyErr.message : String(notifyErr)
      process.stderr.write(
        `[claudegram/channel-server] failed to send permission result notification (correlationId=${correlationId ?? '<none>'}): ${message}\n`,
      )
    }
  } catch (err) {
    // Last-resort guard.  Do NOT re-throw — the SDK message loop must continue.
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(
      `[claudegram/channel-server] notification handler error: ${message}\n`,
    )
  }
}

// ─── Transport ───────────────────────────────────────────────────────────────

const transport = new StdioServerTransport()

process.stderr.write('[claudegram/channel-server] connecting to stdio transport\n')

server.connect(transport).then(() => {
  process.stderr.write('[claudegram/channel-server] ready — waiting for MCP messages on stdin\n')
}).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err)
  process.stderr.write(`[claudegram/channel-server] fatal: failed to connect transport: ${message}\n`)
  process.exit(1)
})

// ─── Uncaught error guard ─────────────────────────────────────────────────────

process.on('uncaughtException', (err: Error) => {
  process.stderr.write(
    `[claudegram/channel-server] uncaughtException: ${err.message}\n${err.stack ?? ''}\n`,
  )
  process.exit(1)
})

process.on('unhandledRejection', (reason: unknown) => {
  const message = reason instanceof Error ? reason.message : String(reason)
  process.stderr.write(`[claudegram/channel-server] unhandledRejection: ${message}\n`)
  process.exit(1)
})
