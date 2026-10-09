import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { cloudflare } from '@cloudflare/vite-plugin'
import path from 'path'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const isTest = process.env.VITEST === 'true' || mode === 'test'
  return {
    plugins: [tailwindcss(), react(), ...(!isTest ? [cloudflare()] : [])],
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
