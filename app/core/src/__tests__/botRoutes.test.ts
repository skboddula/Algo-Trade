import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { buildServer } from '../server'

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

  it('GET /health returns healthy status and memory usage', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: '/health',
    })
    expect(res.statusCode).toBe(200)
    const json = JSON.parse(res.body)
    expect(json.status).toBe('healthy')
    expect(json.memoryUsage).toBeDefined()
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
        config: { strongThreshold: 20, maxTradesPerDay: 8 },
      },
    })
    expect(res.statusCode).toBe(200)
    const json = JSON.parse(res.body)
    expect(json.success).toBe(true)
    expect(json.userState.config.strongThreshold).toBe(20)
    expect(json.userState.config.maxTradesPerDay).toBe(8)
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
