import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchNearestExpiry, fetchOptionChain } from '../services/marketDataSources/upstoxOptionChain'
import { getIndiaTime } from '../utils/timeUtils'

afterEach(() => {
  vi.unstubAllGlobals()
})

function istDatePlusDays(days: number): string {
  const { date } = getIndiaTime()
  return new Date(date.getTime() + days * 86_400_000).toISOString().slice(0, 10)
}

function stubFetch(handler: (url: string) => unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL) => handler(String(url)) as Response),
  )
}

describe('fetchNearestExpiry', () => {
  it('returns the nearest upcoming expiry and encodes the instrument key', async () => {
    const near = istDatePlusDays(3)
    const far = istDatePlusDays(100)
    const past = istDatePlusDays(-5)
    const urls: string[] = []
    stubFetch((url) => {
      urls.push(url)
      return { ok: true, json: async () => ({ data: [{ expiry: far }, { expiry: past }, { expiry: near }] }) }
    })

    const expiry = await fetchNearestExpiry({
      restApiBaseUrl: 'http://rest.test/v2',
      token: 'tok',
      instrumentKey: 'NSE_INDEX|Nifty 50',
    })

    expect(expiry).toBe(near)
    expect(urls[0]).toBe('http://rest.test/v2/option/contract?instrument_key=NSE_INDEX%7CNifty%2050')
  })

  it('returns null when no upcoming expiry exists', async () => {
    stubFetch(() => ({ ok: true, json: async () => ({ data: [{ expiry: istDatePlusDays(-1) }] }) }))
    const expiry = await fetchNearestExpiry({
      restApiBaseUrl: 'http://rest.test/v2',
      token: 'tok',
      instrumentKey: 'NSE_INDEX|Nifty 50',
    })
    expect(expiry).toBeNull()
  })

  it('throws on HTTP errors', async () => {
    stubFetch(() => ({ ok: false, status: 401, json: async () => ({}) }))
    await expect(
      fetchNearestExpiry({ restApiBaseUrl: 'http://rest.test/v2', token: 'expired', instrumentKey: 'NSE_INDEX|Nifty 50' }),
    ).rejects.toThrow('HTTP 401')
  })
})

describe('fetchOptionChain', () => {
  it('maps chain rows defensively and skips malformed ones', async () => {
    const expiry = istDatePlusDays(3)
    stubFetch(() => ({
      ok: true,
      json: async () => ({
        data: [
          {
            strike_price: 25000,
            expiry,
            underlying_spot_price: 25010,
            call_options: {
              instrument_key: 'NSE_FO|CE1',
              trading_symbol: 'NIFTY 25000 CE',
              market_data: { ltp: 120.5, volume: 1000, oi: 500 },
              option_greeks: { iv: 12, delta: 0.5, theta: -2, vega: 10, gamma: 0.001 },
            },
            put_options: {
              instrument_key: 'NSE_FO|PE1',
              market_data: { ltp: 90.25, volume: '800', oi: 700 },
            },
          },
          { strike_price: 0, call_options: {}, put_options: {} },
          { strike_price: 25100, call_options: { instrument_key: 'NSE_FO|CE2' } },
        ],
      }),
    }))

    const chain = await fetchOptionChain({
      restApiBaseUrl: 'http://rest.test/v2',
      token: 'tok',
      instrumentKey: 'NSE_INDEX|Nifty 50',
      expiry,
      fallbackSpotPrice: 24999,
    })

    expect(chain).toHaveLength(1)
    const row = chain[0]
    expect(row.expiry).toBe(expiry)
    expect(row.strike_price).toBe(25000)
    expect(row.underlying_spot_price).toBe(25010)
    expect(row.call_options.instrument_key).toBe('NSE_FO|CE1')
    expect(row.call_options.trading_symbol).toBe('NIFTY 25000 CE')
    expect(row.call_options.market_data).toEqual({ ltp: 120.5, volume: 1000, oi: 500 })
    expect(row.call_options.option_greeks?.iv).toBe(12)
    expect(row.put_options.market_data).toEqual({ ltp: 90.25, volume: 800, oi: 700 })
  })

  it('falls back to the provided spot price when the row omits it', async () => {
    const expiry = istDatePlusDays(3)
    stubFetch(() => ({
      ok: true,
      json: async () => ({
        data: [
          {
            strike_price: 25000,
            call_options: { instrument_key: 'NSE_FO|CE1', market_data: {} },
            put_options: { instrument_key: 'NSE_FO|PE1', market_data: {} },
          },
        ],
      }),
    }))

    const chain = await fetchOptionChain({
      restApiBaseUrl: 'http://rest.test/v2',
      token: 'tok',
      instrumentKey: 'NSE_INDEX|Nifty 50',
      expiry,
      fallbackSpotPrice: 24999,
    })

    expect(chain[0].expiry).toBe(expiry)
    expect(chain[0].underlying_spot_price).toBe(24999)
    expect(chain[0].call_options.market_data).toEqual({ ltp: 0, volume: 0, oi: 0 })
    expect(chain[0].call_options.option_greeks).toBeUndefined()
  })

  it('throws on HTTP errors', async () => {
    stubFetch(() => ({ ok: false, status: 429, json: async () => ({}) }))
    await expect(
      fetchOptionChain({
        restApiBaseUrl: 'http://rest.test/v2',
        token: 'tok',
        instrumentKey: 'NSE_INDEX|Nifty 50',
        expiry: '2099-01-07',
        fallbackSpotPrice: 25000,
      }),
    ).rejects.toThrow('HTTP 429')
  })
})
