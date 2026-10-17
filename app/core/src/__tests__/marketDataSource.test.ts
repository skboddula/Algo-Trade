import { describe, it, expect, vi, afterEach } from 'vitest'
import { MockMarketDataSource } from '../services/marketDataSources/mockMarketDataSource'
import { RestMarketDataSource } from '../services/marketDataSources/restMarketDataSource'
import type { Candle } from '../types'

afterEach(() => {
  vi.unstubAllGlobals()
})

function sampleCandles(n = 3): Candle[] {
  return Array.from(
    { length: n },
    (_, i) => ['2026-10-17T04:00:00.000Z', 100 + i, 105 + i, 95 + i, 102 + i, 1000] as Candle,
  )
}

describe('MockMarketDataSource', () => {
  it('appends a synthetic candle and derives spot from it', async () => {
    const source = new MockMarketDataSource()
    const candles = sampleCandles()
    const res = await source.acquire({ symbol: 'NIFTY 50', timestamp: 't0', candles, optionChain: [] })

    expect(res.candles.length).toBe(candles.length + 1)
    expect(res.candles[res.candles.length - 1][0]).toBe('t0')
    expect(res.spotPrice).toBe(res.candles[res.candles.length - 1][4])
    expect(res.fetchFailed).toBeUndefined()
  })

  it('caps the candle series at 100 and generates a chain when empty', async () => {
    const source = new MockMarketDataSource()
    const res = await source.acquire({
      symbol: 'NIFTY 50',
      timestamp: 't0',
      candles: sampleCandles(100),
      optionChain: [],
    })

    expect(res.candles.length).toBe(100)
    expect(res.optionChain.length).toBeGreaterThan(0)
    expect(res.optionChain[0].call_options.instrument_key).toContain('CE')
  })

  it('keeps an existing option chain untouched', async () => {
    const source = new MockMarketDataSource()
    const chain = [{ marker: true }] as any
    const res = await source.acquire({
      symbol: 'BANKNIFTY',
      timestamp: 't0',
      candles: sampleCandles(),
      optionChain: chain,
    })

    expect(res.optionChain).toBe(chain)
  })
})

describe('RestMarketDataSource', () => {
  it('returns the quote LTP and passes candles/chain through on success', async () => {
    const candles = sampleCandles()
    const chain = [{ marker: true }] as any
    const fetchSpy = vi.fn(
      async (_url: string | URL, _init?: RequestInit) =>
        ({
          ok: true,
          json: async () => ({ data: { 'NSE_INDEX:Nifty 50': { last_price: 25123.45 } } }),
        }) as unknown as Response,
    )
    vi.stubGlobal('fetch', fetchSpy)

    const source = new RestMarketDataSource({
      upstoxApiBaseUrl: 'https://api.upstox.com/v2',
      getToken: () => 'tok',
    })
    const res = await source.acquire({ symbol: 'NIFTY 50', timestamp: 't0', candles, optionChain: chain })

    expect(res.spotPrice).toBe(25123.45)
    expect(res.candles).toBe(candles)
    expect(res.optionChain).toBe(chain)
    expect(res.fetchFailed).toBeUndefined()

    // Token is read from the getter on every call (runtime token swaps)
    const init = fetchSpy.mock.calls[0][1]
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer tok')
  })

  it('flags failure and falls back to the last close on HTTP errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401 }) as unknown as Response))
    const candles = sampleCandles()

    const source = new RestMarketDataSource({
      upstoxApiBaseUrl: 'https://api.upstox.com/v2',
      getToken: () => 'expired',
    })
    const res = await source.acquire({ symbol: 'NIFTY 50', timestamp: 't0', candles, optionChain: [] })

    expect(res.fetchFailed).toBe(true)
    expect(res.fetchError).toBe('HTTP 401')
    expect(res.spotPrice).toBe(candles[candles.length - 1][4])
  })

  it('flags failure on network errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('socket hang up')
      }),
    )
    const candles = sampleCandles()

    const source = new RestMarketDataSource({
      upstoxApiBaseUrl: 'https://api.upstox.com/v2',
      getToken: () => 'tok',
    })
    const res = await source.acquire({ symbol: 'NIFTY 50', timestamp: 't0', candles, optionChain: [] })

    expect(res.fetchFailed).toBe(true)
    expect(res.fetchError).toBe('socket hang up')
    expect(res.spotPrice).toBe(candles[candles.length - 1][4])
  })

  it('flags failure when the response lacks last_price', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          ({
            ok: true,
            json: async () => ({ data: {} }),
          }) as unknown as Response,
      ),
    )
    const candles = sampleCandles()

    const source = new RestMarketDataSource({
      upstoxApiBaseUrl: 'https://api.upstox.com/v2',
      getToken: () => 'tok',
    })
    const res = await source.acquire({ symbol: 'NIFTY 50', timestamp: 't0', candles, optionChain: [] })

    expect(res.fetchFailed).toBe(true)
    expect(res.fetchError).toBe('response missing last_price')
    expect(res.spotPrice).toBe(candles[candles.length - 1][4])
  })
})
