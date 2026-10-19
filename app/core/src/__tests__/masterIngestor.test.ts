import { describe, it, expect, vi } from 'vitest'
import { MasterIngestionEngine, normalizeCandleOrder } from '../services/masterIngestor'
import type { Candle } from '../types'

describe('Master Ingestion Engine Suite (1-Fetch Shared Ingestor)', () => {
  it('initializes and computes snapshots for all tracked underlying symbols in mock mode', async () => {
    const ingestor = new MasterIngestionEngine({ mockMode: true, pollingIntervalMs: 1000 })
    await ingestor.fetchAndComputeMarketData()

    const niftySnapshot = ingestor.getSnapshot('NIFTY 50')
    const bankNiftySnapshot = ingestor.getSnapshot('BANKNIFTY')
    const finNiftySnapshot = ingestor.getSnapshot('FINNIFTY')

    expect(niftySnapshot).toBeDefined()
    expect(niftySnapshot?.spotPrice).toBeGreaterThan(20000)
    expect(niftySnapshot?.candles.length).toBeGreaterThanOrEqual(50)
    expect(niftySnapshot?.indicators).toBeDefined()
    expect(niftySnapshot?.signal).toBeDefined()

    expect(bankNiftySnapshot).toBeDefined()
    expect(bankNiftySnapshot?.spotPrice).toBeGreaterThan(40000)

    expect(finNiftySnapshot).toBeDefined()
  })

  it('emits marketTick event on every fetch with all symbol snapshots', async () => {
    const ingestor = new MasterIngestionEngine({ mockMode: true })
    const tickHandler = vi.fn()
    ingestor.on('marketTick', tickHandler)

    await ingestor.fetchAndComputeMarketData()

    expect(tickHandler).toHaveBeenCalledTimes(1)
    const emittedData = tickHandler.mock.calls[0][0]
    expect(emittedData.timestamp).toBeDefined()
    expect(emittedData.snapshots['NIFTY 50']).toBeDefined()
    expect(emittedData.snapshots['BANKNIFTY']).toBeDefined()
    expect(emittedData.snapshots['FINNIFTY']).toBeDefined()
  })

  it('maintains and retrieves option chains for strike resolution', async () => {
    const ingestor = new MasterIngestionEngine({ mockMode: true })
    await ingestor.fetchAndComputeMarketData()

    const chain = ingestor.getOptionChain('NIFTY 50')
    expect(chain.length).toBeGreaterThan(0)
    expect(chain[0].call_options.instrument_key).toBeDefined()
    expect(chain[0].put_options.instrument_key).toBeDefined()
  })

  it('stops timer cleanly on stop() call', () => {
    const ingestor = new MasterIngestionEngine({ mockMode: true, pollingIntervalMs: 50 })
    ingestor.start()
    expect((ingestor as any).isRunning).toBe(true)

    ingestor.stop()
    expect((ingestor as any).isRunning).toBe(false)
    expect((ingestor as any).timer).toBeNull()
  })

  it('passes WS feed tuning knobs through to the feed source (env → config)', () => {
    const tuned = new MasterIngestionEngine({ optionChainRefreshMs: 0, atmWindowStrikes: 2 })
    expect((tuned as any).wsSource.optionChainRefreshMs).toBe(0)
    expect((tuned as any).wsSource.atmWindowStrikes).toBe(2)

    // Unset knobs fall back to the source defaults (15000 ms / 5 strikes)
    const defaults = new MasterIngestionEngine({})
    expect((defaults as any).wsSource.optionChainRefreshMs).toBe(15000)
    expect((defaults as any).wsSource.atmWindowStrikes).toBe(5)
  })

  it('exposes feed stats for health checks (transport + WS counters)', () => {
    const mock = new MasterIngestionEngine({ mockMode: true })
    const mockStats = mock.getFeedStats()
    expect(mockStats.source).toBe('mock')
    expect(mockStats.ws.state).toBe('idle')

    const ws = new MasterIngestionEngine({ liveSource: 'ws', primaryUpstoxToken: 'test-token' })
    const wsStats = ws.getFeedStats()
    expect(wsStats.source).toBe('upstox-ws-v3')
    expect(wsStats.ws.state).toBe('idle')
    expect(wsStats.ws.frames).toEqual({ initial: 0, live: 0, marketInfo: 0, other: 0, decodeErrors: 0 })
    expect(wsStats.ws.optionKeys).toEqual({ current: 0, peak: 0 })
    expect(wsStats.ws.chain.calls).toBe(0)
    expect(wsStats.ws.lastMessageAgeMs).toBeNull()
  })

  it('normalizes Upstox newest-first candles to chronological order', () => {
    const newestFirst: Candle[] = [
      ['2026-10-19T04:17:00.000Z', 3, 3, 3, 55200, 0],
      ['2026-10-19T04:16:00.000Z', 2, 2, 2, 55100, 0],
      ['2026-10-19T04:15:00.000Z', 1, 1, 1, 55000, 0],
    ]
    const ascending = normalizeCandleOrder(newestFirst)
    expect(ascending[0][4]).toBe(55000)
    expect(ascending[2][4]).toBe(55200)

    // Already-chronological input is returned untouched (no copy churn).
    expect(normalizeCandleOrder(ascending)).toBe(ascending)
    // Degenerate inputs pass through.
    const empty: Candle[] = []
    expect(normalizeCandleOrder(empty)).toBe(empty)
    const single: Candle[] = [ascending[0]]
    expect(normalizeCandleOrder(single)).toBe(single)
  })

  it('backfills the candle buffer from the live intraday endpoint and throttles refetch', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'success',
          data: {
            candles: [
              ['2026-10-19T09:17:00+05:30', 3, 3, 3, 55200, 0],
              ['2026-10-19T09:16:00+05:30', 2, 2, 2, 55100, 0],
              ['2026-10-19T09:15:00+05:30', 1, 1, 1, 55000, 0],
            ],
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)
    try {
      const ingestor = new MasterIngestionEngine({ primaryUpstoxToken: 'test-token' })
      const seed: Candle[] = [['2026-10-19T09:14:00+05:30', 1, 1, 1, 51500, 0]]

      const first = await (ingestor as any).fetchLiveCandles('BANKNIFTY', seed)
      expect(first).toHaveLength(3)
      // Chronological order restored, timestamps canonicalized to ISO-Z.
      expect(first[0][4]).toBe(55000)
      expect(first[2][4]).toBe(55200)
      expect(first[0][0]).toBe('2026-10-19T03:45:00.000Z')
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(String(fetchMock.mock.calls[0][0])).toContain(
        '/historical-candle/intraday/NSE_INDEX%7CNifty%20Bank/1minute',
      )
      expect(ingestor.getCandlesAgeMs('BANKNIFTY')).not.toBeNull()

      // Within the 30s throttle window: no extra request, fallback returned.
      const second = await (ingestor as any).fetchLiveCandles('BANKNIFTY', first)
      expect(second).toBe(first)
      expect(fetchMock).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('keeps the previous buffer when the backfill fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 500 })))
    try {
      const ingestor = new MasterIngestionEngine({ primaryUpstoxToken: 'test-token' })
      const seed: Candle[] = [['2026-10-19T09:14:00+05:30', 1, 1, 1, 51500, 0]]
      const out = await (ingestor as any).fetchLiveCandles('NIFTY 50', seed)
      expect(out).toBe(seed)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('exposes CR-11 freshness blockers until live data lands (REST arms)', async () => {
    const live = new MasterIngestionEngine({ primaryUpstoxToken: 'test-token' })
    expect(live.getEntryBlockers('BANKNIFTY')).toEqual([
      'underlying quote stale or missing',
      'candles/indicators stale or missing',
    ])

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ data: { candles: [['2026-10-19T09:15:00+05:30', 1, 1, 1, 55000, 0]] } }),
          { status: 200 },
        ),
      ),
    )
    try {
      await (live as any).fetchLiveCandles('BANKNIFTY', [])
      // Candles have landed; the REST quote stamp only flips on a successful acquire.
      expect(live.getEntryBlockers('BANKNIFTY')).toEqual(['underlying quote stale or missing'])

      ;(live as any).lastQuoteAtMs.set('BANKNIFTY', Date.now())
      expect(live.getEntryBlockers('BANKNIFTY')).toEqual([])

      // A stale backfill gates entries again…
      ;(live as any).lastCandlesAtMs.set('BANKNIFTY', Date.now() - 200_000)
      expect(live.getEntryBlockers('BANKNIFTY')).toEqual(['candles/indicators stale or missing'])

      // …and so does a stale quote (REST arms cover quote + candles; chains
      // pass through untouched there and are not gated).
      ;(live as any).lastCandlesAtMs.set('BANKNIFTY', Date.now())
      ;(live as any).lastQuoteAtMs.set('BANKNIFTY', Date.now() - 40_000)
      expect(live.getEntryBlockers('BANKNIFTY')).toEqual(['underlying quote stale or missing'])
    } finally {
      vi.unstubAllGlobals()
    }

    // Mock mode — and live mode without a token (mock fallback semantics) —
    // is never gated.
    expect(new MasterIngestionEngine({ mockMode: true }).getEntryBlockers('BANKNIFTY')).toEqual([])
    expect(new MasterIngestionEngine({}).getEntryBlockers('BANKNIFTY')).toEqual([])
  })

  it('derives WS freshness arms from the live feed (index ticks + chain refresh)', async () => {
    const ws = new MasterIngestionEngine({ liveSource: 'ws', primaryUpstoxToken: 'test-token' })
    const feed = (ws as any).wsSource
    feed.getLastIndexTickAgeMs = () => 5_000
    feed.getLastChainSuccessAgeMs = () => 5_000

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ data: { candles: [['2026-10-19T09:15:00+05:30', 1, 1, 1, 55000, 0]] } }),
          { status: 200 },
        ),
      ),
    )
    try {
      await (ws as any).fetchLiveCandles('BANKNIFTY', [])
      expect(ws.getEntryBlockers('BANKNIFTY')).toEqual([])

      feed.getLastChainSuccessAgeMs = () => 90_000
      expect(ws.getEntryBlockers('BANKNIFTY')).toEqual(['option chain stale or missing'])

      feed.getLastIndexTickAgeMs = () => null
      expect(ws.getEntryBlockers('BANKNIFTY')).toEqual([
        'underlying quote stale or missing',
        'option chain stale or missing',
      ])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('stamps snapshot.sources on every tick (empty blocker list in mock mode)', async () => {
    const mock = new MasterIngestionEngine({ mockMode: true })
    await mock.fetchAndComputeMarketData()
    const sources = mock.getSnapshot('NIFTY 50')?.sources
    expect(sources).toBeDefined()
    expect(sources?.entryBlockedReasons).toEqual([])
    expect(sources?.quoteAgeMs).toBeNull()
  })
})
