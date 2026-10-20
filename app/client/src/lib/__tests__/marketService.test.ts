/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  fetchMarket,
  mkLog,
  resetPreviousSessionCandleCache,
  resolveContractLotSize,
  safeFetch,
} from '../marketService'
import type { BotLog } from '../marketService'
import type { Candle } from '../types'

describe('mkLog', () => {
  it('creates a BotLog with correct level, source, and msg', () => {
    const log = mkLog('info', 'test-source', 'hello world')
    expect(log.level).toBe('info')
    expect(log.source).toBe('test-source')
    expect(log.msg).toBe('hello world')
  })

  it('generates an id with timestamp prefix', () => {
    const log = mkLog('error', 'src', 'err')
    expect(log.id).toMatch(/^\d{13,}-[a-z0-9]{4}$/)
  })

  it('sets ts as valid ISO string', () => {
    const log = mkLog('warn', 'src', 'warn')
    expect(() => new Date(log.ts)).not.toThrow()
    expect(new Date(log.ts).toISOString()).toBe(log.ts)
  })

  it('handles all log levels', () => {
    for (const level of ['info', 'warn', 'error', 'debug'] as const) {
      const log = mkLog(level, 'src', 'msg')
      expect(log.level).toBe(level)
    }
  })

  it('generates unique ids for consecutive calls', () => {
    const a = mkLog('info', 'src', 'a')
    const b = mkLog('info', 'src', 'b')
    expect(a.id).not.toBe(b.id)
  })
})

describe('safeFetch', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('returns [data, null] on successful fetch', async () => {
    const mockData = { foo: 'bar' }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: () => Promise.resolve(mockData),
    } as Response)

    const [data, err] = await safeFetch<{ foo: string }>('/test')
    expect(data).toEqual(mockData)
    expect(err).toBeNull()
  })

  it('returns [null, errorMsg] on HTTP error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      json: () => Promise.resolve({}),
    } as Response)

    const [data, err] = await safeFetch('/test')
    expect(data).toBeNull()
    expect(err).toContain('HTTP 404 Not Found')
  })

  it('includes error detail from response body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      json: () => Promise.resolve({ error: 'Invalid token' }),
    } as Response)

    const [data, err] = await safeFetch('/test')
    expect(data).toBeNull()
    expect(err).toContain('Invalid token')
  })

  it('handles error with code field', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      json: () => Promise.resolve({ code: 'AUTH_FAILED', error: 'no access' }),
    } as Response)

    const [data, err] = await safeFetch('/test')
    expect(data).toBeNull()
    expect(err).toContain('[AUTH_FAILED]')
    expect(err).toContain('no access')
  })

  it('handles errors array in response body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 422,
      statusText: 'Unprocessable',
      json: () =>
        Promise.resolve({
          errors: [{ message: 'Field required' }, { errorCode: 'INVALID' }],
        }),
    } as Response)

    const [data, err] = await safeFetch('/test')
    expect(data).toBeNull()
    expect(err).toContain('Field required')
    expect(err).toContain('INVALID')
  })

  it('returns [null, errorMsg] on network failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new Error('Network connection failed'),
    )

    const [data, err] = await safeFetch('/test')
    expect(data).toBeNull()
    expect(err).toBe('Network connection failed')
  })

  it('returns [null, error] when response body has error field despite 200', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: () => Promise.resolve({ error: 'service degraded' }),
    } as Response)

    const [data, err] = await safeFetch('/test')
    expect(data).toBeNull()
    expect(err).toBe('service degraded')
  })

  it('passes init options to fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: () => Promise.resolve({}),
    } as Response)

    await safeFetch('/test', {
      method: 'POST',
      headers: { 'X-Custom': 'val' },
      body: JSON.stringify({ key: 'value' }),
    })

    expect(fetchSpy).toHaveBeenCalledWith(
      '/test',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'X-Custom': 'val' }),
      }),
    )
  })
})

describe('resolveContractLotSize', () => {
  const contracts = [
    {
      instrument_key: 'NSE_FO|A',
      trading_symbol: 'NIFTY26JUL24500CE',
      expiry: '2026-07-28',
      lot_size: 65,
    },
    {
      instrument_key: 'NSE_FO|B',
      trading_symbol: 'NIFTY26AUG24500CE',
      expiry: '2026-08-25',
      lot_size: 70,
    },
  ]

  it('uses the exchange lot size for the selected expiry', () => {
    expect(resolveContractLotSize(contracts, '2026-08-25')).toBe(70)
  })

  it('rejects invalid contract lot metadata', () => {
    expect(
      resolveContractLotSize([{ ...contracts[0], lot_size: 0 }], '2026-07-28'),
    ).toBeNull()
  })
})

describe('fetchMarket multi-timeframe pre-seed', () => {
  const mkRow = (baseMs: number, i: number, close: number): Candle => [
    new Date(baseMs + i * 60_000).toISOString(),
    close - 1,
    close + 1,
    close - 2,
    close,
    100,
  ]
  const json = (body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  const previousRows: Candle[] = Array.from({ length: 12 }, (_, i) =>
    mkRow(Date.UTC(2026, 9, 19, 3, 45), i, 24000 + i),
  )
  const todayRows: Candle[] = Array.from({ length: 4 }, (_, i) =>
    mkRow(Date.UTC(2026, 9, 21, 3, 45), i, 24500 + i),
  )

  const stubMarketFetch = (
    historical: () => Response,
  ): ReturnType<typeof vi.fn> => {
    const fetchMock = vi.fn((input: string) => {
      if (input.includes('/api/market/candles/intraday'))
        return json({ data: { candles: todayRows } })
      if (input.includes('/api/market/candles/historical')) return historical()
      return new Response('not found', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }
  const historicalCalls = (fetchMock: ReturnType<typeof vi.fn>) =>
    fetchMock.mock.calls.filter(([input]) =>
      (input as string).includes('/api/market/candles/historical'),
    )
  const run = async () => {
    const logs: BotLog[] = []
    return fetchMarket(
      'test-token',
      (log) => logs.push(log),
      vi.fn(),
      'NIFTY 50',
    )
  }

  beforeEach(() => {
    resetPreviousSessionCandleCache()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('prepends the previous session to htfCandles and fetches it once per session', async () => {
    const fetchMock = stubMarketFetch(() =>
      json({ data: { candles: previousRows } }),
    )

    const first = await run()
    expect(first.candles).toHaveLength(4)
    // 12 previous candles → trimmed to 10 (whole 5-bar groups) + 4 today.
    expect(first.htfCandles).toHaveLength(10 + 4)
    expect(first.htfCandles[0][0]).toBe(previousRows[0][0])
    expect(first.htfCandles[10][0]).toBe(todayRows[0][0])
    // Today's own series and every 1-minute indicator stay untouched.
    expect(first.candles[0][0]).toBe(todayRows[0][0])

    const calls = historicalCalls(fetchMock)
    expect(calls).toHaveLength(1)
    const init = (calls[0] as unknown as [string, RequestInit])[1]
    const body = JSON.parse(init.body as string) as {
      fromDate: string
      toDate: string
      instrumentKey: string
    }
    expect(body.fromDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(body.toDate).toBe(body.fromDate)
    expect(body.instrumentKey).toBe('NSE_INDEX|Nifty 50')

    // Second tick: static history comes from the cache, not the wire.
    const second = await run()
    expect(second.htfCandles).toHaveLength(10 + 4)
    expect(historicalCalls(fetchMock)).toHaveLength(1)
  })

  it('falls back to today-only history when the previous session is unavailable', async () => {
    const fetchMock = stubMarketFetch(
      () => new Response('down', { status: 500 }),
    )

    const first = await run()
    expect(first.htfCandles).toBe(first.candles)
    expect(historicalCalls(fetchMock)).toHaveLength(1)

    // Failed lookups back off instead of hammering the endpoint every tick.
    const second = await run()
    expect(second.htfCandles).toBe(second.candles)
    expect(historicalCalls(fetchMock)).toHaveLength(1)
  })
})
