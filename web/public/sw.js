// Minimal service worker: makes the app installable and keeps the app shell available offline.
// API answers are never cached, so a number on screen always comes from the server.
const SHELL = 'gmf-shell-v1';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((cache) => cache.addAll(['/', '/icon.svg', '/manifest.webmanifest'])));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/healthz') return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        if (response.ok) caches.open(SHELL).then((cache) => cache.put(event.request, copy).then(() => trim(cache)));
        return response;
      })
      .catch(() => caches.match(event.request).then((hit) => hit ?? caches.match('/'))),
  );
});

// Every deploy has new hashed asset names, and the old ones are never asked for again. Keep the newest entries only.
const MAX_ENTRIES = 120;
async function trim(cache) {
  const keys = await cache.keys();
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) await cache.delete(key);
}
