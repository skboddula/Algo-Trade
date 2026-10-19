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
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
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
  vi.unstubAllGlobals()
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
      telegram: {
        hasBotToken: false,
        botTokenHint: null,
        hasChatId: false,
        chatIdHint: null,
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

  it('saves Telegram settings from the window, masks secrets, and survives restarts', async () => {
    stubCleanEnv()
    const dir = tempDir()
    const store = new StateStore(dir)
    const app = await startApp(store)

    const saved = await app.inject({
      method: 'POST',
      url: '/api/daemon/settings/telegram',
      payload: {
        botToken: '8984943700:AAGJKFAtc8yC8uT5xFbEfmxOTDuP-q07bxo',
        chatId: '643696003',
      },
    })
    expect(saved.statusCode).toBe(200)
    const body = saved.json()
    expect(body.success).toBe(true)
    expect(body.telegram).toEqual({
      hasBotToken: true,
      botTokenHint: '89849437…',
      hasChatId: true,
      chatIdHint: '•••••6003',
    })
    // The full token and the chat id must never leave the daemon.
    expect(saved.body).not.toContain('AAGJKFAtc8yC8uT5xFbEfmxOTDuP')
    expect(saved.body).not.toContain('643696003')

    const got = await app.inject({ method: 'GET', url: '/api/daemon/settings' })
    expect(got.json().telegram).toEqual(body.telegram)

    await app.close()

    // Round-trip: a fresh store on the same DATA_DIR still has the settings.
    const reopened = new StateStore(dir)
    expect(reopened.getSetting(DAEMON_SETTING_KEYS.telegramBotToken)).toBe(
      '8984943700:AAGJKFAtc8yC8uT5xFbEfmxOTDuP-q07bxo',
    )
    expect(reopened.getSetting(DAEMON_SETTING_KEYS.telegramChatId)).toBe('643696003')
    reopened.close()
    rmTemp(dir)
  })

  it('rejects malformed Telegram values without persisting anything', async () => {
    stubCleanEnv()
    const dir = tempDir()
    const store = new StateStore(dir)
    const app = await startApp(store)

    const cases: Array<{ payload: Record<string, unknown>; error: string }> = [
      { payload: { botToken: '   ' }, error: 'Bot token cannot be empty' },
      {
        payload: { botToken: 'not-a-token' },
        error: 'Bot token must look like 123456789:AA… (from @BotFather)',
      },
      { payload: { chatId: '' }, error: 'Chat id cannot be empty' },
      {
        payload: { chatId: 'user-name' },
        error: 'Chat id must be numeric (negative for group chats)',
      },
    ]
    for (const { payload, error } of cases) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/daemon/settings/telegram',
        payload,
      })
      expect(res.statusCode).toBe(400)
      expect(res.json().error).toBe(error)
    }

    expect(store.getSetting(DAEMON_SETTING_KEYS.telegramBotToken)).toBeUndefined()
    expect(store.getSetting(DAEMON_SETTING_KEYS.telegramChatId)).toBeUndefined()

    await app.close()
    rmTemp(dir)
  })

  it('delivers a Telegram test message through the effective config', async () => {
    stubCleanEnv()
    const dir = tempDir()
    const store = new StateStore(dir)
    const app = await startApp(store)

    // Nothing configured yet → actionable error, no network call.
    const unsetFetch = vi.fn()
    vi.stubGlobal('fetch', unsetFetch)
    const missing = await app.inject({
      method: 'POST',
      url: '/api/daemon/settings/telegram/test',
    })
    expect(missing.statusCode).toBe(400)
    expect(unsetFetch).not.toHaveBeenCalled()

    store.setSetting(DAEMON_SETTING_KEYS.telegramBotToken, '8984943700:AA-token')
    store.setSetting(DAEMON_SETTING_KEYS.telegramChatId, '643696003')

    const fetchSpy = vi.fn(async (_url: string | URL, _init?: RequestInit) => ({
      ok: true,
      status: 200,
    }))
    vi.stubGlobal('fetch', fetchSpy)
    const sent = await app.inject({
      method: 'POST',
      url: '/api/daemon/settings/telegram/test',
    })
    expect(sent.statusCode).toBe(200)
    expect(sent.json().success).toBe(true)
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.telegram.org/bot8984943700:AA-token/sendMessage')
    expect(JSON.parse(String(init.body)).chat_id).toBe('643696003')

    // Telegram rejects → surfaced as 502 with the upstream error.
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401 })))
    const failed = await app.inject({
      method: 'POST',
      url: '/api/daemon/settings/telegram/test',
    })
    expect(failed.statusCode).toBe(502)
    expect(failed.json().error).toBe('Telegram HTTP 401')

    await app.close()
    rmTemp(dir)
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
