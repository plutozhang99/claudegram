/**
 * In-memory application store with event emission.
 * All mutations return new state; the map references are replaced, not mutated.
 */

/**
 * @returns {{
 *   state: { me: null|object, sessions: Map, messagesBySession: Map, hasMoreBySession: Map, activeId: null|string },
 *   on(evt: string, handler: Function): void,
 *   off(evt: string, handler: Function): void,
 *   setActive(sessionId: string): void,
 *   applySessions(sessions: object[]): void,
 *   applyMessages(sessionId: string, messages: object[], has_more: boolean): void,
 *   applyLiveMessage(sessionId: string, message: object): void,
 *   applySessionUpdate(session: object): void,
 *   hydrateMessages(sessionId: string, fetcher: Function): Promise<void>
 * }}
 */
export function createStore() {
  const state = {
    me: null,
    sessions: new Map(),
    messagesBySession: new Map(),
    hasMoreBySession: new Map(),
    activeId: null,
  };

  /** @type {Map<string, Set<Function>>} */
  const listeners = new Map();

  function emit(evt) {
    const set = listeners.get(evt);
    if (!set) return;
    for (const fn of set) {
      try { fn(state); } catch (e) { console.error('store listener error', e); }
    }
  }

  function on(evt, handler) {
    if (!listeners.has(evt)) listeners.set(evt, new Set());
    listeners.get(evt).add(handler);
  }

  function off(evt, handler) {
    listeners.get(evt)?.delete(handler);
  }

  function setActive(sessionId) {
    state.activeId = sessionId;
    // clear unread for newly active session
    const session = state.sessions.get(sessionId);
    if (session) {
      state.sessions = new Map(state.sessions);
      state.sessions.set(sessionId, { ...session, unread_count: 0 });
    }
    emit('change');
  }

  function applySessions(sessions) {
    state.sessions = new Map(sessions.map((s) => [s.id, s]));
    emit('change');
  }

  function applyMessages(sessionId, messages, has_more) {
    state.messagesBySession = new Map(state.messagesBySession);
    // Server returns DESC for pagination; reverse to chronological for display.
    const chronological = Array.isArray(messages) ? messages.slice().reverse() : [];
    state.messagesBySession.set(sessionId, chronological);
    state.hasMoreBySession = new Map(state.hasMoreBySession);
    state.hasMoreBySession.set(sessionId, has_more);
    emit('change');
  }

  function applyLiveMessage(sessionId, message) {
    // Only append if session is already hydrated
    if (!state.messagesBySession.has(sessionId)) return;

    const prev = state.messagesBySession.get(sessionId);
    state.messagesBySession = new Map(state.messagesBySession);

    // FIX 5 dedup: if an incoming message id matches an existing pending message
    // (optimistic echo), REPLACE it rather than appending a duplicate.
    const existingIdx = prev.findIndex((m) => m.id === message.id);
    if (existingIdx !== -1) {
      const updated = prev.slice();
      updated[existingIdx] = { ...message, pending: false };
      state.messagesBySession.set(sessionId, updated);
    } else {
      state.messagesBySession.set(sessionId, [...prev, message]);
    }

    // Bump unread count if not the active session (only for assistant messages,
    // since the user originated this message themselves).
    if (sessionId !== state.activeId && message.direction !== 'user') {
      const session = state.sessions.get(sessionId);
      if (session) {
        state.sessions = new Map(state.sessions);
        state.sessions.set(sessionId, {
          ...session,
          unread_count: (session.unread_count ?? 0) + 1,
        });
      }
    }

    emit('change');
  }

  function applySessionUpdate(session) {
    // FIX 7: if the server signals deletion, remove from state rather than upsert.
    if (session.deleted === true) {
      state.sessions = new Map(state.sessions);
      state.sessions.delete(session.id);
      // If the deleted session was active, deactivate.
      if (state.activeId === session.id) {
        state.activeId = null;
      }
      emit('change');
      return;
    }
    state.sessions = new Map(state.sessions);
    const existing = state.sessions.get(session.id) ?? {};
    state.sessions.set(session.id, { ...existing, ...session });
    emit('change');
  }

  function applySessionDeleted(sessionId) {
    state.sessions = new Map(state.sessions);
    state.sessions.delete(sessionId);
    if (state.activeId === sessionId) {
      state.activeId = null;
    }
    emit('change');
  }

  /**
   * Append a locally-originated message (e.g. the user just hit send) to the
   * active session. Carries a `pending: true` flag so the renderer can style
   * it distinctly. client_msg_id lets us correlate a later error frame.
   * No-op if the target session isn't hydrated yet.
   * @param {string} sessionId
   * @param {object} message
   */
  function applyPendingMessage(sessionId, message) {
    if (!state.messagesBySession.has(sessionId)) return;
    const prev = state.messagesBySession.get(sessionId);
    state.messagesBySession = new Map(state.messagesBySession);
    state.messagesBySession.set(sessionId, [...prev, message]);
    emit('change');
  }

  /**
   * Mark a pending message as failed, keyed by client_msg_id. Used when
   * claudegram returns {type:'error', client_msg_id, reason}.
   * @param {string} clientMsgId
   * @param {string} reason
   */
  function markPendingFailed(clientMsgId, reason) {
    let changed = false;
    for (const [sid, messages] of state.messagesBySession) {
      const idx = messages.findIndex((m) => m.client_msg_id === clientMsgId && m.pending);
      if (idx === -1) continue;
      const copy = messages.slice();
      copy[idx] = { ...copy[idx], pending: false, failed: true, failed_reason: reason };
      if (!changed) {
        state.messagesBySession = new Map(state.messagesBySession);
        changed = true;
      }
      state.messagesBySession.set(sid, copy);
    }
    if (changed) emit('change');
  }

  /** @type {Set<string>} */
  const hydrating = new Set();

  async function hydrateMessages(sessionId, fetcher) {
    if (state.messagesBySession.has(sessionId)) return;
    if (hydrating.has(sessionId)) return;
    hydrating.add(sessionId);
    try {
      const { messages, has_more } = await fetcher(sessionId);
      applyMessages(sessionId, messages, has_more);
    } finally {
      hydrating.delete(sessionId);
    }
  }

  return {
    state,
    on,
    off,
    setActive,
    applySessions,
    applyMessages,
    applyLiveMessage,
    applySessionUpdate,
    applySessionDeleted,
    applyPendingMessage,
    markPendingFailed,
    hydrateMessages,
  };
}
