import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { cloudflare } from '@cloudflare/vite-plugin'
import path from 'path'

// A no-op, self-unregistering service worker served ONLY by the dev server.
// Vite dev responses are live-transformed modules — caching them (under ANY
// origin, including Tailscale proxies) duplicates React across code edits
// and crashes the app. This kills legacy worker registrations everywhere the
// dev server is reachable. Production builds are unaffected: `apply: 'serve'
// ` excludes this plugin from `vite build`, so the real public/sw.js ships.
const DEV_NOOP_SW = `/* dev server: service worker disabled */
self.addEventListener('install', (e) => e.waitUntil(self.skipWaiting()))
self.addEventListener('activate', (e) =>
  e.waitUntil(
    self.clients
      .claim()
      .then(() => caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k)))))
      .then(() => self.registration.unregister())
      .catch(() => {}),
  ),
)
self.addEventListener('fetch', () => {})
`

const devNoopServiceWorker = {
  name: 'dev-noop-service-worker',
  apply: 'serve',
  configureServer(server: {
    middlewares: {
      use: (
        path: string,
        handler: (req: unknown, res: unknown, next: () => void) => void,
      ) => void
    }
  }) {
    server.middlewares.use('/sw.js', (_req, res, next) => {
      const response = res as {
        setHeader: (k: string, v: string) => void
        end: (body: string) => void
      }
      if (_req && (_req as { method?: string }).method === 'GET') {
        response.setHeader('Content-Type', 'application/javascript')
        response.setHeader('Cache-Control', 'no-cache')
        response.end(DEV_NOOP_SW)
        return
      }
      next()
    })
  },
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const isTest = process.env.VITEST === 'true' || mode === 'test'
  return {
    plugins: [
      tailwindcss(),
      react(),
      devNoopServiceWorker,
      ...(!isTest ? [cloudflare()] : []),
    ],
    server: {
      // Allow access via Tailscale MagicDNS hostname (tailnet HTTPS proxy)
      allowedHosts: ['.ts.net'],
      // Bind to IPv4 loopback — the Tailscale serve proxy targets
      // 127.0.0.1:5173; binding only ::1 (the default) makes the proxy 502.
      host: '127.0.0.1',
      port: 5173,
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },

    build: {
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes('node_modules')) {
              if (id.includes('recharts')) {
                return 'recharts-vendor'
              }
              if (id.includes('lucide-react')) {
                return 'icons-vendor'
              }
              if (id.includes('@auth0')) {
                return 'auth0-vendor'
              }
            }
          },
        },
      },
    },
  }
})
