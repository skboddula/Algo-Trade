import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'
import { buildServer, isAllowedBrowserOrigin } from '../server'

// ── Dashboard window serving ────────────────────────────────────────────────

describe('Dashboard window serving', () => {
  let dashboardDir: string
  let app: ReturnType<typeof buildServer>['app']

  beforeAll(async () => {
    dashboardDir = fs.mkdtempSync(path.join(os.tmpdir(), 'algo-dashboard-'))
    fs.writeFileSync(
      path.join(dashboardDir, 'index.html'),
      '<!doctype html><html><body><div id="root">DAEMON-WINDOW-MARKER</div></body></html>',
    )
    fs.mkdirSync(path.join(dashboardDir, 'assets'))
    fs.writeFileSync(path.join(dashboardDir, 'assets', 'app.js'), 'console.log("asset")')

    app = buildServer({ mockMode: true, store: null, dashboardDir }).app
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
    fs.rmSync(dashboardDir, { recursive: true, force: true })
  })

  it('serves the dashboard shell at /', async () => {
    const res = await app.inject({ method: 'GET', url: '/' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/html')
    expect(res.body).toContain('DAEMON-WINDOW-MARKER')
  })

  it('serves static assets directly', async () => {
    const res = await app.inject({ method: 'GET', url: '/assets/app.js' })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('console.log')
  })

  it('falls back to index.html for client-side routes (SPA)', async () => {
    for (const url of ['/live-trades', '/history', '/config/nested']) {
      const res = await app.inject({ method: 'GET', url })
      expect(res.statusCode).toBe(200)
      expect(res.body).toContain('DAEMON-WINDOW-MARKER')
    }
  })

  it('keeps unknown API paths as JSON 404s (no SPA fallback)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/nope' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ error: 'Not found' })
  })

  it('still serves /health and the bot API alongside the dashboard', async () => {
    const health = await app.inject({ method: 'GET', url: '/health' })
    expect(health.statusCode).toBe(200)
    expect(health.json()).toHaveProperty('feed')

    const status = await app.inject({ method: 'GET', url: '/api/bot/status' })
    expect(status.statusCode).toBe(200)
    expect(status.json()).toHaveProperty('userState')
  })
})

// ── Cross-site origin guard ─────────────────────────────────────────────────

describe('Cross-site origin guard', () => {
  it('classifies origins correctly', () => {
    expect(isAllowedBrowserOrigin('http://127.0.0.1:3000')).toBe(true)
    expect(isAllowedBrowserOrigin('http://localhost:5173')).toBe(true)
    expect(isAllowedBrowserOrigin('http://[::1]:3000')).toBe(true)
    expect(isAllowedBrowserOrigin('http://evil.example')).toBe(false)
    expect(isAllowedBrowserOrigin('null')).toBe(false)
    expect(isAllowedBrowserOrigin('not-a-url')).toBe(false)
    expect(isAllowedBrowserOrigin('https://dash.example', ['https://dash.example'])).toBe(true)
  })

  it('rejects foreign browser origins but allows loopback and origin-less clients', async () => {
    const { app } = buildServer({ mockMode: true, store: null })
    await app.ready()
    try {
      const foreign = await app.inject({
        method: 'GET',
        url: '/health',
        headers: { origin: 'http://evil.example' },
      })
      expect(foreign.statusCode).toBe(403)

      const loopback = await app.inject({
        method: 'GET',
        url: '/health',
        headers: { origin: 'http://127.0.0.1:3000' },
      })
      expect(loopback.statusCode).toBe(200)

      const curl = await app.inject({ method: 'GET', url: '/health' })
      expect(curl.statusCode).toBe(200)
    } finally {
      await app.close()
    }
  })

  it('honours ALLOWED_ORIGINS for additional browser origins', async () => {
    process.env.ALLOWED_ORIGINS = 'https://dash.example'
    try {
      const { app } = buildServer({ mockMode: true, store: null })
      await app.ready()
      const res = await app.inject({
        method: 'GET',
        url: '/health',
        headers: { origin: 'https://dash.example' },
      })
      expect(res.statusCode).toBe(200)
      await app.close()
    } finally {
      delete process.env.ALLOWED_ORIGINS
    }
  })
})

// ── WebSocket sanitization (no token over the wire) ─────────────────────────

function waitForMessage(ws: WebSocket, timeoutMs = 3000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ws message timeout')), timeoutMs)
    ws.once('message', (data) => {
      clearTimeout(timer)
      resolve(data.toString())
    })
  })
}

describe('WebSocket state sanitization', () => {
  it('never exposes upstoxToken in INITIAL_STATE or USER_STATE_UPDATE', async () => {
    const { app } = buildServer({ mockMode: true, store: null })
    await app.listen({ port: 0, host: '127.0.0.1' })
    const address = app.server.address()
    if (!address || typeof address === 'string') throw new Error('no address')
    const wsUrl = `ws://127.0.0.1:${address.port}/ws`

    const ws = new WebSocket(wsUrl)
    try {
      // Seed the default user with a per-user token BEFORE the socket connects,
      // so the INITIAL_STATE payload would leak it if sanitization regressed.
      await app.inject({
        method: 'POST',
        url: '/api/bot/token',
        payload: { userId: 'default_user', token: 'super-secret-token' },
      })

      const initial = JSON.parse(await waitForMessage(ws)) as {
        type: string
        data: { userState: Record<string, unknown> }
      }
      expect(initial.type).toBe('INITIAL_STATE')
      expect(initial.data.userState).not.toHaveProperty('upstoxToken')

      // Trigger a live USER_STATE_UPDATE broadcast (token gets set again).
      await app.inject({
        method: 'POST',
        url: '/api/bot/token',
        payload: { userId: 'default_user', token: 'super-secret-token-2' },
      })

      const update = await waitForMessage(ws)
      expect(update).toContain('USER_STATE_UPDATE')
      expect(update).not.toContain('super-secret-token-2')
      const parsed = JSON.parse(update) as { data: Record<string, unknown> }
      expect(parsed.data).not.toHaveProperty('upstoxToken')
    } finally {
      ws.close()
      await app.close()
    }
  })
})
