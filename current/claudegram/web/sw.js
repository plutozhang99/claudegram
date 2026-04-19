// Bump VERSION whenever any of the SHELL files change so the SW activates and
// old caches get purged on first reload. Failing to bump makes users see stale
// HTML/CSS/JS — the exact symptom behind "my UI changes didn't appear".
const VERSION = 'v5-channel-gating';
const SHELL = [
  '/',
  '/web/style.css',
  '/web/manifest.webmanifest',
  '/web/js/index.js',
  '/web/js/ws.js',
  '/web/js/store.js',
  '/web/js/render.js',
  '/web/js/markdown.js',
  '/web/js/notify.js',
  '/web/icons/icon-192.png',
  '/web/icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (ev) => {
  const url = new URL(ev.request.url);
  if (url.pathname.startsWith('/api/') || url.pathname === '/user-socket') {
    return; // live data — network-only, do not intercept
  }
  ev.respondWith(
    caches.match(ev.request).then(hit => hit ?? fetch(ev.request))
  );
});
