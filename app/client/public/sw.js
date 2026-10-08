/* eslint-env serviceworker */
/* AlgoTrade minimal service worker — caches the app shell for offline PWA
   operation. Never caches /api/* (live data must always hit the network).
   The strategy bot runs in the page's JS runtime, not in this worker; the SW
   exists so the installed PWA opens instantly and works offline for UI
   viewing. */

const CACHE_NAME = 'algo-trade-v1'
const APP_SHELL = ['/', '/index.html', '/favicon.svg', '/manifest.json']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
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
            .filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      )
      .catch(() => {}),
  )
  self.clients.claim()
})

self.addEventListener('fetch', (event) => {
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
