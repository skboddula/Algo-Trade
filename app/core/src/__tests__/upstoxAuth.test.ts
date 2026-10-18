import { describe, it, expect, afterEach, vi } from 'vitest'
import fastify, { type FastifyInstance } from 'fastify'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { upstoxAuthRoutes, persistPrimaryToken, type UpstoxAuthRoutesOptions } from '../routes/upstoxAuth'
import type { MasterIngestionEngine } from '../services/masterIngestor'
import { StateStore } from '../services/stateStore'
import { DAEMON_SETTING_KEYS } from '../services/daemonSettings'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

type FetchLike = (url: string, init: RequestInit) => Promise<Response>

interface Harness {
  app: FastifyInstance
  setToken: ReturnType<typeof vi.fn>
  fetchImpl: ReturnType<typeof vi.fn>
  envFilePath: string
  dir: string
}

let active: Harness | null = null

async function startApp(
  overrides: Partial<UpstoxAuthRoutesOptions> = {},
  envContent?: string,
): Promise<Harness> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'upstox-auth-'))
  const envFilePath = path.join(dir, '.env')
  if (envContent !== undefined) writeFileSync(envFilePath, envContent, { mode: 0o600 })

  const setToken = vi.fn()
  const fetchImpl = vi.fn(async () => {
    return new Response(JSON.stringify({ access_token: 'fresh-token' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as ReturnType<typeof vi.fn> & FetchLike

  const app = fastify()
  app.register(upstoxAuthRoutes, {
    masterIngestor: { setToken } as unknown as MasterIngestionEngine,
    apiKey: 'test-key',
    apiSecret: 'test-secret',
    redirectUri: 'http://127.0.0.1:3000/auth/upstox/callback',
    envFilePath,
    fetchImpl,
    ...overrides,
  })
  await app.ready()

  active = { app, setToken, fetchImpl: fetchImpl as unknown as ReturnType<typeof vi.fn>, envFilePath, dir }
  return active
}

afterEach(async () => {
  const harness = active
  active = null
  if (!harness) return
  await harness.app.close()
  rmSync(harness.dir, { recursive: true, force: true })
})

describe('persistPrimaryToken', () => {
  it('replaces the token line, keeps other lines, and backs up the previous file', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'upstox-env-'))
    const envFilePath = path.join(dir, '.env')
    writeFileSync(
      envFilePath,
      'NODE_ENV=production\nPRIMARY_UPSTOX_TOKEN=old-token\nPORT=3000\n',
      { mode: 0o600 },
    )

    const backupPath = persistPrimaryToken(envFilePath, 'new-token')

    const updated = readFileSync(envFilePath, 'utf8')
    expect(updated).toBe('NODE_ENV=production\nPRIMARY_UPSTOX_TOKEN=new-token\nPORT=3000\n')
    expect(statSync(envFilePath).mode & 0o777).toBe(0o600)

    expect(backupPath).not.toBeNull()
    expect(readFileSync(backupPath!, 'utf8')).toContain('PRIMARY_UPSTOX_TOKEN=old-token')
    expect(statSync(backupPath!).mode & 0o777).toBe(0o600)

    rmSync(dir, { recursive: true, force: true })
  })

  it('appends the token when the line is missing, and creates the file when absent', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'upstox-env-'))
    const envFilePath = path.join(dir, '.env')

    expect(persistPrimaryToken(envFilePath, 'first-token')).toBeNull()
    expect(readFileSync(envFilePath, 'utf8')).toBe('PRIMARY_UPSTOX_TOKEN=first-token\n')
    expect(statSync(envFilePath).mode & 0o777).toBe(0o600)

    writeFileSync(envFilePath, 'PORT=3000', { mode: 0o600 })
    persistPrimaryToken(envFilePath, 'second-token')
    expect(readFileSync(envFilePath, 'utf8')).toBe('PORT=3000\nPRIMARY_UPSTOX_TOKEN=second-token\n')

    rmSync(dir, { recursive: true, force: true })
  })
})

describe('Upstox OAuth routes', () => {
  it('returns actionable guidance when OAuth is not configured', async () => {
    const harness = await startApp({ apiKey: undefined, apiSecret: undefined, redirectUri: undefined })

    const res = await harness.app.inject({
      method: 'GET',
      url: '/auth/upstox/start',
      headers: { accept: 'application/json' },
    })

    expect(res.statusCode).toBe(400)
    const body = res.json()
    expect(body.error).toContain('UPSTOX_API_KEY')
    expect(body.missing).toEqual(['UPSTOX_API_KEY', 'UPSTOX_API_SECRET', 'UPSTOX_REDIRECT_URI'])
  })

  it('start() redirects to the Upstox dialog with a single-use state (JSON mode returns the URL)', async () => {
    const harness = await startApp()

    const res = await harness.app.inject({
      method: 'GET',
      url: '/auth/upstox/start',
      headers: { accept: 'application/json' },
    })
    expect(res.statusCode).toBe(200)

    const { authorizationUrl } = res.json() as { authorizationUrl: string }
    const url = new URL(authorizationUrl)
    expect(`${url.origin}${url.pathname}`).toBe('https://api.upstox.com/v2/login/authorization/dialog')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('client_id')).toBe('test-key')
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:3000/auth/upstox/callback')
    expect(url.searchParams.get('state')).toMatch(/^[0-9a-f]{32}$/)

    // Browser flow: 302 to the same dialog.
    const browser = await harness.app.inject({ method: 'GET', url: '/auth/upstox/start' })
    expect(browser.statusCode).toBe(302)
    expect(browser.headers.location).toContain('https://api.upstox.com/v2/login/authorization/dialog')
  })

  it('callback() rejects unknown or expired states', async () => {
    const harness = await startApp({ stateTtlMs: 30 })

    const unknown = await harness.app.inject({
      method: 'GET',
      url: '/auth/upstox/callback?code=abc&state=deadbeef',
    })
    expect(unknown.statusCode).toBe(400)
    expect(unknown.body).toContain('Invalid or expired login state')

    const start = await harness.app.inject({
      method: 'GET',
      url: '/auth/upstox/start',
      headers: { accept: 'application/json' },
    })
    const state = new URL((start.json() as { authorizationUrl: string }).authorizationUrl).searchParams.get('state')

    await sleep(60)
    const expired = await harness.app.inject({
      method: 'GET',
      url: `/auth/upstox/callback?code=abc&state=${state}`,
    })
    expect(expired.statusCode).toBe(400)
  })

  it('exchanges the code, persists the token, hot-swaps the feed, and consumes the state', async () => {
    const harness = await startApp({}, 'NODE_ENV=production\nPRIMARY_UPSTOX_TOKEN=old-token\n')

    const start = await harness.app.inject({
      method: 'GET',
      url: '/auth/upstox/start',
      headers: { accept: 'application/json' },
    })
    const state = new URL((start.json() as { authorizationUrl: string }).authorizationUrl).searchParams.get('state')

    const cb = await harness.app.inject({
      method: 'GET',
      url: `/auth/upstox/callback?code=abc123&state=${state}`,
    })

    expect(cb.statusCode).toBe(200)
    expect(cb.body).toContain('Upstox token refreshed')

    // Server-side exchange with the right form payload.
    expect(harness.fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = harness.fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.upstox.com/v2/login/authorization/token')
    const form = new URLSearchParams(init.body as string)
    expect(form.get('code')).toBe('abc123')
    expect(form.get('client_id')).toBe('test-key')
    expect(form.get('client_secret')).toBe('test-secret')
    expect(form.get('redirect_uri')).toBe('http://127.0.0.1:3000/auth/upstox/callback')
    expect(form.get('grant_type')).toBe('authorization_code')

    // Hot swap + .env persistence + backup.
    expect(harness.setToken).toHaveBeenCalledWith('fresh-token')
    expect(readFileSync(harness.envFilePath, 'utf8')).toContain('PRIMARY_UPSTOX_TOKEN=fresh-token')
    expect(readdirSync(harness.dir).some((name) => name.includes('.env.bak-'))).toBe(true)

    // State is single-use.
    const replay = await harness.app.inject({
      method: 'GET',
      url: `/auth/upstox/callback?code=abc123&state=${state}`,
    })
    expect(replay.statusCode).toBe(400)
    expect(harness.setToken).toHaveBeenCalledTimes(1)
  })

  it('shows a friendly page when the user denies the login', async () => {
    const harness = await startApp()

    const res = await harness.app.inject({
      method: 'GET',
      url: '/auth/upstox/callback?error=access_denied&error_description=User+denied+the+request',
    })
    expect(res.statusCode).toBe(400)
    expect(res.body).toContain('access_denied')
    expect(harness.setToken).not.toHaveBeenCalled()
  })

  it('uses credentials saved in the daemon settings and picks them up without a restart', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'upstox-auth-settings-'))
    const store = new StateStore(dir)
    const harness = await startApp({
      apiKey: undefined,
      apiSecret: undefined,
      redirectUri: undefined,
      settingsStore: store,
    })

    // Nothing configured yet → actionable 400 (env has no OAuth keys here).
    const before = await harness.app.inject({
      method: 'GET',
      url: '/auth/upstox/start',
      headers: { accept: 'application/json' },
    })
    expect(before.statusCode).toBe(400)
    expect(before.json().missing).toContain('UPSTOX_API_KEY')

    // The window saves credentials into the daemon's SQLite.
    store.setSetting(DAEMON_SETTING_KEYS.upstoxApiKey, 'window-key')
    store.setSetting(DAEMON_SETTING_KEYS.upstoxApiSecret, 'window-secret')
    store.setSetting(DAEMON_SETTING_KEYS.upstoxRedirectUri, 'http://127.0.0.1:3000/auth/upstox/callback')

    // No daemon restart needed — the next /start resolves the saved values.
    const start = await harness.app.inject({
      method: 'GET',
      url: '/auth/upstox/start',
      headers: { accept: 'application/json' },
    })
    expect(start.statusCode).toBe(200)
    const authUrl = new URL((start.json() as { authorizationUrl: string }).authorizationUrl)
    expect(authUrl.searchParams.get('client_id')).toBe('window-key')
    expect(authUrl.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:3000/auth/upstox/callback')

    // The callback exchange uses the same resolved credentials.
    const state = authUrl.searchParams.get('state')
    const cb = await harness.app.inject({
      method: 'GET',
      url: `/auth/upstox/callback?code=abc123&state=${state}`,
    })
    expect(cb.statusCode).toBe(200)
    expect(harness.setToken).toHaveBeenCalledWith('fresh-token')
    const form = new URLSearchParams(harness.fetchImpl.mock.calls[0]![1].body as string)
    expect(form.get('client_id')).toBe('window-key')
    expect(form.get('client_secret')).toBe('window-secret')

    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('reports upstream exchange failures without touching the env file or feed', async () => {
    const harness = await startApp({}, 'PRIMARY_UPSTOX_TOKEN=old-token\n')
    harness.fetchImpl.mockResolvedValueOnce(
      new Response(JSON.stringify({ errors: [{ message: 'Invalid token exchange request' }] }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }) as unknown as Response,
    )

    const start = await harness.app.inject({
      method: 'GET',
      url: '/auth/upstox/start',
      headers: { accept: 'application/json' },
    })
    const state = new URL((start.json() as { authorizationUrl: string }).authorizationUrl).searchParams.get('state')

    const cb = await harness.app.inject({
      method: 'GET',
      url: `/auth/upstox/callback?code=bad&state=${state}`,
    })

    expect(cb.statusCode).toBe(502)
    expect(cb.body).toContain('Invalid token exchange request')
    expect(harness.setToken).not.toHaveBeenCalled()
    expect(readFileSync(harness.envFilePath, 'utf8')).toBe('PRIMARY_UPSTOX_TOKEN=old-token\n')
    expect(existsSync(`${harness.envFilePath}.tmp-${process.pid}`)).toBe(false)
  })
})
