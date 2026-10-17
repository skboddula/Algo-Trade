// Node >= 25 defines a global `localStorage`/`sessionStorage` getter that
// returns undefined unless the process runs with `--localstorage-file`. That
// getter shadows the jsdom window's Web Storage once vitest promotes the DOM
// to globals, so tests would otherwise see `undefined` for `localStorage`.
// Re-pin the globals to the real jsdom storage instance (vitest's jsdom
// environment exposes it as `globalThis.jsdom`) for every test file.
const jsdomEnv = (
  globalThis as unknown as {
    jsdom?: { window?: Record<string, unknown> }
  }
).jsdom

if (jsdomEnv?.window) {
  for (const key of ['localStorage', 'sessionStorage'] as const) {
    const storage = jsdomEnv.window[key]
    if (!storage) continue
    try {
      Object.defineProperty(globalThis, key, {
        value: storage,
        configurable: true,
        writable: true,
      })
    } catch {
      // Leave the environment untouched when the property cannot be redefined.
    }
  }
}
