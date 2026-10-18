import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { buildServer } from '../server'
import { DEFAULT_INITIAL_PAPER_BALANCE } from '../constants'

const jsonResponse = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

/** URL + headers of a stubbed fetch call (defaults to the most recent one). */
const fetchCall = (
  mock: { mock: { calls: unknown[][] } },
  index?: number,
) => {
  const calls = mock.mock.calls
  const [url, init] = calls[index ?? calls.length - 1] as [string, RequestInit]
  return { url, headers: (init.headers ?? {}) as Record<string, string> }
}

describe('Cloud-API parity routes (daemon window)', () => {
  let server: ReturnType<typeof buildServer>

  beforeAll(async () => {
    server = buildServer({ mockMode: true })
    await server.app.ready()
    await server.masterIngestor.fetchAndComputeMarketData()
  })

  afterAll(async () => {
    await server.app.close()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  // ── Upstox proxy parity ───────────────────────────────────────────────────

  it('passes the upstream profile payload through unchanged', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ status: 'success', data: { user_id: 'AB1234' } }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const res = await server.app.inject({
      method: 'POST',
      url: '/api/broker/upstox/profile',
      payload: { token: 'body-token' },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data.user_id).toBe('AB1234')

    const { url, headers } = fetchCall(fetchMock)
    expect(url).toBe('https://api.upstox.com/v2/user/profile')
    expect(headers.Authorization).toBe('Bearer body-token')
  })

  it('passes upstream funds calls through with the v3 header', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ status: 'success', data: { available_to_trade: {} } }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const res = await server.app.inject({
      method: 'POST',
      url: '/api/broker/upstox/funds',
      payload: { token: 'body-token' },
    })
    expect(res.statusCode).toBe(200)

    const { url, headers } = fetchCall(fetchMock)
    expect(url).toBe('https://api.upstox.com/v3/user/get-funds-and-margin')
    expect(headers['Api-Version']).toBe('3.0')
  })

  it('forwards upstream 4xx statuses (expired token) untouched', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(
          { status: 'error', errors: [{ message: 'Invalid token' }] },
          401,
        ),
      ),
    )
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/broker/upstox/profile',
      payload: { token: 'stale' },
    })
    expect(res.statusCode).toBe(401)
    expect(JSON.parse(res.body).status).toBe('error')
  })

  it('returns 502 when Upstox is unreachable or answers non-JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down')
      }),
    )
    let res = await server.app.inject({
      method: 'POST',
      url: '/api/broker/upstox/profile',
      payload: { token: 't' },
    })
    expect(res.statusCode).toBe(502)
    expect(JSON.parse(res.body).error).toBe('Failed to reach Upstox API')

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('not-json', { status: 200 })),
    )
    res = await server.app.inject({
      method: 'POST',
      url: '/api/broker/upstox/funds',
      payload: { token: 't' },
    })
    expect(res.statusCode).toBe(502)
    expect(JSON.parse(res.body).error).toBe('Invalid response from Upstox API')
  })

  it('requires a token when neither a body token nor a daemon token exists', async () => {
    vi.spyOn(server.tenantManager, 'getEffectiveOrderToken').mockReturnValue(
      undefined,
    )
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const res = await server.app.inject({
      method: 'POST',
      url: '/api/broker/upstox/profile',
      payload: {},
    })
    expect(res.statusCode).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('falls back to the daemon token: master, then per-user override, then clear', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ status: 'success', data: {} }),
    )
    vi.stubGlobal('fetch', fetchMock)

    server.masterIngestor.setToken('master-token')
    server.tenantManager.clearToken('parity_user')

    const call = async () => {
      const res = await server.app.inject({
        method: 'POST',
        url: '/api/broker/upstox/profile',
        payload: { userId: 'parity_user' },
      })
      expect(res.statusCode).toBe(200)
      return fetchCall(fetchMock)
    }

    expect((await call()).headers.Authorization).toBe('Bearer master-token')

    server.tenantManager.setToken('parity_user', 'user-token')
    expect((await call()).headers.Authorization).toBe('Bearer user-token')

    // Status exposes only a boolean for the override
    const withOverride = await server.app.inject({
      method: 'GET',
      url: '/api/bot/status?userId=parity_user',
    })
    expect(JSON.parse(withOverride.body).hasOrderTokenOverride).toBe(true)

    const cleared = await server.app.inject({
      method: 'POST',
      url: '/api/bot/token',
      payload: { userId: 'parity_user', clear: true },
    })
    expect(cleared.statusCode).toBe(200)
    expect((await call()).headers.Authorization).toBe('Bearer master-token')

    const withoutOverride = await server.app.inject({
      method: 'GET',
      url: '/api/bot/status?userId=parity_user',
    })
    expect(JSON.parse(withoutOverride.body).hasOrderTokenOverride).toBe(false)
  })

  // ── Paper ledger parity ───────────────────────────────────────────────────

  it('GET /api/paper/account returns the daemon ledger in rupees', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: '/api/paper/account?userId=parity_paper',
    })
    expect(res.statusCode).toBe(200)
    const summary = JSON.parse(res.body)
    expect(summary.account.id).toBe('paper_acc_parity_paper')
    expect(summary.account.balance).toBe(DEFAULT_INITIAL_PAPER_BALANCE / 100)
    expect(summary.account.currency).toBe('INR')
    expect(summary.openTradeCount).toBe(0)
    expect(summary.recentEntries).toEqual([])
    expect(summary.startingBalance).toBe(DEFAULT_INITIAL_PAPER_BALANCE / 100)
  })

  it('POST /api/paper/account/adjust sets and adds credit, and syncs status', async () => {
    let res = await server.app.inject({
      method: 'POST',
      url: '/api/paper/account/adjust',
      payload: { userId: 'parity_paper', mode: 'set', amount: 25000 },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).account.balance).toBe(25000)
    expect(
      server.orderGateway.getOrCreatePaperAccount('parity_paper').balance,
    ).toBe(2_500_000)

    res = await server.app.inject({
      method: 'POST',
      url: '/api/paper/account/adjust',
      payload: { userId: 'parity_paper', mode: 'adjust', amount: 500.5 },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).account.balance).toBe(25500.5)

    // /api/bot/status reflects the manual change immediately
    const status = await server.app.inject({
      method: 'GET',
      url: '/api/bot/status?userId=parity_paper',
    })
    expect(JSON.parse(status.body).userState.paperBalance).toBe(2_550_050)
  })

  it('rejects invalid paper-credit adjustments', async () => {
    const cases: Array<{ payload: object; error: string }> = [
      {
        payload: { userId: 'parity_paper', mode: 'set', amount: 'abc' },
        error: 'Amount must be a valid number',
      },
      {
        payload: { userId: 'parity_paper', mode: 'nope', amount: 10 },
        error: 'Mode must be set or adjust',
      },
      {
        payload: { userId: 'parity_paper', mode: 'set', amount: -5 },
        error: 'Paper credit cannot go below zero',
      },
      {
        payload: { userId: 'parity_paper', mode: 'adjust', amount: -9_999_999 },
        error: 'Paper credit cannot go below zero',
      },
    ]
    for (const { payload, error } of cases) {
      const res = await server.app.inject({
        method: 'POST',
        url: '/api/paper/account/adjust',
        payload,
      })
      expect(res.statusCode).toBe(400)
      expect(JSON.parse(res.body).error).toBe(error)
    }
  })

  it('POST /api/paper/reset restores the daemon seed credit', async () => {
    server.orderGateway.adjustPaperAccount('parity_paper', 'set', 123_456)
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/paper/reset',
      payload: { userId: 'parity_paper' },
    })
    expect(res.statusCode).toBe(200)
    const summary = JSON.parse(res.body)
    expect(summary.account.balance).toBe(DEFAULT_INITIAL_PAPER_BALANCE / 100)
    expect(
      server.orderGateway.getOrCreatePaperAccount('parity_paper').balance,
    ).toBe(DEFAULT_INITIAL_PAPER_BALANCE)
  })
})
