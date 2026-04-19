import { z } from 'zod';
import type { ServerWebSocket } from 'bun';
import type { Logger } from '../logger.js';
import type { MessageRepo, SessionRepo } from '../repo/types.js';
import type { SessionRegistry } from '../ws/session-registry.js';
import type { Hub } from '../ws/hub.js';
import { sendErrorFrame, type WsErrorReason } from './_ws-helpers.js';

// ── Inbound schema ────────────────────────────────────────────────────────────

const replyFrameSchema = z.object({
  type: z.literal('reply'),
  session_id: z.string().min(1),
  text: z.string().min(1),
  reply_to: z.string().optional(),
  client_msg_id: z.string().min(1),
});

const markReadFrameSchema = z.object({
  type: z.literal('mark_read'),
  session_id: z.string().min(1),
  up_to_message_id: z.string().min(1),
});

const inboundUserFrame = z.discriminatedUnion('type', [replyFrameSchema, markReadFrameSchema]);

type ReplyFrame = z.infer<typeof replyFrameSchema>;
type MarkReadFrame = z.infer<typeof markReadFrameSchema>;

// ── Bad-frame counter ─────────────────────────────────────────────────────────

/** Consecutive malformed-frame counter per socket. Resets to 0 on any successful frame. */
const badFrameCount = new WeakMap<ServerWebSocket<unknown>, number>();

// ── Dependencies ──────────────────────────────────────────────────────────────

export interface UserSocketDeps {
  readonly sessionRegistry: SessionRegistry;
  readonly messageRepo: MessageRepo;
  readonly sessionRepo: SessionRepo;
  readonly hub: Hub;
  readonly logger: Logger;
  /** Maximum consecutive malformed frames before ws.close(1003). Default: 5. */
  readonly maxBadFrames: number;
  /** Backpressure cap for outbound frames to PWA user-sockets. */
  readonly outboundBufferCapBytes: number;
}

// ── Internal: frame handlers ──────────────────────────────────────────────────

function handleReplyFrame(
  ws: ServerWebSocket<unknown>,
  frame: ReplyFrame,
  deps: UserSocketDeps,
): void {
  const { sessionRegistry, messageRepo, hub, logger, outboundBufferCapBytes } = deps;
  const { session_id, text, reply_to, client_msg_id } = frame;

  // FIX 5: Persist the PWA-originated message to the DB before forwarding.
  // Uses client_msg_id as the message id — UUIDs are unique enough, and
  // INSERT OR IGNORE (ON CONFLICT DO NOTHING) makes retries idempotent.
  const now = Date.now();
  const persistedMessage = {
    session_id,
    id: client_msg_id,
    direction: 'user' as const,
    ts: now,
    content: text,
  };
  try {
    messageRepo.insert(persistedMessage);
  } catch (insertErr) {
    logger.warn('user_socket_reply_insert_failed', {
      session_id,
      client_msg_id,
      err: insertErr instanceof Error ? insertErr.message : String(insertErr),
    });
    // Continue — don't block delivery on a DB error.
  }

  // Broadcast the persisted message to all connected PWAs so the sender
  // and other tabs see it immediately. The echo uses the full message shape.
  try {
    hub.broadcast({
      type: 'message',
      session_id,
      message: {
        session_id,
        id: client_msg_id,
        direction: 'user',
        ts: now,
        ingested_at: now,
        content: text,
      },
    });
  } catch (broadcastErr) {
    logger.warn('user_socket_reply_broadcast_failed', {
      session_id,
      client_msg_id,
      err: broadcastErr instanceof Error ? broadcastErr.message : String(broadcastErr),
    });
  }

  const payload = {
    type: 'reply' as const,
    text,
    ...(reply_to !== undefined ? { reply_to } : {}),
    client_msg_id,
    origin: 'pwa' as const,
  };

  const result = sessionRegistry.send(session_id, payload);

  if (result.ok) {
    // Success — message persisted + broadcast above; forwarded to fakechat.
    return;
  }

  // HIGH 2: exhaustive switch on SendResult.reason — every arm of the
  // SendResult union must be handled here. The 'buffer_full' arm was added in
  // P2.5; the never-typed default catches any future additions at compile time.
  let reason: WsErrorReason;
  switch (result.reason) {
    case 'no_session':
      logger.debug('user_socket_reply_no_session', { session_id, client_msg_id });
      reason = 'session_not_connected';
      break;
    case 'send_failed':
      // MED 4: warn-log send_failed before sending error frame
      logger.warn('user_socket_reply_send_failed', { session_id, client_msg_id });
      reason = 'send_failed';
      break;
    case 'buffer_full':
      // 'buffer_full' is an internal backpressure signal; surface to PWA as
      // 'send_failed' to keep the public WsErrorReason union narrow.
      logger.warn('user_socket_reply_buffer_full', { session_id, client_msg_id });
      reason = 'send_failed';
      break;
    default: {
      const _exhaustive: never = result.reason;
      throw new Error(`Unhandled SendResult.reason: ${String(_exhaustive)}`);
    }
  }

  sendErrorFrame(ws, { reason, session_id, client_msg_id }, outboundBufferCapBytes, logger, 'reply_error');
}

function handleMarkReadFrame(
  ws: ServerWebSocket<unknown>,
  frame: MarkReadFrame,
  deps: UserSocketDeps,
): void {
  const { messageRepo, sessionRepo, hub, logger, outboundBufferCapBytes } = deps;
  const { session_id, up_to_message_id } = frame;

  // HIGH 1: wrap entire body in try/catch — DB throws must not propagate
  try {
    // Look up the message by composite PK (session_id, id).
    const message = messageRepo.findById(session_id, up_to_message_id);

    // Guard: null or cross-session (findById already enforces session_id match via SQL)
    if (message === null || message.session_id !== session_id) {
      sendErrorFrame(
        ws,
        { reason: 'unknown_message', session_id, up_to_message_id },
        outboundBufferCapBytes,
        logger,
        'mark_read_unknown',
      );
      return;
    }

    // Advance read pointer — SQL uses MAX(COALESCE(last_read_at, 0), ?) so it's monotonic.
    sessionRepo.updateLastReadAt(session_id, message.ts);

    // Fetch refreshed session and broadcast so connected PWAs can update unread_count.
    // MED 1: broadcast failure is isolated in its own try/catch — the DB write already
    // committed, so a broadcast error does NOT warrant an internal_error reply to the PWA.
    const session = sessionRepo.findById(session_id);

    if (session !== null) {
      try {
        hub.broadcast({ type: 'session_update', session });
      } catch (broadcastErr) {
        // Warn (not error): persistent state is correct; only the live push was lost.
        logger.warn('user_socket_mark_read_broadcast_failed', {
          session_id,
          err: broadcastErr instanceof Error ? broadcastErr.message : String(broadcastErr),
        });
      }
    } else {
      logger.warn('user_socket_mark_read_session_vanished', { session_id });
    }
  } catch (err) {
    // HIGH 1: any DB throw → log at error level + send internal_error to PWA
    logger.error('user_socket_mark_read_failed', { session_id, up_to_message_id, err });
    sendErrorFrame(
      ws,
      { reason: 'internal_error', session_id, up_to_message_id },
      outboundBufferCapBytes,
      logger,
      'mark_read_error',
    );
    // Do NOT re-throw: the WS message handler must not propagate.
  }
}

// ── Public: message handler ───────────────────────────────────────────────────

/**
 * Handle an inbound message from a `/user-socket` connection.
 *
 * Validates with a Zod discriminated union (`reply` | `mark_read`).
 * Malformed frames bump a per-socket bad-frame counter; after N consecutive
 * bad frames, the socket is closed with code 1003.  A successful frame resets
 * the counter to 0.
 */
export function handleUserSocketMessage(
  ws: ServerWebSocket<unknown>,
  rawMessage: string | Buffer,
  deps: UserSocketDeps,
): void {
  const { logger, maxBadFrames, outboundBufferCapBytes } = deps;

  // ── Parse JSON ──────────────────────────────────────────────────────────────
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof rawMessage === 'string' ? rawMessage : rawMessage.toString('utf8'));
  } catch {
    bumpBadFrame(ws, maxBadFrames, logger);
    sendErrorFrame(ws, { reason: 'invalid_payload' }, outboundBufferCapBytes, logger, 'user_socket_parse');
    return;
  }

  // ── Validate schema ─────────────────────────────────────────────────────────
  const validation = inboundUserFrame.safeParse(parsed);
  if (!validation.success) {
    bumpBadFrame(ws, maxBadFrames, logger);
    sendErrorFrame(ws, { reason: 'invalid_payload' }, outboundBufferCapBytes, logger, 'user_socket_schema');
    return;
  }

  // ── Reset bad-frame counter on success ──────────────────────────────────────
  badFrameCount.set(ws, 0);

  // ── Dispatch to frame handler ───────────────────────────────────────────────
  const msg = validation.data;
  switch (msg.type) {
    case 'reply':
      handleReplyFrame(ws, msg, deps);
      break;
    case 'mark_read':
      handleMarkReadFrame(ws, msg, deps);
      break;
  }
}

// ── Public: close handler ─────────────────────────────────────────────────────

/**
 * Clean up per-socket state when a user-socket connection closes.
 * Must be called from the server's `close` handler for `kind === 'user-socket'` sockets.
 */
export function handleUserSocketClose(ws: ServerWebSocket<unknown>): void {
  badFrameCount.delete(ws);
}

// ── Internal: bad-frame helpers ───────────────────────────────────────────────

function bumpBadFrame(
  ws: ServerWebSocket<unknown>,
  maxBadFrames: number,
  logger: Logger,
): void {
  const count = (badFrameCount.get(ws) ?? 0) + 1;
  badFrameCount.set(ws, count);
  if (count >= maxBadFrames) {
    logger.warn('user_socket_too_many_bad_frames', { count });
    ws.close(1003, 'too many malformed frames');
  }
}
