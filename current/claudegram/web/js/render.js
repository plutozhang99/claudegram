/**
 * DOM renderer that reacts to store 'change' events and updates the UI.
 */

/**
 * Format a timestamp string or epoch ms into HH:MM:SS.
 * @param {string|number} ts
 * @returns {string}
 */
function formatTime(ts) {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return String(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

/**
 * @param {{
 *   store: ReturnType<import('./store.js').createStore>,
 *   onSelectSession: (id: string) => void,
 *   onSendReply: (text: string) => boolean,
 *   onDeleteSession: (id: string) => Promise<boolean>,
 *   onRenameSession: (id: string) => Promise<void>,
 * }} opts
 */
export function createRenderer({ store, onSelectSession, onSendReply, onDeleteSession, onRenameSession }) {
  const sessionListEl = document.getElementById('session-list');
  const messagesEl = document.getElementById('messages');
  const composeTextEl = document.getElementById('compose-text');
  const sendBtnEl = document.getElementById('send-btn');
  const composeFormEl = document.getElementById('compose');

  let prevMessageCount = 0;

  // Wire compose textarea to enable/disable send button
  composeTextEl?.addEventListener('input', updateSendBtn);

  // Send reply on form submit (Enter or Send button click)
  composeFormEl?.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!composeTextEl || !sendBtnEl) return;
    const text = composeTextEl.value.trim();
    if (text.length === 0 || store.state.activeId === null) return;
    const ok = onSendReply(text);
    if (ok) {
      composeTextEl.value = '';
      updateSendBtn();
    }
    // If !ok the WS is not open — leave the textarea so the user can retry.
  });

  function updateSendBtn() {
    if (!sendBtnEl || !composeTextEl) return;
    const hasText = composeTextEl.value.trim().length > 0;
    const hasSession = store.state.activeId !== null;
    // FIX 2/3/4: disable send when the active session has no live fakechat connection.
    const activeSession = store.state.activeId !== null ? store.state.sessions.get(store.state.activeId) : null;
    const isConnected = activeSession?.connected !== false; // undefined = legacy (assume connected)
    sendBtnEl.disabled = !(hasText && hasSession && isConnected);
  }

  function renderSessions() {
    if (!sessionListEl) return;
    const { sessions, activeId } = store.state;

    if (sessions.size === 0) {
      sessionListEl.innerHTML = '<li class="session-placeholder" role="presentation">no sessions yet</li>';
      return;
    }

    // Remove placeholder if present
    const placeholder = sessionListEl.querySelector('.session-placeholder');
    if (placeholder) placeholder.remove();

    const existingIds = new Set();
    for (const li of sessionListEl.querySelectorAll('li[data-session-id]')) {
      existingIds.add(li.dataset.sessionId);
    }

    for (const [id, session] of sessions) {
      const isActive = id === activeId;
      let li = sessionListEl.querySelector(`li[data-session-id="${CSS.escape(id)}"]`);
      if (!li) {
        li = document.createElement('li');
        li.dataset.sessionId = id;
        li.setAttribute('role', 'option');
        li.setAttribute('tabindex', '0');
        li.addEventListener('click', () => onSelectSession(id));
        li.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onSelectSession(id);
          }
        });
        sessionListEl.appendChild(li);
      }

      li.setAttribute('aria-selected', String(isActive));
      li.classList.toggle('active', isActive);

      // Connection state drives the left bar (replaces the prior status dot).
      const connState = session.connected === true ? 'online' : session.connected === false ? 'offline' : 'unknown';
      li.dataset.connected = connState;
      li.title = `${session.name ?? id} — ${connState}`;

      const unread = session.unread_count ?? 0;
      const badge = unread > 0 ? ` <span class="unread-badge" aria-label="${unread} unread">${unread}</span>` : '';

      // FIX B: rename button (pencil affordance), FIX 7: delete button.
      const renameBtn = `<button class="session-rename" aria-label="Rename session" title="Rename session">✎</button>`;
      const deleteBtn = `<button class="session-delete" aria-label="Delete session" title="Delete session">×</button>`;
      li.innerHTML = `<span class="session-name">${escapeHtml(session.name ?? id)}</span><span class="sr-only"> (${connState})</span>${badge}${renameBtn}${deleteBtn}`;

      // Wire rename button (each render replaces innerHTML so re-attach is required).
      const renBtn = li.querySelector('.session-rename');
      if (renBtn) {
        renBtn.addEventListener('click', (e) => {
          e.stopPropagation(); // don't trigger session selection
          onRenameSession(id);
        });
      }

      // Wire delete button (each render replaces innerHTML so re-attach is required).
      const delBtn = li.querySelector('.session-delete');
      if (delBtn) {
        delBtn.addEventListener('click', (e) => {
          e.stopPropagation(); // don't trigger session selection
          onDeleteSession(id);
        });
      }
    }

    // Remove stale entries
    for (const li of sessionListEl.querySelectorAll('li[data-session-id]')) {
      if (!sessions.has(li.dataset.sessionId)) li.remove();
    }
  }

  function renderMessages() {
    if (!messagesEl) return;
    const { activeId, messagesBySession } = store.state;
    if (!activeId) {
      prevMessageCount = 0;
      messagesEl.innerHTML = '';
      return;
    }

    const messages = messagesBySession.get(activeId) ?? [];
    const isNewLive = messages.length > prevMessageCount && prevMessageCount > 0;
    prevMessageCount = messages.length;

    // Full re-render (simple approach for P1 — virtualisation is P2+)
    messagesEl.innerHTML = '';
    for (const msg of messages) {
      const li = document.createElement('li');
      li.dataset.from = msg.direction;
      li.dataset.msgId = String(msg.id);
      if (msg.pending) li.dataset.state = 'pending';
      else if (msg.failed) li.dataset.state = 'failed';
      const who = msg.direction === 'user' ? 'you' : 'them';
      const statusTag = msg.pending
        ? ' <span class="msg-status pending">sending…</span>'
        : msg.failed
          ? ` <span class="msg-status failed">delivery failed: ${escapeHtml(String(msg.failed_reason ?? 'unknown'))}</span>`
          : '';
      li.innerHTML =
        `<span class="msg-meta">` +
        `<span class="ts">${escapeHtml(formatTime(msg.ts ?? msg.ingested_at))}</span>` +
        `<span class="who">${escapeHtml(who)}</span>` +
        `</span>` +
        `<span class="msg-body">${escapeHtml(String(msg.content ?? msg.text ?? ''))}</span>` +
        statusTag;
      messagesEl.appendChild(li);
    }

    if (isNewLive) {
      messagesEl.lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    } else if (messages.length > 0) {
      messagesEl.lastElementChild?.scrollIntoView({ block: 'end' });
    }
  }

  function render() {
    renderSessions();
    renderMessages();
    updateSendBtn();
  }

  store.on('change', render);

  return { render };
}

/**
 * Minimal HTML escaping to prevent XSS.
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
