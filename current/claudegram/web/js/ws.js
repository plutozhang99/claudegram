/**
 * WebSocket client with exponential backoff reconnection.
 * Manages connection state and dispatches typed events.
 */

const PILL_ID = 'conn-pill';
const BACKOFF_INITIAL = 250;
const BACKOFF_CAP = 8000;

/**
 * @param {string} url
 * @returns {{ on(type: string, handler: Function): void, off(type: string, handler: Function): void, close(): void }}
 */
export function createWsClient(url) {
  /** @type {Map<string, Set<Function>>} */
  const handlers = new Map();
  let socket = null;
  let backoff = BACKOFF_INITIAL;
  let closed = false;
  let retryTimer = null;

  function setPill(state, text) {
    const pill = document.getElementById(PILL_ID);
    if (!pill) return;
    pill.setAttribute('data-state', state);
    pill.textContent = text;
  }

  function emit(type, payload) {
    const set = handlers.get(type);
    if (!set) return;
    for (const handler of set) {
      try { handler(payload); } catch (e) {
        console.error('ws handler error', e);
        if (window.CLAUDEGRAM_DEBUG) console.warn('ws handler debug context', e);
      }
    }
  }

  function connect() {
    if (closed) return;
    setPill('connecting', 'connecting');

    socket = new WebSocket(url);

    socket.addEventListener('open', () => {
      backoff = BACKOFF_INITIAL;
      setPill('open', 'open');
      emit('connect', null);
    });

    socket.addEventListener('close', () => {
      setPill('closed', 'closed');
      emit('disconnect', null);
      if (!closed) scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      // 'close' fires after 'error'; reconnect is handled there
    });

    socket.addEventListener('message', (evt) => {
      let data;
      try { data = JSON.parse(evt.data); } catch (e) {
        console.error('ws: invalid JSON', e);
        return;
      }
      if (data && data.type === 'message') {
        emit('message', { session_id: data.session_id, message: data.message });
      } else if (data && data.type === 'session_update') {
        emit('session_update', { session: data.session });
      }
    });
  }

  function scheduleReconnect() {
    retryTimer = setTimeout(() => {
      backoff = Math.min(backoff * 2, BACKOFF_CAP);
      connect();
    }, backoff);
  }

  function on(type, handler) {
    if (!handlers.has(type)) handlers.set(type, new Set());
    handlers.get(type).add(handler);
  }

  function off(type, handler) {
    handlers.get(type)?.delete(handler);
  }

  function close() {
    closed = true;
    if (retryTimer !== null) { clearTimeout(retryTimer); retryTimer = null; }
    if (socket) { socket.close(); socket = null; }
    setPill('closed', 'closed');
  }

  connect();

  return { on, off, close };
}
