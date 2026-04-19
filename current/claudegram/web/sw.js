const VERSION = 'v1-mistral-status-bar';
const SHELL = [
  '/',
  '/web/style.css',
  '/web/manifest.webmanifest',
  '/web/js/index.js',
  '/web/js/ws.js',
  '/web/js/store.js',
  '/web/js/render.js',
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
