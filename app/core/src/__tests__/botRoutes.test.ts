import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { buildServer } from '../server'
import { TenantManager } from '../services/tenantManager'

describe('Fastify Bot Routes & API Suite', () => {
  let server: ReturnType<typeof buildServer>

  beforeAll(async () => {
    server = buildServer({ mockMode: true })
    await server.app.ready()
    await server.masterIngestor.fetchAndComputeMarketData()
  })

  afterAll(async () => {
    await server.app.close()
  })

  it('GET /health returns healthy status, memory usage, and feed stats', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: '/health',
    })
    expect(res.statusCode).toBe(200)
    const json = JSON.parse(res.body)
    expect(json.status).toBe('healthy')
    expect(json.memoryUsage).toBeDefined()
    expect(json.feed).toBeDefined()
    expect(json.feed.source).toBe('mock')
    expect(json.feed.ws.state).toBe('idle')
  })

  it('GET /api/bot/status returns snapshots, user state, and paper trades', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: '/api/bot/status?userId=test_trader',
    })
    expect(res.statusCode).toBe(200)
    const json = JSON.parse(res.body)
    expect(json.snapshots).toBeDefined()
    expect(json.snapshots['NIFTY 50']).toBeDefined()
    expect(json.userState).toBeDefined()
    expect(json.userState.userId).toBe('test_trader')
    expect(Array.isArray(json.paperTrades)).toBe(true)
  })

  it('GET /api/bot/signal-snapshots returns a dated, bounded list', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: '/api/bot/signal-snapshots?userId=test_trader&date=2026-10-19&limit=50',
    })
    expect(res.statusCode).toBe(200)
    const json = JSON.parse(res.body)
    expect(json.userId).toBe('test_trader')
    expect(json.date).toBe('2026-10-19')
    expect(Array.isArray(json.snapshots)).toBe(true)
    expect(json.count).toBe(json.snapshots.length)

    const bad = await server.app.inject({
      method: 'GET',
      url: '/api/bot/signal-snapshots?date=19-10-2026',
    })
    expect(bad.statusCode).toBe(400)
  })

  it('POST /api/bot/start arms the user bot', async () => {
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/bot/start',
      payload: { userId: 'test_trader', executionMode: 'paper' },
    })
    expect(res.statusCode).toBe(200)
    const json = JSON.parse(res.body)
    expect(json.success).toBe(true)
    expect(json.userState.state).toBe('RUNNING')
    expect(json.userState.executionMode).toBe('paper')
  })

  it('POST /api/bot/stop stops the user bot', async () => {
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/bot/stop',
      payload: { userId: 'test_trader' },
    })
    expect(res.statusCode).toBe(200)
    const json = JSON.parse(res.body)
    expect(json.success).toBe(true)
    expect(json.userState.state).toBe('STOPPED')
  })

  it('POST /api/bot/config updates user strategy parameters', async () => {
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/bot/config',
      payload: {
        userId: 'test_trader',
        config: {
          strongThreshold: 20,
          maxTradesPerDay: 8,
          useMultiTimeframe: false,
        },
      },
    })
    expect(res.statusCode).toBe(200)
    const json = JSON.parse(res.body)
    expect(json.success).toBe(true)
    expect(json.userState.config.strongThreshold).toBe(20)
    expect(json.userState.config.maxTradesPerDay).toBe(8)
    expect(json.userState.config.useMultiTimeframe).toBe(false)
  })

  it('POST /api/bot/paper-reset resets account balance', async () => {
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/bot/paper-reset',
      payload: { userId: 'test_trader' },
    })
    expect(res.statusCode).toBe(200)
    const json = JSON.parse(res.body)
    expect(json.success).toBe(true)
    expect(json.balance).toBe(10000000)
  })

  it('GET /api/bot/status exposes hasToken as a boolean', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: '/api/bot/status?userId=test_trader',
    })
    expect(res.statusCode).toBe(200)
    const json = JSON.parse(res.body)
    expect(typeof json.hasToken).toBe('boolean')
  })

  it('POST /api/bot/start rejects live mode unless DAEMON_LIVE_ARMED=true', async () => {
    delete process.env[TenantManager.LIVE_ARM_ENV]
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/bot/start',
      payload: { userId: 'live_trader', executionMode: 'live' },
    })
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body).error).toContain(
      TenantManager.LIVE_ARM_ENV,
    )
  })

  it('POST /api/bot/start arms live mode when the env gate is set', async () => {
    process.env[TenantManager.LIVE_ARM_ENV] = 'true'
    try {
      const res = await server.app.inject({
        method: 'POST',
        url: '/api/bot/start',
        payload: { userId: 'live_trader', executionMode: 'live' },
      })
      expect(res.statusCode).toBe(200)
      const json = JSON.parse(res.body)
      expect(json.userState.executionMode).toBe('live')
      expect(json.userState.state).toBe('RUNNING')
    } finally {
      delete process.env[TenantManager.LIVE_ARM_ENV]
      await server.app.inject({
        method: 'POST',
        url: '/api/bot/stop',
        payload: { userId: 'live_trader' },
      })
    }
  })

  it('POST /api/bot/config rejects switching to live mid-session', async () => {
    process.env[TenantManager.LIVE_ARM_ENV] = 'true'
    try {
      await server.app.inject({
        method: 'POST',
        url: '/api/bot/start',
        payload: { userId: 'switch_trader', executionMode: 'paper' },
      })
      const res = await server.app.inject({
        method: 'POST',
        url: '/api/bot/config',
        payload: { userId: 'switch_trader', config: { executionMode: 'live' } },
      })
      expect(res.statusCode).toBe(403)
      expect(JSON.parse(res.body).error).toContain('Stop the bot')
    } finally {
      delete process.env[TenantManager.LIVE_ARM_ENV]
      await server.app.inject({
        method: 'POST',
        url: '/api/bot/stop',
        payload: { userId: 'switch_trader' },
      })
    }
  })

  it('POST /api/bot/start refuses a second active trader (shared broker token)', async () => {
    await server.app.inject({
      method: 'POST',
      url: '/api/bot/start',
      payload: { userId: 'primary_trader', executionMode: 'paper' },
    })
    try {
      const res = await server.app.inject({
        method: 'POST',
        url: '/api/bot/start',
        payload: { userId: 'second_trader', executionMode: 'paper' },
      })
      expect(res.statusCode).toBe(403)
      expect(JSON.parse(res.body).error).toContain('already active')
    } finally {
      await server.app.inject({
        method: 'POST',
        url: '/api/bot/stop',
        payload: { userId: 'primary_trader' },
      })
    }
  })

  it('POST /api/bot/token rejects an expired JWT', async () => {
    const expired = [
      'eyJhbGciOiJIUzI1NiJ9',
      Buffer.from(JSON.stringify({ exp: 1 })).toString('base64url'),
      'sig',
    ].join('.')
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/bot/token',
      payload: { userId: 'test_trader', token: expired },
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toContain('EXPIRED')
  })

  it('POST /api/bot/token accepts a fresh JWT and can refresh the master token', async () => {
    const fresh = [
      'eyJhbGciOiJIUzI1NiJ9',
      Buffer.from(
        JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }),
      ).toString('base64url'),
      'sig',
    ].join('.')
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/bot/token',
      payload: { userId: 'test_trader', token: fresh, alsoMaster: true },
    })
    expect(res.statusCode).toBe(200)
    expect(server.masterIngestor.getMasterToken()).toBe(fresh)
  })

  describe('Environment Validation', () => {
    it('fails validation when required PRIMARY_UPSTOX_TOKEN is missing in production', async () => {
      const { validateEnvironment } = await import('../server')
      const result = validateEnvironment({ NODE_ENV: 'production' })
      expect(result.valid).toBe(false)
      expect(result.missing).toContain('PRIMARY_UPSTOX_TOKEN')
    })

    it('fails validation when PRIMARY_UPSTOX_TOKEN is whitespace only', async () => {
      const { validateEnvironment } = await import('../server')
      const result = validateEnvironment({ NODE_ENV: 'production', PRIMARY_UPSTOX_TOKEN: '   ' })
      expect(result.valid).toBe(false)
      expect(result.missing).toContain('PRIMARY_UPSTOX_TOKEN')
    })

    it('passes validation when PRIMARY_UPSTOX_TOKEN is provided', async () => {
      const { validateEnvironment } = await import('../server')
      const result = validateEnvironment({ NODE_ENV: 'production', PRIMARY_UPSTOX_TOKEN: 'valid_jwt_token' })
      expect(result.valid).toBe(true)
      expect(result.missing).toHaveLength(0)
    })

    it('bypasses validation in test or mock mode', async () => {
      const { validateEnvironment } = await import('../server')
      const resultTest = validateEnvironment({ NODE_ENV: 'test' })
      expect(resultTest.valid).toBe(true)

      const resultMock = validateEnvironment({ NODE_ENV: 'development', MOCK_MODE: 'true' })
      expect(resultMock.valid).toBe(true)
    })
  })
})
