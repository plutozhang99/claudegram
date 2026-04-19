// Shape check only — cryptographic verification happens at Cloudflare Access edge in P4.
// DO NOT expose `/session-socket` beyond loopback before P4 ships.

import { z } from 'zod';
import type { ServerWebSocket } from 'bun';
import type { Logger } from '../logger.js';
import type { Config } from '../config.js';
import type { SessionRepo } from '../repo/types.js';
import type { SessionRegistry } from '../ws/session-registry.js';
import type { Hub } from '../ws/hub.js';
import {
  sendWithBackpressure as _sendWithBackpressure,
  sendErrorFrame as _sendErrorFrame,
  type WsErrorReason,
} from './_ws-helpers.js';
export type { BackpressureResult } from './_ws-helpers.js';

// ── Per-connection data ───────────────────────────────────────────────────────

/** Discriminant data placed in the `ws.data` slot at /session-socket upgrade time. */
export interface SessionSocketData {
  readonly kind: 'session-socket';
}

// ── Inbound message schema ────────────────────────────────────────────────────

const registerFrameSchema = z.object({
  type: z.literal('register'),
  session_id: z.string().min(1),
  session_name: z.string().min(1).optional(),
});

/**
 * Discriminated union of all inbound session-socket frame schemas.
 * P2.3 will add `reply` / `mark_read` arms here as a one-line change.
 */
const inboundFrameSchema = z.discriminatedUnion('type', [registerFrameSchema]);

type RegisterFrame = z.infer<typeof registerFrameSchema>;

// ── Outbound helpers ──────────────────────────────────────────────────────────

/**
 * Re-export from shared helper for backward compatibility with tests.
 * @deprecated Import from `./_ws-helpers.js` directly in new code.
 */
export function sendWithBackpressure(
  ws: ServerWebSocket<unknown>,
  text: string,
  capBytes: number,
) {
  return _sendWithBackpressure(ws, text, capBytes);
}

// ── Auth gate ─────────────────────────────────────────────────────────────────

const CF_CLIENT_ID_HEADER = 'Cf-Access-Client-Id';
const CF_CLIENT_SECRET_HEADER = 'Cf-Access-Client-Secret';

/**
 * Check Cloudflare Access service-token headers on an upgrade Request.
 *
 * Returns `null` when access is allowed (either `trustCfAccess` is false, or
 * both headers are present and non-empty).  Returns a 401 `Response` when the
 * gate should reject the upgrade.
 *
 * Shape check only — cryptographic verification happens at the CF edge in P4.
 */
export function checkSessionSocketAuth(req: Request, config: Pick<Config, 'trustCfAccess'>): Response | null {
  if (!config.trustCfAccess) return null;

  const clientId = req.headers.get(CF_CLIENT_ID_HEADER);
  const clientSecret = req.headers.get(CF_CLIENT_SECRET_HEADER);

  if (!clientId || !clientSecret) {
    return new Response('unauthorized', { status: 401 });
  }
  return null;
}

// ── WebSocket lifecycle handlers ──────────────────────────────────────────────

export interface SessionSocketDeps {
  readonly config: Config;
  readonly sessRepo: SessionRepo;
  readonly sessionRegistry: SessionRegistry;
  readonly hub: Hub;
  readonly logger: Logger;
}

/** Map from a WebSocket to its registered session_id and cleanup Disposable. */
const wsState = new WeakMap<ServerWebSocket<unknown>, { session_id: string; disposable: Disposable }>();

/** Consecutive bad-frame counter per socket (for future N-strike close policy). */
const badFrameCount = new WeakMap<ServerWebSocket<unknown>, number>();

function sendErrorFrame(
  ws: ServerWebSocket<unknown>,
  reason: WsErrorReason,
  capBytes: number,
  logger: Logger,
  phase: string,
  session_id?: string,
): void {
  // NOTE: session_id is intentionally NOT included in the JSON frame payload here
  // (session-socket only sends {type, reason} per the original contract).
  // It is only used for logging context in the warn path inside _sendErrorFrame.
  _sendErrorFrame(ws, { reason }, capBytes, logger, phase + (session_id !== undefined ? `[${session_id}]` : ''));
}

export function handleSessionSocketOpen(
  ws: ServerWebSocket<unknown>,
  _deps: Pick<SessionSocketDeps, 'logger'>,
): void {
  badFrameCount.set(ws, 0);
}

export function handleSessionSocketMessage(
  ws: ServerWebSocket<unknown>,
  rawMessage: string | Buffer,
  deps: SessionSocketDeps,
): void {
  const { config, sessRepo, sessionRegistry, hub, logger } = deps;
  const capBytes = config.wsOutboundBufferCapBytes;

  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof rawMessage === 'string' ? rawMessage : rawMessage.toString('utf8'));
  } catch {
    sendErrorFrame(ws, 'invalid_payload', capBytes, logger, 'parse_error_reply');
    return;
  }

  // Use discriminated union for routing — unknown `type` drops with debug log.
  const validation = inboundFrameSchema.safeParse(parsed);
  if (!validation.success) {
    // Check if parse failed due to unknown type vs schema mismatch.
    const frame = parsed as Record<string, unknown>;
    const frameType = frame['type'];
    // Zod discriminatedUnion will fail on unknown discriminant — treat as unknown frame.
    const isUnknownType = !['register'].includes(String(frameType));
    if (isUnknownType) {
      // Reserved for later phases — drop with a debug log.
      logger.debug('session_socket_unknown_frame', { type: String(frameType) });
      return;
    }

    // Known type but invalid schema — send error frame.
    sendErrorFrame(ws, 'invalid_payload', capBytes, logger, 'register_error_reply');
    const count = (badFrameCount.get(ws) ?? 0) + 1;
    badFrameCount.set(ws, count);
    return;
  }

  const msg: RegisterFrame = validation.data;
  const { session_id, session_name } = msg;
  const now = Date.now();

  // Upsert the session in the database.
  try {
    sessRepo.upsert({ id: session_id, name: session_name ?? session_id, now });
  } catch (err) {
    logger.error('session_socket_upsert_failed', {
      session_id,
      err: err instanceof Error ? err.message : String(err),
    });
    // HIGH 3 fix: upsert errors are internal — not a payload problem.
    sendErrorFrame(ws, 'internal_error', capBytes, logger, 'upsert_error_reply', session_id);
    return;
  }

  // HIGH 1 TOCTOU fix: use tryRegister() as the authoritative cap gate.
  // The pre-upgrade 503 is a cheap fast-fail optimisation; the register frame
  // handler is the true enforcement point because:
  //   a) concurrent bursts can slip past the pre-upgrade check, and
  //   b) the cap is on registered sessions, not on open connections.
  // Rebind of an existing session_id is always allowed regardless of cap.
  const registerResult = sessionRegistry.tryRegister(session_id, ws);
  if (!registerResult.ok) {
    logger.warn('session_socket_register_cap_exceeded', { session_id });
    // Send error frame before closing so the client gets a readable reason.
    sendErrorFrame(ws, 'internal_error', capBytes, logger, 'register_cap_exceeded', session_id);
    ws.close(1008, 'cap_exceeded');
    return;
  }

  const { disposable } = registerResult;

  // Track per-socket state for cleanup on close.
  wsState.set(ws, { session_id, disposable });
  badFrameCount.set(ws, 0);

  logger.info('session_socket_registered', { session_id });

  // FIX 2/3: Broadcast connected:true so all PWAs see the session come online.
  try {
    const session = sessRepo.findById(session_id);
    if (session !== null) {
      hub.broadcast({ type: 'session_update', session: { ...session, connected: true } });
    }
  } catch (broadcastErr) {
    logger.warn('session_socket_register_broadcast_failed', {
      session_id,
      err: broadcastErr instanceof Error ? broadcastErr.message : String(broadcastErr),
    });
  }
}

export function handleSessionSocketClose(
  ws: ServerWebSocket<unknown>,
  deps: Pick<SessionSocketDeps, 'sessionRegistry' | 'hub' | 'sessRepo' | 'logger'>,
): void {
  const { hub, sessRepo, logger } = deps;
  const state = wsState.get(ws);

  try {
    if (state !== undefined) {
      // MED 2 fix: wrap dispose in try/catch so WeakMap cleanup always runs.
      try {
        state.disposable[Symbol.dispose]();
      } catch (err) {
        logger.warn('session_socket_dispose_failed', {
          session_id: state.session_id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
      logger.info('session_socket_closed', { session_id: state.session_id });

      // FIX 4: Broadcast connected:false so all PWAs see the session go offline.
      try {
        const session = sessRepo.findById(state.session_id);
        if (session !== null) {
          hub.broadcast({ type: 'session_update', session: { ...session, connected: false } });
        }
      } catch (broadcastErr) {
        logger.warn('session_socket_close_broadcast_failed', {
          session_id: state.session_id,
          err: broadcastErr instanceof Error ? broadcastErr.message : String(broadcastErr),
        });
      }
    }
  } finally {
    // Always clean up WeakMap entries even if dispose throws.
    wsState.delete(ws);
    badFrameCount.delete(ws);
  }
}
