/**
 * Boot orchestration for the claudegram PWA.
 * Wires together store, renderer, WebSocket client, and notifier.
 */

import { createWsClient } from './ws.js';
import { createStore } from './store.js';
import { createRenderer } from './render.js';
import { createNotifier } from './notify.js';

const store = createStore();
const notifier = createNotifier();
const ws = createWsClient(wsUrl());
const renderer = createRenderer({ store, onSelectSession, onSendReply, onDeleteSession, onRenameSession });

ws.on('message', ({ session_id, message }) => {
  store.applyLiveMessage(session_id, message);
  if (session_id !== store.state.activeId) {
    notifier.notifyNewMessage(session_id, message);
  }
});

ws.on('session_update', ({ session }) => {
  store.applySessionUpdate(session);
});

ws.on('session_deleted', ({ session_id }) => {
  store.applySessionDeleted(session_id);
});

ws.on('statusline', ({ session_id, statusline }) => {
  store.applyStatusline(session_id, statusline);
});

// On (re)connect, advance the read pointer for the active session. Handles
// the boot case where mark_read fires before the WS is open, and the
// reconnect case where the server may have missed an earlier send.
ws.on('connect', () => {
  if (store.state.activeId !== null) {
    maybeMarkRead(store.state.activeId);
  }
});

// When a live assistant message arrives for the active session, immediately
// advance the server-side read pointer so a later refresh doesn't resurrect
// the unread count. Only fires for messages the user is actually looking at.
ws.on('message', ({ session_id, message }) => {
  if (
    session_id === store.state.activeId &&
    message &&
    message.direction !== 'user' &&
    typeof message.id === 'string'
  ) {
    ws.send({ type: 'mark_read', session_id, up_to_message_id: message.id });
  }
});

ws.on('error', (frame) => {
  // Server-side rejection of a frame we sent. Mark the pending optimistic
  // echo as failed; the renderer shows it inline.
  console.error('claudegram error frame', frame);
  if (frame && typeof frame.client_msg_id === 'string') {
    store.markPendingFailed(frame.client_msg_id, frame.reason ?? 'unknown');
  }
});

// ── Header status pills + compose-row session badge ───────────────
// system-pill is driven by ws.js itself (open/closed/connecting).
// fakechat-pill reacts to store changes (aggregate of all sessions).
// The per-session online indicator lives in the compose-row session-badge.
function updateStatusPills() {
  // Fakechat pill: count online vs total. connected:true is set by /api/sessions
  // and updated live via session_update broadcasts (P2-hotfix2).
  const sessions = Array.from(store.state.sessions.values());
  const total = sessions.length;
  const online = sessions.filter((s) => s.connected === true).length;
  const fakechatPill = document.getElementById('fakechat-pill');
  if (fakechatPill) {
    const valueEl = fakechatPill.querySelector('.status-value');
    if (valueEl) valueEl.textContent = `${online}/${total}`;
    let state = 'empty';
    if (total > 0) {
      if (online === 0) state = 'all-offline';
      else if (online === total) state = 'all';
      else state = 'partial';
    }
    fakechatPill.setAttribute('data-state', state);
  }

  // Compose-row session badge: active session's name + connection state.
  const sessionBadge = document.getElementById('session-badge');
  const sessionBadgeName = document.getElementById('session-badge-name');
  if (sessionBadge && sessionBadgeName) {
    const activeId = store.state.activeId;
    if (activeId === null) {
      sessionBadge.setAttribute('data-connected', 'none');
      sessionBadge.title = 'No active session';
      sessionBadgeName.textContent = 'no session';
    } else {
      const active = store.state.sessions.get(activeId);
      const name = active?.name ?? activeId;
      let connState = 'unknown';
      if (active?.connected === true) connState = 'online';
      else if (active?.connected === false) connState = 'offline';
      sessionBadge.setAttribute('data-connected', connState);
      sessionBadge.title = `${name} — ${connState}`;
      sessionBadgeName.textContent = name;
    }
  }
}

store.on('change', updateStatusPills);
// Initial paint in case sessions hydrate before first store 'change' fires.
updateStatusPills();

/**
 * Send a reply via the user-socket WebSocket. Appends an optimistic local
 * echo of the user's own message so they can see what they sent (the real
 * message never returns because of the P2.4 origin-tag echo-skip). Returns
 * whether the send was dispatched (false if the socket is not currently open).
 * @param {string} text
 * @returns {boolean}
 */
function onSendReply(text) {
  const session_id = store.state.activeId;
  if (session_id === null) return false;
  const client_msg_id =
    (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function')
      ? globalThis.crypto.randomUUID()
      : `cm-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const ok = ws.send({ type: 'reply', session_id, text, client_msg_id });
  if (ok) {
    // Optimistic echo: use client_msg_id as the message id (aligned with what
    // the server will echo back via hub.broadcast so the dedup in
    // applyLiveMessage can replace this pending entry instead of appending).
    store.applyPendingMessage(session_id, {
      id: client_msg_id,
      client_msg_id,
      direction: 'user',
      content: text,
      ts: Date.now(),
      pending: true,
    });
  }
  return ok;
}

/**
 * Delete a session by id. Calls DELETE /api/sessions/:id.
 * Removes from local state on success.
 * @param {string} id
 * @returns {Promise<boolean>} true if deleted, false on error
 */
async function onDeleteSession(id) {
  if (!confirm(`Delete session "${store.state.sessions.get(id)?.name ?? id}"? This cannot be undone.`)) {
    return false;
  }
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (res.ok) {
      store.applySessionDeleted(id);
      return true;
    }
    console.error('deleteSession: non-ok', res.status);
  } catch (e) {
    console.error('deleteSession error', e);
  }
  return false;
}

/**
 * Rename a session by id. Prompts the user for a new name and PATCHes the server.
 * The server broadcasts session_update which the store will apply — no local mutation needed.
 * @param {string} id
 */
async function onRenameSession(id) {
  const current = store.state.sessions.get(id);
  const next = prompt('Rename session', current?.name ?? id);
  if (next === null) return; // user cancelled
  const trimmed = next.trim();
  if (trimmed.length === 0 || trimmed === current?.name) return;
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: trimmed }),
    });
    if (!res.ok) {
      console.error('renameSession: non-ok', res.status);
    }
    // On success, server broadcasts session_update which store.applySessionUpdate handles.
  } catch (e) {
    console.error('renameSession error', e);
  }
}

// Boot sequence
(async () => {
  await fetchMe();
  await fetchSessions();
  if (store.state.sessions.size > 0) {
    const firstId = store.state.sessions.keys().next().value;
    await onSelectSession(firstId);
  }
})();

// Sidebar toggle
document.getElementById('sidebar-toggle')?.addEventListener('click', toggleSidebar);

// Clear-offline: bulk-delete all sessions that aren't currently connected.
// Lets users tidy up historical ghost rows left behind by older fakechat
// builds without clicking × on every row.
document.getElementById('clear-offline-btn')?.addEventListener('click', async () => {
  const offline = Array.from(store.state.sessions.values()).filter((s) => s.connected !== true);
  if (offline.length === 0) {
    alert('No offline sessions to clear.');
    return;
  }
  if (!confirm(`Delete ${offline.length} offline session${offline.length === 1 ? '' : 's'}? This cannot be undone.`)) {
    return;
  }
  try {
    const res = await fetch('/api/sessions?offline=true', { method: 'DELETE' });
    if (!res.ok) { console.error('clear-offline: non-ok', res.status); return; }
    const data = await res.json();
    if (data && Array.isArray(data.deleted)) {
      for (const id of data.deleted) store.applySessionDeleted(id);
    }
  } catch (e) {
    console.error('clear-offline error', e);
  }
});

/**
 * Select a session: mark active and hydrate messages if not yet loaded.
 * @param {string} id
 */
async function onSelectSession(id) {
  store.setActive(id);
  await store.hydrateMessages(id, fetchMessages);
  // After hydration, advance the server-side read pointer to the latest
  // message so that refreshing the page doesn't resurrect the unread count.
  maybeMarkRead(id);
}

/**
 * Send a mark_read frame for the latest assistant message in a session,
 * if the session is hydrated and has any assistant messages.
 * @param {string} sessionId
 */
function maybeMarkRead(sessionId) {
  const messages = store.state.messagesBySession.get(sessionId);
  if (!messages || messages.length === 0) return;
  // Walk backwards to the most recent message regardless of direction —
  // the server's monotonic MAX(last_read_at, ts) guarantees this is safe
  // even if the last message is a user message.
  const last = messages[messages.length - 1];
  if (!last || typeof last.id !== 'string') return;
  ws.send({ type: 'mark_read', session_id: sessionId, up_to_message_id: last.id });
}

/**
 * Build the WebSocket URL from the current page origin.
 * @returns {string}
 */
function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/user-socket`;
}

/**
 * Toggle the sidebar open/closed via aria-expanded on the toggle button.
 */
function toggleSidebar() {
  const btn = document.getElementById('sidebar-toggle');
  const sidebar = document.getElementById('sidebar');
  if (!btn || !sidebar) return;
  const expanded = btn.getAttribute('aria-expanded') === 'true';
  btn.setAttribute('aria-expanded', String(!expanded));
  sidebar.classList.toggle('sidebar--open', !expanded);
}

/**
 * Fetch the current user and store in state.
 */
async function fetchMe() {
  try {
    const res = await fetch('/api/me');
    if (!res.ok) { console.error('fetchMe: non-ok', res.status); return; }
    const data = await res.json();
    if (data.ok) store.state.me = data.email;
  } catch (e) {
    console.error('fetchMe error', e);
  }
}

/**
 * Fetch all sessions and populate the store.
 */
async function fetchSessions() {
  try {
    const res = await fetch('/api/sessions');
    if (!res.ok) { console.error('fetchSessions: non-ok', res.status); return; }
    const data = await res.json();
    if (data.ok) store.applySessions(data.sessions);
  } catch (e) {
    console.error('fetchSessions error', e);
  }
}

/**
 * Fetch messages for a given session.
 * @param {string} sessionId
 * @returns {Promise<{ messages: object[], has_more: boolean }>}
 */
async function fetchMessages(sessionId) {
  try {
    const res = await fetch(`/api/messages?session_id=${encodeURIComponent(sessionId)}`);
    if (!res.ok) { console.error('fetchMessages: non-ok', res.status); return { messages: [], has_more: false }; }
    const data = await res.json();
    if (data.ok) return { messages: data.messages, has_more: data.has_more };
  } catch (e) {
    console.error('fetchMessages error', e);
  }
  return { messages: [], has_more: false };
}
