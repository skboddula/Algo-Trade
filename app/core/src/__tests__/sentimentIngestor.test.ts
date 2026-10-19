import { describe, it, expect, vi, afterEach } from 'vitest'
import { SentimentIngestor } from '../services/sentimentIngestor'
import type { IndicatorsResult, OptionData } from '../types'

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

const chain: OptionData[] = [
  {
    expiry: '2099-01-07',
    strike_price: 24500,
    underlying_spot_price: 24500,
    call_options: {
      instrument_key: 'C1',
      trading_symbol: 'C1',
      market_data: { ltp: 100, volume: 1, oi: 100 },
    },
    put_options: {
      instrument_key: 'P1',
      trading_symbol: 'P1',
      market_data: { ltp: 100, volume: 1, oi: 150 },
    },
  },
]

const indicators: IndicatorsResult = {
  ema: 'Buy',
  adx: 'Buy',
  rsi: { value: 55, signal: 'Hold' },
  stochastic: { k: 50, d: 50, signal: 'Hold' },
  bollinger: { upper: 25100, middle: 25000, lower: 24900, signal: 'Hold', trend: 'Up' },
  atr: { value: 30, level: 'Neutral' },
  pcr: 'Buy',
  pcrValue: 1.2,
}

/** Stub the market-wide endpoints with realistic live payload shapes. */
function stubLiveFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url.includes('/market-quote/quotes?instrument_key=')) {
        const data: Record<string, { net_change: number }> = {}
        for (let i = 0; i < 30; i++) data[`adv${i}`] = { net_change: 1 }
        for (let i = 0; i < 20; i++) data[`dec${i}`] = { net_change: -1 }
        return json({ data })
      }
      if (url.includes('/market/fii?')) {
        return json({
          data: {
            'NSE_FO|INDEX_FUTURES': [
              {
                time_stamp: 3,
                total_long_contracts: 600,
                total_short_contracts: 400,
                buy_amount: 100,
                sell_amount: 50,
              },
              {
                time_stamp: 2,
                total_long_contracts: 500,
                total_short_contracts: 500,
                buy_amount: 100,
                sell_amount: 50,
              },
            ],
          },
        })
      }
      if (url.startsWith('https://www.vrdnation.com')) {
        return json({
          globalIndicesByRegion: {
            US: [{ displayName: 'Dow Futures', price: 44000, change: 0.3 }],
            ASIA: [{ displayName: 'GIFT Nifty', price: 24500, change: 0.2 }],
            Commodities: [],
          },
        })
      }
      if (url.includes('/market/dii?')) {
        return json({
          data: { 'NSE_EQ|CASH': [{ time_stamp: 1, buy_amount: 1e8, sell_amount: 2e7 }] },
        })
      }
      if (url.includes('/market/pcr?')) {
        return json({ data: [{ pcr: 1.1, timestamp: '2026-10-19T04:00:00Z' }] })
      }
      if (url.includes('/market/max-pain?')) {
        return json({ data: { max_pain: 24500 } })
      }
      if (url.includes('/news?')) {
        return json({ data: [] })
      }
      return new Response('not found', { status: 404 })
    }),
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('SentimentIngestor (live VRD pipeline)', () => {
  it('assembles a live VRD from real market-wide fetches and reports live status', async () => {
    stubLiveFetch()
    const ingestor = new SentimentIngestor({
      upstoxApiBaseUrl: 'https://api.upstox.com/v2',
      token: 'test-token',
    })

    const vrd = await ingestor.buildSymbolVrd(
      'NIFTY 50',
      '2099-01-07',
      chain,
      indicators,
      14.5,
    )

    expect(vrd.vix).toBe(14.5)
    expect(vrd.advancesDeclines?.advances).toBe(30)
    expect(vrd.advancesDeclines?.declines).toBe(20)
    expect(vrd.fiiLongShort?.longPct).toBe(60)
    expect(vrd.pcr?.value).toBe(1.1) // official PCR wins over chain PCR
    expect(vrd.maxPain).toBe(24500)
    expect(vrd.giftNifty?.openingSignal).toBe('Gap Up')
    expect(vrd.diiNetCashCr).toBeCloseTo(8, 1)
    expect(vrd.supportWall).toBe(24500)

    const status = ingestor.getStatus()
    expect(status.live).toBe(true)
    expect(status.lastError).toBeNull()
    expect(status.fetchedAtMs).not.toBeNull()
    expect(ingestor.getGlobalIndices().length).toBe(2)
    expect(ingestor.getMarketWideSnapshot().breadth?.advances).toBe(30)
  })

  it('fails closed when every market-wide source is down', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('down', { status: 500 })),
    )
    const ingestor = new SentimentIngestor({
      upstoxApiBaseUrl: 'https://api.upstox.com/v2',
      token: 'test-token',
    })

    // Assembly still resolves from chain-derived inputs (display/staging),
    // but the status must report that nothing live was fetched.
    const vrd = await ingestor.buildSymbolVrd(
      'NIFTY 50',
      '2099-01-07',
      chain,
      indicators,
      14.5,
    )
    expect(vrd).toBeTruthy()

    const status = ingestor.getStatus()
    expect(status.live).toBe(false)
    expect(status.lastError).toMatch(/market-wide sentiment fetch failed/)
  })
})
