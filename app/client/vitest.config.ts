import { defineConfig } from 'vitest/config'
import path from 'path'

// Node 25+ ships its own Web Storage API on globalThis, which makes vitest's
// jsdom environment silently drop window.localStorage (vitest#10867) — every
// localStorage-dependent suite then fails with "reading 'clear' of undefined".
// Disabling Node's storage lets jsdom's implementation populate correctly.
// Gated on Node >= 25: older Node rejects the unknown flag.
const nodeMajor = Number(process.versions.node.split('.')[0])
const testExecArgv = nodeMajor >= 25 ? ['--no-webstorage'] : []

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: [],
    css: false,
    // execArgv must live under the pool that spawns test workers
    // (vitest 3 defaults to the 'forks' pool).
    poolOptions: {
      forks: { execArgv: testExecArgv },
      threads: { execArgv: testExecArgv },
    },
  },
})
