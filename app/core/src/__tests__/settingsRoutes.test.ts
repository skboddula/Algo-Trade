import { describe, it, expect, afterEach, vi } from 'vitest'
import fastify from 'fastify'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { settingsRoutes } from '../routes/settingsRoutes'
import { StateStore } from '../services/stateStore'
import { MasterIngestionEngine } from '../services/masterIngestor'
import { buildServer } from '../server'
import { DAEMON_SETTING_KEYS } from '../services/daemonSettings'

const ENV_KEYS = [
  'UPSTOX_API_KEY',
  'UPSTOX_API_SECRET',
  'UPSTOX_REDIRECT_URI',
  'PRIMARY_UPSTOX_TOKEN',
] as const

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-settings-test-'))
}

/** Env is blanked so masked views depend only on the store under test. */
function stubCleanEnv(): void {
  for (const key of ENV_KEYS) vi.stubEnv(key, undefined)
}

afterEach(() => {
  vi.unstubAllEnvs()
})

async function startApp(store: StateStore | null) {
  const app = fastify()
  app.register(settingsRoutes, { store })
  await app.ready()
  return app
}

describe('Daemon settings routes', () => {
  it('returns an all-unset masked view when nothing is configured', async () => {
    stubCleanEnv()
    const dir = tempDir()
    const store = new StateStore(dir)
    const app = await startApp(store)

    const res = await app.inject({ method: 'GET', url: '/api/daemon/settings' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      upstox: {
        hasApiKey: false,
        apiKeyHint: null,
        hasApiSecret: false,
        redirectUri: null,
        hasMasterToken: false,
      },
    })

    await app.close()
    rmTemp(dir)
  })

  it('saves credentials from the window, masks secrets, and survives restarts', async () => {
    stubCleanEnv()
    const dir = tempDir()
    const store = new StateStore(dir)
    const app = await startApp(store)

    const saved = await app.inject({
      method: 'POST',
      url: '/api/daemon/settings/upstox',
      payload: {
        apiKey: 'abcd1234efgh5678',
        apiSecret: 'super-secret-value',
        redirectUri: 'http://127.0.0.1:3000/auth/upstox/callback',
      },
    })
    expect(saved.statusCode).toBe(200)
    const body = saved.json()
    expect(body.success).toBe(true)
    expect(body.upstox).toEqual({
      hasApiKey: true,
      apiKeyHint: 'abcd1234…',
      hasApiSecret: true,
      redirectUri: 'http://127.0.0.1:3000/auth/upstox/callback',
      hasMasterToken: false,
    })
    // The full key and the secret must never leave the daemon.
    expect(saved.body).not.toContain('efgh5678')
    expect(saved.body).not.toContain('super-secret-value')

    // GET reflects the same masked view.
    const got = await app.inject({ method: 'GET', url: '/api/daemon/settings' })
    expect(got.json().upstox).toEqual(body.upstox)

    await app.close()

    // Round-trip: a fresh store on the same DATA_DIR still has the settings.
    const reopened = new StateStore(dir)
    expect(reopened.getSetting(DAEMON_SETTING_KEYS.upstoxApiKey)).toBe('abcd1234efgh5678')
    expect(reopened.getSetting(DAEMON_SETTING_KEYS.upstoxApiSecret)).toBe('super-secret-value')
    reopened.close()
    rmTemp(dir)
  })

  it('rejects empty fields and non-http(s) redirect URIs', async () => {
    stubCleanEnv()
    const dir = tempDir()
    const store = new StateStore(dir)
    const app = await startApp(store)

    const cases: Array<{ payload: Record<string, unknown>; error: string }> = [
      { payload: { apiKey: '   ' }, error: 'API key cannot be empty' },
      { payload: { apiSecret: '' }, error: 'API secret cannot be empty' },
      { payload: { redirectUri: 'not-a-url' }, error: 'Redirect URI must be a valid http(s) URL' },
      { payload: { redirectUri: 'ftp://example.com/cb' }, error: 'Redirect URI must be a valid http(s) URL' },
    ]
    for (const { payload, error } of cases) {
      const res = await app.inject({ method: 'POST', url: '/api/daemon/settings/upstox', payload })
      expect(res.statusCode).toBe(400)
      expect(res.json().error).toBe(error)
    }

    // Nothing was persisted by the rejected requests.
    expect(store.getSetting(DAEMON_SETTING_KEYS.upstoxApiKey)).toBeUndefined()
    expect(store.getSetting(DAEMON_SETTING_KEYS.upstoxRedirectUri)).toBeUndefined()

    await app.close()
    rmTemp(dir)
  })

  it('keeps saved values when only some fields are sent, and clears the secret on request', async () => {
    stubCleanEnv()
    const dir = tempDir()
    const store = new StateStore(dir)
    const app = await startApp(store)

    await app.inject({
      method: 'POST',
      url: '/api/daemon/settings/upstox',
      payload: {
        apiKey: 'key-111122223333',
        apiSecret: 'secret-1',
        redirectUri: 'http://127.0.0.1:3000/auth/upstox/callback',
      },
    })

    // Partial update: only the redirect URI changes.
    const partial = await app.inject({
      method: 'POST',
      url: '/api/daemon/settings/upstox',
      payload: { redirectUri: 'http://localhost:3000/auth/upstox/callback' },
    })
    expect(partial.json().upstox).toMatchObject({
      hasApiKey: true,
      hasApiSecret: true,
      redirectUri: 'http://localhost:3000/auth/upstox/callback',
    })
    expect(store.getSetting(DAEMON_SETTING_KEYS.upstoxApiKey)).toBe('key-111122223333')
    expect(store.getSetting(DAEMON_SETTING_KEYS.upstoxApiSecret)).toBe('secret-1')

    const cleared = await app.inject({
      method: 'POST',
      url: '/api/daemon/settings/upstox',
      payload: { clearApiSecret: true },
    })
    expect(cleared.json().upstox.hasApiSecret).toBe(false)
    expect(store.getSetting(DAEMON_SETTING_KEYS.upstoxApiSecret)).toBeUndefined()

    await app.close()
    rmTemp(dir)
  })

  it('falls back to env values for the masked view and refuses writes without a store', async () => {
    stubCleanEnv()
    vi.stubEnv('UPSTOX_API_KEY', 'env-api-key-123456')
    vi.stubEnv('UPSTOX_API_SECRET', 'env-secret')
    vi.stubEnv('UPSTOX_REDIRECT_URI', 'http://127.0.0.1:3000/auth/upstox/callback')

    const app = await startApp(null)
    const view = await app.inject({ method: 'GET', url: '/api/daemon/settings' })
    expect(view.json().upstox).toEqual({
      hasApiKey: true,
      apiKeyHint: 'env-api-…',
      hasApiSecret: true,
      redirectUri: 'http://127.0.0.1:3000/auth/upstox/callback',
      hasMasterToken: false,
    })

    const write = await app.inject({
      method: 'POST',
      url: '/api/daemon/settings/upstox',
      payload: { apiKey: 'nope' },
    })
    expect(write.statusCode).toBe(503)

    await app.close()
  })
})

describe('Master token persistence', () => {
  it('persists setToken() into the settings store and clears it on an empty token', () => {
    const dir = tempDir()
    const store = new StateStore(dir)
    const ingestor = new MasterIngestionEngine({ mockMode: true, settingsStore: store })

    ingestor.setToken('fresh-master-token')
    expect(store.getSetting(DAEMON_SETTING_KEYS.upstoxMasterToken)).toBe('fresh-master-token')

    ingestor.setToken('')
    expect(store.getSetting(DAEMON_SETTING_KEYS.upstoxMasterToken)).toBeUndefined()

    store.close()
    rmTemp(dir)
  })

  it('boots the feed with the SQLite token even when the env token is stale or absent', async () => {
    stubCleanEnv()
    vi.stubEnv('PRIMARY_UPSTOX_TOKEN', 'stale-env-token')
    const dir = tempDir()
    const store = new StateStore(dir)
    store.setSetting(DAEMON_SETTING_KEYS.upstoxMasterToken, 'stored-window-token')

    const server = buildServer({ store, mockMode: false })
    expect(server.masterIngestor.getMasterToken()).toBe('stored-window-token')

    await server.app.close()
    rmTemp(dir)
  })
})

function rmTemp(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true })
}
