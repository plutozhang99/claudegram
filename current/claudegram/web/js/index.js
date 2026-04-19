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
const renderer = createRenderer({ store, onSelectSession, onSendReply, onDeleteSession });

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

ws.on('error', (frame) => {
  // Server-side rejection of a frame we sent. Mark the pending optimistic
  // echo as failed; the renderer shows it inline.
  console.error('claudegram error frame', frame);
  if (frame && typeof frame.client_msg_id === 'string') {
    store.markPendingFailed(frame.client_msg_id, frame.reason ?? 'unknown');
  }
});

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

/**
 * Select a session: mark active and hydrate messages if not yet loaded.
 * @param {string} id
 */
async function onSelectSession(id) {
  store.setActive(id);
  await store.hydrateMessages(id, fetchMessages);
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
