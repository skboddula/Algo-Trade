import { describe, it, expect, vi, afterEach } from 'vitest'
import { MasterIngestionEngine } from '../services/masterIngestor'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('MasterIngestionEngine fail-closed sentiment gate', () => {
  it('stamps a sentiment fault on snapshots when live VRD cannot be fetched', async () => {
    // Live mode (no mock fallback): every Upstox call fails, including the
    // market-wide sentiment + VIX endpoints.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('down', { status: 500 })),
    )
    const ingestor = new MasterIngestionEngine({
      mockMode: false,
      primaryUpstoxToken: 'test-token',
      useRealVrd: true,
    })

    await ingestor.fetchAndComputeMarketData()

    const snapshot = ingestor.getSnapshot('NIFTY 50')
    expect(snapshot).toBeTruthy()
    expect(snapshot?.sources?.vrdSource).toBe('fallback')
    expect(snapshot?.sources?.sentimentFault).toBeTruthy()

    const status = ingestor.getSentimentStatus()
    expect(status.source).toBe('fallback')
    expect(status.fault).toBeTruthy()
    expect(status.vix).toBeNull()
  })

  it('reports live VRD provenance when the sentiment pipeline succeeds', async () => {
    const json = (body: unknown): Response =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const url = String(input)
        if (url.includes('/market-quote/quotes?instrument_key=')) {
          // Breadth + VIX share the quotes endpoint; include both shapes.
          const data: Record<string, { net_change?: number; last_price?: number }> = {
            'NSE_INDEX:India VIX': { last_price: 14.2 },
          }
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
        if (url.includes('/market/pcr?')) return json({ data: [{ pcr: 1.1 }] })
        if (url.includes('/market/max-pain?')) return json({ data: { max_pain: 24500 } })
        if (url.includes('/news?')) return json({ data: [] })
        // Quotes/candles/chain for the index + seeds.
        if (url.includes('/historical-candle/')) {
          return json({ data: { candles: [] } })
        }
        if (url.includes('/option-chain')) {
          return json({ data: [] })
        }
        return json({ data: {} })
      }),
    )

    const ingestor = new MasterIngestionEngine({
      mockMode: false,
      primaryUpstoxToken: 'test-token',
      useRealVrd: true,
    })

    await ingestor.fetchAndComputeMarketData()

    const snapshot = ingestor.getSnapshot('NIFTY 50')
    expect(snapshot?.sources?.vrdSource).toBe('live')
    expect(snapshot?.sources?.sentimentFault).toBeNull()
    expect(snapshot?.vix).toBe(14.2)
    expect(snapshot?.vrdData?.fiiLongShort?.longPct).toBe(60)
    expect(ingestor.getSentimentStatus().live).toBe(true)
  })
})
