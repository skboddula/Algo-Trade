/* eslint-env serviceworker */
/* AlgoTrade service worker — caches the app shell for the PRODUCTION PWA
   (offline UI + instant startup).

   DEV ORIGINS (localhost / 127.0.0.1) ARE FULLY BYPASSED: a dev server's
   responses are live-transformed modules that change on every code edit —
   caching them produces stale/fresh module mixes that crash React with
   "Cannot read properties of null (reading 'useState')". In dev this worker
   purges all caches, unregisters itself, and passes every request through.
   Never caches /api/* (live data must always hit the network). */

const CACHE_NAME = 'algo-trade-v2'
const IS_DEV_ORIGIN = ['localhost', '127.0.0.1'].includes(
  self.location.hostname,
)

self.addEventListener('install', (event) => {
  if (IS_DEV_ORIGIN) {
    // Dev: purge every cache left by older workers, take over immediately.
    event.waitUntil(
      caches
        .keys()
        .then((keys) => Promise.all(keys.map((key) => caches.delete(key))))
        .catch(() => {}),
    )
    self.skipWaiting()
    return
  }
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) =>
        cache.addAll(['/', '/index.html', '/favicon.svg', '/manifest.json']),
      )
      .catch(() => {
        // Installation is best-effort; the app still works online.
      }),
  )
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => IS_DEV_ORIGIN || key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim())
      .then(() => {
        // In dev there is nothing to serve — remove the worker entirely so
        // future sessions start with a clean, network-only environment.
        if (IS_DEV_ORIGIN) return self.registration.unregister()
      })
      .catch(() => {}),
  )
})

self.addEventListener('fetch', (event) => {
  // Dev: never intercept — full network passthrough.
  if (IS_DEV_ORIGIN) return

  const url = new URL(event.request.url)

  // Never intercept API calls — they need live data from the Worker.
  if (url.pathname.startsWith('/api/')) return

  // Never intercept WebSocket upgrades.
  if (url.protocol === 'wss:' || url.protocol === 'ws:') return

  // Cache-first for same-origin GET requests (app shell + static assets).
  if (event.request.method !== 'GET' || url.origin !== self.location.origin)
    return

  event.respondWith(
    caches
      .match(event.request)
      .then(
        (cached) =>
          cached ||
          fetch(event.request)
            .then((response) => {
              // Cache successful same-origin responses.
              if (response.ok) {
                const clone = response.clone()
                caches
                  .open(CACHE_NAME)
                  .then((cache) => cache.put(event.request, clone))
                  .catch(() => {})
              }
              return response
            })
            .catch(() => cached || caches.match('/index.html')),
      )
      .catch(() => caches.match('/index.html')),
  )
})
