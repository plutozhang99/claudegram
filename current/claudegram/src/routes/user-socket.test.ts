import { describe, it, expect, beforeEach, mock } from 'bun:test';
import type { ServerWebSocket } from 'bun';
import type { SessionRegistry } from '../ws/session-registry.js';
import type { Hub } from '../ws/hub.js';
import type { MessageRepo, SessionRepo, Message, Session } from '../repo/types.js';
import type { Logger } from '../logger.js';
import { handleUserSocketMessage, type UserSocketDeps } from './user-socket.js';

// ── Mock factories ────────────────────────────────────────────────────────────

/**
 * LOW fix: capture a stable `self` reference so the close mock updates
 * closedWith on the same object that is returned, without relying on a
 * module-level `let ws` variable.
 */
function makeMockWs(): ServerWebSocket<unknown> & { sentMessages: string[]; closedWith: { code: number; reason: string } | null } {
  const self: Record<string, unknown> = {
    sentMessages: [] as string[],
    closedWith: null,
    getBufferedAmount: mock(() => 0),
    data: {},
  };

  self.send = mock((text: string) => {
    (self.sentMessages as string[]).push(text);
  });

  self.close = mock((code: number, reason: string) => {
    self.closedWith = { code, reason };
  });

  return self as unknown as ServerWebSocket<unknown> & { sentMessages: string[]; closedWith: { code: number; reason: string } | null };
}

function makeSession(id = 's1'): Session {
  return {
    id,
    name: 'Test Session',
    first_seen_at: 1000,
    last_seen_at: 2000,
    status: 'active',
    last_read_at: 0,
  };
}

function makeMessage(session_id = 's1', id = 'm1', ts = 500): Message {
  return {
    session_id,
    id,
    direction: 'assistant',
    ts,
    ingested_at: ts + 10,
    content: 'Hello',
  };
}

function makeLogger(): Logger {
  return {
    debug: mock(() => {}),
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
  } as unknown as Logger;
}

function makeDeps(overrides: Partial<{
  sessionRegistry: Partial<SessionRegistry>;
  messageRepo: Partial<MessageRepo>;
  sessionRepo: Partial<SessionRepo>;
  hub: Partial<Hub>;
  logger: Logger;
  maxBadFrames: number;
  outboundBufferCapBytes: number;
}>= {}): UserSocketDeps {
  return {
    sessionRegistry: {
      send: mock(() => ({ ok: true })),
      register: mock(() => ({ [Symbol.dispose]: mock(() => {}) })),
      unregister: mock(() => {}),
      size: 0,
      ...overrides.sessionRegistry,
    } as unknown as SessionRegistry,
    messageRepo: {
      insert: mock(() => {}),
      findBySession: mock(() => []),
      findBySessionPage: mock(() => ({ messages: [], has_more: false })),
      findById: mock(() => null),
      ...overrides.messageRepo,
    } as unknown as MessageRepo,
    sessionRepo: {
      upsert: mock(() => {}),
      findById: mock(() => null),
      findAll: mock(() => []),
      updateLastReadAt: mock(() => {}),
      ...overrides.sessionRepo,
    } as unknown as SessionRepo,
    hub: {
      add: mock(() => {}),
      remove: mock(() => {}),
      broadcast: mock(() => {}),
      size: 0,
      ...overrides.hub,
    } as unknown as Hub,
    logger: overrides.logger ?? makeLogger(),
    maxBadFrames: overrides.maxBadFrames ?? 5,
    outboundBufferCapBytes: overrides.outboundBufferCapBytes ?? 1_048_576,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

let ws: ReturnType<typeof makeMockWs>;

beforeEach(() => {
  ws = makeMockWs();
});

describe('handleUserSocketMessage — reply', () => {
  it('1. reply hit → sessionRegistry.send called with correct payload, no error frame sent to PWA', () => {
    const sendMock = mock(() => ({ ok: true as const }));
    const deps = makeDeps({ sessionRegistry: { send: sendMock } });

    const frame = JSON.stringify({
      type: 'reply',
      session_id: 's1',
      text: 'Hello world',
      client_msg_id: 'cid1',
    });
    handleUserSocketMessage(ws, frame, deps);

    expect(sendMock).toHaveBeenCalledTimes(1);
    const [sessionId, payload] = (sendMock as ReturnType<typeof mock>).mock.calls[0] as [string, unknown];
    expect(sessionId).toBe('s1');
    expect(payload).toMatchObject({
      type: 'reply',
      text: 'Hello world',
      client_msg_id: 'cid1',
      origin: 'pwa',
    });
    // No error frame sent back
    expect(ws.sentMessages.length).toBe(0);
  });

  it('2. reply miss (no_session) → error frame {type:error, reason:session_not_connected} back to PWA', () => {
    const sendMock = mock(() => ({ ok: false as const, reason: 'no_session' as const }));
    const deps = makeDeps({ sessionRegistry: { send: sendMock } });

    const frame = JSON.stringify({
      type: 'reply',
      session_id: 's1',
      text: 'Hello',
      client_msg_id: 'cid2',
    });
    handleUserSocketMessage(ws, frame, deps);

    expect(ws.sentMessages.length).toBe(1);
    const errFrame = JSON.parse(ws.sentMessages[0]);
    expect(errFrame.type).toBe('error');
    expect(errFrame.reason).toBe('session_not_connected');
    expect(errFrame.session_id).toBe('s1');
    expect(errFrame.client_msg_id).toBe('cid2');
  });

  it('3. reply send_failed → error frame {type:error, reason:send_failed} back to PWA', () => {
    const sendMock = mock(() => ({ ok: false as const, reason: 'send_failed' as const }));
    const deps = makeDeps({ sessionRegistry: { send: sendMock } });

    const frame = JSON.stringify({
      type: 'reply',
      session_id: 's1',
      text: 'Hi',
      client_msg_id: 'cid3',
    });
    handleUserSocketMessage(ws, frame, deps);

    expect(ws.sentMessages.length).toBe(1);
    const errFrame = JSON.parse(ws.sentMessages[0]);
    expect(errFrame.type).toBe('error');
    expect(errFrame.reason).toBe('send_failed');
    expect(errFrame.session_id).toBe('s1');
    expect(errFrame.client_msg_id).toBe('cid3');
  });

  it('1b. reply with optional reply_to field → forwarded in payload', () => {
    const sendMock = mock(() => ({ ok: true as const }));
    const deps = makeDeps({ sessionRegistry: { send: sendMock } });

    const frame = JSON.stringify({
      type: 'reply',
      session_id: 's1',
      text: 'Hello',
      reply_to: 'm_parent',
      client_msg_id: 'cid4',
    });
    handleUserSocketMessage(ws, frame, deps);

    const [, payload] = (sendMock as ReturnType<typeof mock>).mock.calls[0] as [string, unknown];
    expect((payload as Record<string, unknown>).reply_to).toBe('m_parent');
  });

  it('buffer_full → error frame {type:error, reason:send_failed} sent to PWA (internal reason not exposed)', () => {
    const sendMock = mock(() => ({ ok: false as const, reason: 'buffer_full' as const }));
    const deps = makeDeps({ sessionRegistry: { send: sendMock } });

    const frame = JSON.stringify({
      type: 'reply',
      session_id: 's1',
      text: 'Hi',
      client_msg_id: 'cid-buf',
    });
    handleUserSocketMessage(ws, frame, deps);

    expect(ws.sentMessages.length).toBe(1);
    const errFrame = JSON.parse(ws.sentMessages[0]);
    expect(errFrame.type).toBe('error');
    // 'buffer_full' is internal — PWA sees 'send_failed', NOT 'buffer_full'
    expect(errFrame.reason).toBe('send_failed');
    expect(errFrame.session_id).toBe('s1');
    expect(errFrame.client_msg_id).toBe('cid-buf');
  });

  it('MED 4. send_failed → logger.warn called before error frame', () => {
    const sendMock = mock(() => ({ ok: false as const, reason: 'send_failed' as const }));
    const logger = makeLogger();
    const deps = makeDeps({ sessionRegistry: { send: sendMock }, logger });

    handleUserSocketMessage(ws, JSON.stringify({
      type: 'reply',
      session_id: 's1',
      text: 'Hi',
      client_msg_id: 'cid5',
    }), deps);

    expect((logger.warn as ReturnType<typeof mock>).mock.calls.length).toBeGreaterThan(0);
    const warnArg = (logger.warn as ReturnType<typeof mock>).mock.calls[0][0];
    expect(warnArg).toBe('user_socket_reply_send_failed');
  });
});

describe('handleUserSocketMessage — mark_read', () => {
  it('4. mark_read valid → updateLastReadAt called with message.ts + hub.broadcast fires with refreshed session', () => {
    const session = makeSession('s1');
    const message = makeMessage('s1', 'm1', 500);
    const findByIdMsgMock = mock(() => message);
    const updateMock = mock(() => {});
    const findByIdSessMock = mock(() => ({ ...session, last_read_at: 500 }));
    const broadcastMock = mock(() => {});

    const deps = makeDeps({
      messageRepo: { findById: findByIdMsgMock },
      sessionRepo: { updateLastReadAt: updateMock, findById: findByIdSessMock },
      hub: { broadcast: broadcastMock },
    });

    const frame = JSON.stringify({
      type: 'mark_read',
      session_id: 's1',
      up_to_message_id: 'm1',
    });
    handleUserSocketMessage(ws, frame, deps);

    expect(findByIdMsgMock).toHaveBeenCalledTimes(1);
    expect((findByIdMsgMock as ReturnType<typeof mock>).mock.calls[0]).toEqual(['s1', 'm1']);
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect((updateMock as ReturnType<typeof mock>).mock.calls[0]).toEqual(['s1', 500]);
    expect(findByIdSessMock).toHaveBeenCalledWith('s1');
    expect(broadcastMock).toHaveBeenCalledTimes(1);
    const broadcastArg = (broadcastMock as ReturnType<typeof mock>).mock.calls[0][0] as Record<string, unknown>;
    expect(broadcastArg.type).toBe('session_update');
    // No error frame sent
    expect(ws.sentMessages.length).toBe(0);
  });

  it('5. mark_read unknown message → error frame {type:error, reason:unknown_message}', () => {
    const findByIdMsgMock = mock(() => null);
    const deps = makeDeps({ messageRepo: { findById: findByIdMsgMock } });

    const frame = JSON.stringify({
      type: 'mark_read',
      session_id: 's1',
      up_to_message_id: 'no-such-msg',
    });
    handleUserSocketMessage(ws, frame, deps);

    expect(ws.sentMessages.length).toBe(1);
    const errFrame = JSON.parse(ws.sentMessages[0]);
    expect(errFrame.type).toBe('error');
    expect(errFrame.reason).toBe('unknown_message');
    expect(errFrame.session_id).toBe('s1');
    expect(errFrame.up_to_message_id).toBe('no-such-msg');
  });

  it('6. mark_read cross-session (message exists but different session_id) → unknown_message error', () => {
    // Message belongs to s2, but request says s1
    const message = makeMessage('s2', 'm1', 500);
    const findByIdMsgMock = mock(() => message);
    const deps = makeDeps({ messageRepo: { findById: findByIdMsgMock } });

    const frame = JSON.stringify({
      type: 'mark_read',
      session_id: 's1',
      up_to_message_id: 'm1',
    });
    handleUserSocketMessage(ws, frame, deps);

    expect(ws.sentMessages.length).toBe(1);
    const errFrame = JSON.parse(ws.sentMessages[0]);
    expect(errFrame.type).toBe('error');
    expect(errFrame.reason).toBe('unknown_message');
  });

  it('HIGH 1. mark_read DB throw (findById throws) → internal_error frame sent, no broadcast fires', () => {
    const findByIdMsgMock = mock(() => { throw new Error('DB connection lost'); });
    const broadcastMock = mock(() => {});
    const logger = makeLogger();
    const deps = makeDeps({
      messageRepo: { findById: findByIdMsgMock },
      hub: { broadcast: broadcastMock },
      logger,
    });

    const frame = JSON.stringify({
      type: 'mark_read',
      session_id: 's1',
      up_to_message_id: 'm1',
    });
    // Must not throw — WS message handler must never propagate
    expect(() => handleUserSocketMessage(ws, frame, deps)).not.toThrow();

    // Error frame sent back to PWA
    expect(ws.sentMessages.length).toBe(1);
    const errFrame = JSON.parse(ws.sentMessages[0]);
    expect(errFrame.type).toBe('error');
    expect(errFrame.reason).toBe('internal_error');
    expect(errFrame.session_id).toBe('s1');

    // Broadcast must NOT have fired (DB write never committed)
    expect(broadcastMock).not.toHaveBeenCalled();

    // logger.error called with structured context
    expect((logger.error as ReturnType<typeof mock>).mock.calls.length).toBeGreaterThan(0);
    const errorArg = (logger.error as ReturnType<typeof mock>).mock.calls[0][0];
    expect(errorArg).toBe('user_socket_mark_read_failed');
  });

  it('MED 1. mark_read broadcast throw after successful DB write → warn logged, no internal_error to PWA', () => {
    const message = makeMessage('s1', 'm1', 500);
    const session = makeSession('s1');
    const broadcastMock = mock(() => { throw new Error('hub exploded'); });
    const logger = makeLogger();
    const deps = makeDeps({
      messageRepo: { findById: mock(() => message) },
      sessionRepo: {
        updateLastReadAt: mock(() => {}),
        findById: mock(() => ({ ...session, last_read_at: 500 })),
      },
      hub: { broadcast: broadcastMock },
      logger,
    });

    const frame = JSON.stringify({
      type: 'mark_read',
      session_id: 's1',
      up_to_message_id: 'm1',
    });
    expect(() => handleUserSocketMessage(ws, frame, deps)).not.toThrow();

    // No internal_error frame — DB write succeeded
    expect(ws.sentMessages.length).toBe(0);

    // warn logged for the broadcast failure
    const warnCalls = (logger.warn as ReturnType<typeof mock>).mock.calls;
    const broadcastWarn = warnCalls.find(([name]) => name === 'user_socket_mark_read_broadcast_failed');
    expect(broadcastWarn).toBeDefined();

    // error NOT called — the persistent state is correct
    expect((logger.error as ReturnType<typeof mock>).mock.calls.length).toBe(0);
  });
});

describe('handleUserSocketMessage — bad-frame counter', () => {
  it('7. malformed JSON → invalid_payload error + counter bumped (but not closed at 1)', () => {
    const deps = makeDeps();
    handleUserSocketMessage(ws, 'not-json!!!', deps);

    expect(ws.sentMessages.length).toBe(1);
    expect(JSON.parse(ws.sentMessages[0]).reason).toBe('invalid_payload');
    expect(ws.closedWith).toBeNull();
  });

  it('8. Zod failure (reply missing text) → invalid_payload + counter bumped', () => {
    const deps = makeDeps();
    const frame = JSON.stringify({ type: 'reply', session_id: 's1', client_msg_id: 'cid1' }); // missing text
    handleUserSocketMessage(ws, frame, deps);

    expect(ws.sentMessages.length).toBe(1);
    expect(JSON.parse(ws.sentMessages[0]).reason).toBe('invalid_payload');
    expect(ws.closedWith).toBeNull();
  });

  it('9. N-strike close: 5 malformed frames in a row → ws.close(1003) on 5th', () => {
    const deps = makeDeps({ maxBadFrames: 5 });
    for (let i = 0; i < 5; i++) {
      handleUserSocketMessage(ws, 'bad-json', deps);
    }
    expect(ws.closedWith).not.toBeNull();
    expect(ws.closedWith!.code).toBe(1003);
  });

  it('10. Successful frame after 4 malformed → counter resets (5th malformed does NOT close)', () => {
    const deps = makeDeps({ maxBadFrames: 5 });

    // 4 bad frames
    for (let i = 0; i < 4; i++) {
      handleUserSocketMessage(ws, 'bad', deps);
    }
    expect(ws.closedWith).toBeNull(); // not closed yet

    // 1 good frame (reply hit) → resets counter
    const goodFrame = JSON.stringify({
      type: 'reply',
      session_id: 's1',
      text: 'Hi',
      client_msg_id: 'cidX',
    });
    handleUserSocketMessage(ws, goodFrame, deps);
    expect(ws.closedWith).toBeNull(); // still not closed

    // 1 more bad frame — counter was reset to 0 after good, so now at 1, not 5
    handleUserSocketMessage(ws, 'bad', deps);
    expect(ws.closedWith).toBeNull(); // still not closed, counter is now 1
  });
});
