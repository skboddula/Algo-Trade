import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    setupFiles: ['./src/__tests__/setup.ts'],
    globals: true,
    // These suites mutate process.env.DATA_DIR — and vitest workers SHARE
    // process.env, so parallel test files overwrite each other's DATA_DIR
    // mid-operation (stores opening/loading the wrong directory).
    // singleThread runs all files sequentially in one worker.
    poolOptions: {
      threads: { singleThread: true },
      forks: { singleThread: true },
    },
    server: {
      deps: {
        // node:sqlite is a newer builtin than this vite/vitest version's
        // builtin registry knows — without this, vitest strips the node:
        // prefix and tries to resolve "sqlite" as an npm package.
        external: [/^node:/],
      },
    },
  },
})
