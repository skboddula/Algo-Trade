import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { cloudflare } from '@cloudflare/vite-plugin'
import path from 'path'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const isTest = process.env.VITEST === 'true' || mode === 'test'
  // `build:daemon` produces a plain SPA for the daemon (app/core) to serve at
  // http://127.0.0.1:3000 — the Cloudflare worker plugin stays out of that build.
  const isDaemonBuild = mode === 'daemon'
  return {
    plugins: [
      tailwindcss(),
      react(),
      ...(!isTest && !isDaemonBuild ? [cloudflare()] : []),
    ],
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
