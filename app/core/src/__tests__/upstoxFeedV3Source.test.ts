import { describe, it, expect, afterEach, vi } from 'vitest'
import { WebSocketServer, WebSocket as WsClient, type RawData } from 'ws'
import type { AddressInfo } from 'node:net'
import {
  UpstoxFeedV3Source,
  type UpstoxFeedV3SourceOptions,
} from '../services/marketDataSources/upstoxFeedV3Source'
import { decodeFeedResponse, getFeedResponseType } from '../services/marketDataSources/upstoxFeedV3Proto'
import { getIndiaTime } from '../utils/timeUtils'
import type { Candle, OptionData } from '../types'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor<T>(
  check: () => T | null | undefined | Promise<T | null | undefined>,
  timeoutMs = 3000,
  label = 'condition',
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const result = await check()
    if (result) return result as NonNullable<T>
    if (Date.now() > deadline) throw new Error(`waitFor timed out: ${label}`)
    await sleep(10)
  }
}

function sampleCandles(n = 2): Candle[] {
  return Array.from(
    { length: n },
    (_, i) => ['2026-10-17T04:00:00.000Z', 100 + i, 105 + i, 95 + i, 102 + i, 1000] as Candle,
  )
}

function istDatePlusDays(days: number): string {
  const { date } = getIndiaTime()
  return new Date(date.getTime() + days * 86_400_000).toISOString().slice(0, 10)
}

interface ConnectionRecord {
  authorization: string | undefined
  socket: WsClient
}

interface Harness {
  source: UpstoxFeedV3Source
  server: WebSocketServer
  connections: ConnectionRecord[]
  messages: Array<{ method?: string; data?: { mode?: string; instrumentKeys?: string[] } }>
  tokenBox: { value: string }
  logs: string[]
}

let activeHarness: Harness | null = null

async function startHarness(opts: { source?: Partial<UpstoxFeedV3SourceOptions>; token?: string } = {}): Promise<Harness> {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise<void>((resolve) => server.once('listening', () => resolve()))
  const { port } = server.address() as AddressInfo

  const connections: ConnectionRecord[] = []
  const messages: Harness['messages'] = []
  server.on('connection', (socket, req) => {
    connections.push({ authorization: req.headers.authorization, socket })
    socket.on('message', (raw: RawData) => messages.push(JSON.parse(raw.toString())))
  })

  const tokenBox = { value: opts.token ?? 'test-token' }
  const logs: string[] = []
  const source = new UpstoxFeedV3Source({
    restApiBaseUrl: 'http://127.0.0.1:1',
    getToken: () => tokenBox.value,
    wsUrlOverride: `ws://127.0.0.1:${port}`,
    isMarketOpen: () => true,
    optionChainRefreshMs: 0,
    onLog: (message) => logs.push(message),
    ...opts.source,
  })

  return { source, server, connections, messages, tokenBox, logs }
}

afterEach(async () => {
  const harness = activeHarness
  activeHarness = null
  vi.unstubAllGlobals()
  if (!harness) return
  harness.source.stop()
  for (const connection of harness.connections) connection.socket.terminate()
  await new Promise<void>((resolve) => harness.server.close(() => resolve()))
})

function indexFeedFrame(
  instrumentKey: string,
  ltp: number,
  i1: { open: number; high: number; low: number; close: number; vol: number; ts: number },
): Buffer {
  const type = getFeedResponseType()
  const bytes = type.encode(
    type.create({
      type: 1,
      feeds: {
        [instrumentKey]: {
          fullFeed: {
            indexFF: {
              ltpc: { ltp, ltt: i1.ts, ltq: 10, cp: ltp - 5 },
              marketOHLC: { ohlc: [{ interval: 'I1', ...i1 }] },
            },
          },
        },
      },
      currentTs: i1.ts,
    }),
  ).finish()
  return Buffer.from(bytes)
}

function optionFeedFrame(instrumentKey: string, ltp: number): Buffer {
  const type = getFeedResponseType()
  const bytes = type.encode(
    type.create({
      type: 1,
      feeds: { [instrumentKey]: { fullFeed: { marketFF: { ltpc: { ltp, ltt: Date.now(), ltq: 25, cp: ltp } } } } },
      currentTs: Date.now(),
    }),
  ).finish()
  return Buffer.from(bytes)
}

function makeChainRow(strike: number, callKey: string, putKey: string): OptionData {
  return {
    expiry: '2099-01-07',
    strike_price: strike,
    underlying_spot_price: 25000,
    call_options: { instrument_key: callKey, market_data: { ltp: 100, volume: 1, oi: 1 } },
    put_options: { instrument_key: putKey, market_data: { ltp: 200, volume: 1, oi: 1 } },
  }
}

function computeSubscribed(messages: Harness['messages']): Set<string> {
  const subscribed = new Set<string>()
  for (const message of messages) {
    if (message.method === 'sub') {
      for (const key of message.data?.instrumentKeys ?? []) subscribed.add(key)
    } else if (message.method === 'unsub') {
      for (const key of message.data?.instrumentKeys ?? []) subscribed.delete(key)
    }
  }
  return subscribed
}

function sendToLatest(harness: Harness, frame: Buffer): void {
  const latest = harness.connections[harness.connections.length - 1]
  if (!latest) throw new Error('no websocket connection available')
  latest.socket.send(frame)
}

describe('UpstoxFeedV3Source', () => {
  it('subscribes to all index keys in full mode and builds spot + live I1 candles', async () => {
    const h = await startHarness()
    activeHarness = h
    const candles = sampleCandles(2)

    await h.source.acquire({ symbol: 'NIFTY 50', timestamp: 't0', candles, optionChain: [] })
    await waitFor(() => h.source.getConnectionState() === 'open', 3000, 'ws open')
    await waitFor(() => h.messages.length > 0, 3000, 'subscription sent')

    expect(h.messages[0].method).toBe('sub')
    expect(h.messages[0].data?.mode).toBe('full')
    expect(h.messages[0].data?.instrumentKeys?.slice().sort()).toEqual([
      'NSE_INDEX|Nifty 50',
      'NSE_INDEX|Nifty Bank',
      'NSE_INDEX|Nifty Fin Service',
    ])
    expect(h.connections[0].authorization).toBe('Bearer test-token')

    const i1ts = Date.now()
    sendToLatest(
      h,
      indexFeedFrame('NSE_INDEX|Nifty 50', 25100.5, {
        open: 25010,
        high: 25110,
        low: 25000,
        close: 25100.5,
        vol: 1234,
        ts: i1ts,
      }),
    )

    const res = await waitFor(
      async () => {
        const snapshot = await h.source.acquire({ symbol: 'NIFTY 50', timestamp: 't1', candles, optionChain: [] })
        return snapshot.spotPrice === 25100.5 ? snapshot : null
      },
      3000,
      'tick applied',
    )

    expect(res.fetchFailed).toBeUndefined()
    expect(res.candles).toHaveLength(3)
    expect(res.candles[2][0]).toBe(new Date(i1ts).toISOString())
    expect(res.candles[2][4]).toBe(25100.5)
    expect(res.candles[2][5]).toBe(1234)
  })

  it('updates the open candle in place when the I1 bucket is unchanged', async () => {
    const h = await startHarness()
    activeHarness = h
    const candles = sampleCandles(2)

    await h.source.acquire({ symbol: 'NIFTY 50', timestamp: 't0', candles, optionChain: [] })
    await waitFor(() => h.source.getConnectionState() === 'open', 3000, 'ws open')

    const i1ts = Date.now()
    sendToLatest(
      h,
      indexFeedFrame('NSE_INDEX|Nifty 50', 25100, { open: 25010, high: 25110, low: 25000, close: 25100, vol: 100, ts: i1ts }),
    )
    const first = await waitFor(
      async () => {
        const snapshot = await h.source.acquire({ symbol: 'NIFTY 50', timestamp: 't1', candles, optionChain: [] })
        return snapshot.candles.length === 3 ? snapshot : null
      },
      3000,
      'first tick',
    )

    sendToLatest(
      h,
      indexFeedFrame('NSE_INDEX|Nifty 50', 25120, { open: 25010, high: 25130, low: 25000, close: 25120, vol: 150, ts: i1ts }),
    )
    const second = await waitFor(
      async () => {
        const snapshot = await h.source.acquire({ symbol: 'NIFTY 50', timestamp: 't2', candles: first.candles, optionChain: [] })
        return snapshot.candles.length === 3 && snapshot.candles[2][4] === 25120 ? snapshot : null
      },
      3000,
      'candle updated in place',
    )

    expect(second.candles[2][0]).toBe(first.candles[2][0])
    expect(second.candles[2][5]).toBe(150)
  })

  it('appends live I1 candles to a full-day buffer without truncating it (cap 1500)', async () => {
    const h = await startHarness()
    activeHarness = h
    const now = Date.now()
    const candles: Candle[] = Array.from({ length: 300 }, (_, i) => {
      const ts = new Date(now - (300 - i) * 60_000).toISOString()
      return [ts, 25000 + i, 25010 + i, 24990 + i, 25000 + i, 1000] as Candle
    })

    // A REST-warmed full-day series (≥300 candles) must survive WS merges.
    await h.source.acquire({ symbol: 'NIFTY 50', timestamp: 't0', candles, optionChain: [] })
    await waitFor(() => h.source.getConnectionState() === 'open', 3000, 'ws open')

    sendToLatest(
      h,
      indexFeedFrame('NSE_INDEX|Nifty 50', 25350, {
        open: 25340,
        high: 25360,
        low: 25330,
        close: 25350,
        vol: 500,
        ts: now,
      }),
    )

    const res = await waitFor(
      async () => {
        const snapshot = await h.source.acquire({ symbol: 'NIFTY 50', timestamp: 't1', candles, optionChain: [] })
        return snapshot.candles.length === 301 ? snapshot : null
      },
      3000,
      'full buffer kept + appended',
    )
    expect(res.candles[0][0]).toBe(candles[0][0])
    expect(res.candles[300][4]).toBe(25350)
  })

  it('flags a silent feed during market hours and recovers on the next frame', async () => {
    const h = await startHarness({ source: { staleMs: 40 } })
    activeHarness = h
    const candles = sampleCandles(2)

    await h.source.acquire({ symbol: 'NIFTY 50', timestamp: 't0', candles, optionChain: [] })
    await waitFor(() => h.source.getConnectionState() === 'open', 3000, 'ws open')

    await sleep(80)
    const stale = await h.source.acquire({ symbol: 'NIFTY 50', timestamp: 't1', candles, optionChain: [] })
    expect(stale.fetchFailed).toBe(true)
    expect(stale.fetchError).toMatch(/stale/)
    expect(stale.spotPrice).toBe(candles[candles.length - 1][4])

    sendToLatest(
      h,
      indexFeedFrame('NSE_INDEX|Nifty 50', 25222, { open: 25200, high: 25230, low: 25190, close: 25222, vol: 5, ts: Date.now() }),
    )
    const recovered = await waitFor(
      async () => {
        const snapshot = await h.source.acquire({ symbol: 'NIFTY 50', timestamp: 't2', candles, optionChain: [] })
        return snapshot.fetchFailed === undefined && snapshot.spotPrice === 25222 ? snapshot : null
      },
      3000,
      'feed recovered',
    )
    expect(recovered.fetchFailed).toBeUndefined()
  })

  it('stays quiet outside market hours', async () => {
    const h = await startHarness({ source: { isMarketOpen: () => false, staleMs: 30 } })
    activeHarness = h
    const candles = sampleCandles(2)

    const first = await h.source.acquire({ symbol: 'NIFTY 50', timestamp: 't0', candles, optionChain: [] })
    await sleep(80)
    const second = await h.source.acquire({ symbol: 'NIFTY 50', timestamp: 't1', candles, optionChain: [] })

    expect(first.fetchFailed).toBeUndefined()
    expect(second.fetchFailed).toBeUndefined()
    expect(second.spotPrice).toBe(candles[candles.length - 1][4])
  })

  it('ignores malformed frames and keeps decoding valid ones', async () => {
    const h = await startHarness()
    activeHarness = h
    const candles = sampleCandles(2)

    await h.source.acquire({ symbol: 'BANKNIFTY', timestamp: 't0', candles, optionChain: [] })
    await waitFor(() => h.source.getConnectionState() === 'open', 3000, 'ws open')

    sendToLatest(h, Buffer.from([0x0f, 0x01, 0x02])) // invalid wire type => decode must throw
    sendToLatest(
      h,
      indexFeedFrame('NSE_INDEX|Nifty Bank', 58123.5, { open: 58000, high: 58200, low: 57980, close: 58123.5, vol: 20, ts: Date.now() }),
    )

    const res = await waitFor(
      async () => {
        const snapshot = await h.source.acquire({ symbol: 'BANKNIFTY', timestamp: 't1', candles, optionChain: [] })
        return snapshot.spotPrice === 58123.5 ? snapshot : null
      },
      3000,
      'valid frame applied',
    )

    expect(res.fetchFailed).toBeUndefined()
    expect(h.logs.some((line) => line.includes('decode failed'))).toBe(true)
  })

  it('reconnects with the new token after setToken', async () => {
    const h = await startHarness()
    activeHarness = h
    const candles = sampleCandles(2)

    await h.source.acquire({ symbol: 'NIFTY 50', timestamp: 't0', candles, optionChain: [] })
    await waitFor(() => h.connections.length === 1, 3000, 'first connection')

    h.tokenBox.value = 'fresh-token'
    h.source.setToken('fresh-token')
    await h.source.acquire({ symbol: 'NIFTY 50', timestamp: 't1', candles, optionChain: [] })

    await waitFor(() => h.connections.length === 2, 3000, 'reconnected')
    expect(h.connections[1].authorization).toBe('Bearer fresh-token')
  })

  it('stop() closes the socket and does not reconnect', async () => {
    const h = await startHarness()
    activeHarness = h
    const candles = sampleCandles(2)

    await h.source.acquire({ symbol: 'NIFTY 50', timestamp: 't0', candles, optionChain: [] })
    await waitFor(() => h.connections.length === 1, 3000, 'first connection')

    h.source.stop()
    await sleep(80)

    expect(h.connections).toHaveLength(1)
    await waitFor(() => h.connections[0].socket.readyState === WsClient.CLOSED, 2000, 'server saw close')
  })

  it('refreshes the option chain over REST and keeps the previous chain on failure', async () => {
    const nearExpiry = istDatePlusDays(3)
    const farExpiry = istDatePlusDays(100)
    const pastExpiry = istDatePlusDays(-10)
    const h = await startHarness({
      source: { optionChainRefreshMs: 1, restApiBaseUrl: 'http://upstox-rest.test/v2' },
    })
    activeHarness = h

    const urls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const resolved = String(url)
        urls.push(resolved)
        if (resolved.includes('/option/contract')) {
          return {
            ok: true,
            json: async () => ({ data: [{ expiry: farExpiry }, { expiry: pastExpiry }, { expiry: nearExpiry }] }),
          } as unknown as Response
        }
        if (resolved.includes('/option/chain')) {
          return {
            ok: true,
            json: async () => ({
              data: [
                {
                  strike_price: 25000,
                  expiry: nearExpiry,
                  underlying_spot_price: 25010,
                  call_options: {
                    instrument_key: 'NSE_FO|CE1',
                    trading_symbol: 'NIFTY 25000 CE',
                    market_data: { ltp: 120.5, volume: 1000, oi: 500 },
                    option_greeks: { delta: 0.5, theta: -2, gamma: 0.001, vega: 10, iv: 12 },
                  },
                  put_options: {
                    instrument_key: 'NSE_FO|PE1',
                    market_data: { ltp: 90.25, volume: 800, oi: 700 },
                  },
                },
              ],
            }),
          } as unknown as Response
        }
        throw new Error(`unexpected fetch ${resolved}`)
      }),
    )

    const res = await h.source.acquire({ symbol: 'NIFTY 50', timestamp: 't0', candles: sampleCandles(2), optionChain: [] })

    expect(res.optionChain).toHaveLength(1)
    expect(res.optionChain[0].strike_price).toBe(25000)
    expect(res.optionChain[0].call_options.instrument_key).toBe('NSE_FO|CE1')
    expect(res.optionChain[0].call_options.option_greeks?.iv).toBe(12)
    expect(res.optionChain[0].put_options.market_data.ltp).toBe(90.25)
    expect(urls.some((url) => url.includes(`expiry_date=${nearExpiry}`))).toBe(true)
    expect(urls.some((url) => url.includes('NSE_INDEX%7CNifty%2050'))).toBe(true)

    // Network failure afterwards: previous chain is preserved, index feed is not flagged.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('rest down')
      }),
    )
    const second = await h.source.acquire({
      symbol: 'NIFTY 50',
      timestamp: 't1',
      candles: sampleCandles(2),
      optionChain: res.optionChain,
    })
    expect(second.optionChain).toBe(res.optionChain)
    expect(second.fetchFailed).toBeUndefined()
  })
  it('subscribes open-position contracts and unsubscribes them on change', async () => {
    const h = await startHarness()
    activeHarness = h
    const candles = sampleCandles(2)

    h.source.setWatchedOptionContracts(['NSE_FO|POS_CE'])
    await h.source.acquire({ symbol: 'NIFTY 50', timestamp: 't0', candles, optionChain: [] })
    await waitFor(() => h.source.getConnectionState() === 'open', 3000, 'ws open')
    await waitFor(() => h.messages.length > 0, 3000, 'initial subscription')

    expect(h.messages[0].data?.instrumentKeys).toContain('NSE_FO|POS_CE')

    h.source.setWatchedOptionContracts(['NSE_FO|POS_PE'])
    await waitFor(
      () =>
        h.messages.find((m) => m.method === 'sub' && m.data?.instrumentKeys?.includes('NSE_FO|POS_PE')) &&
        h.messages.find((m) => m.method === 'unsub' && m.data?.instrumentKeys?.includes('NSE_FO|POS_CE')),
      3000,
      'delta sub/unsub',
    )

    expect([...computeSubscribed(h.messages)].sort()).toEqual([
      'NSE_FO|POS_PE',
      'NSE_INDEX|Nifty 50',
      'NSE_INDEX|Nifty Bank',
      'NSE_INDEX|Nifty Fin Service',
    ])
  })

  it('overlays tick-level option LTPs onto chain rows and ignores unwatched keys', async () => {
    const h = await startHarness()
    activeHarness = h
    const candles = sampleCandles(2)

    await h.source.acquire({ symbol: 'NIFTY 50', timestamp: 't0', candles, optionChain: [] })
    await waitFor(() => h.source.getConnectionState() === 'open', 3000, 'ws open')

    h.source.setWatchedOptionContracts(['NSE_FO|CE_25000'])
    await waitFor(
      () => h.messages.some((m) => m.method === 'sub' && m.data?.instrumentKeys?.includes('NSE_FO|CE_25000')),
      3000,
      'watched contract subscription',
    )

    sendToLatest(h, optionFeedFrame('NSE_FO|CE_25000', 130.75))
    sendToLatest(h, optionFeedFrame('NSE_FO|UNWATCHED', 999))

    const chain = [
      makeChainRow(25000, 'NSE_FO|CE_25000', 'NSE_FO|PE_25000'),
      makeChainRow(25050, 'NSE_FO|CE_25050', 'NSE_FO|PE_25050'),
      makeChainRow(25100, 'NSE_FO|UNWATCHED', 'NSE_FO|PE_25100'),
    ]
    const res = await waitFor(
      async () => {
        const snapshot = await h.source.acquire({ symbol: 'NIFTY 50', timestamp: 't1', candles, optionChain: chain })
        return snapshot.optionChain[0].call_options.market_data.ltp === 130.75 ? snapshot : null
      },
      3000,
      'overlay applied',
    )

    expect(res.optionChain[0].call_options.market_data.ltp).toBe(130.75)
    expect(res.optionChain[0].put_options.market_data.ltp).toBe(200) // untouched
    expect(res.optionChain[1]).toBe(chain[1]) // unchanged row keeps identity
    expect(res.optionChain[2].call_options.market_data.ltp).toBe(100) // unwatched key ignored
  })

  it('subscribes the nearest-strike window after a chain refresh', async () => {
    const nearExpiry = istDatePlusDays(3)
    const h = await startHarness({
      source: { optionChainRefreshMs: 1, atmWindowStrikes: 2, restApiBaseUrl: 'http://upstox-rest.test/v2' },
    })
    activeHarness = h

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const resolved = String(url)
        if (resolved.includes('/option/contract')) {
          return { ok: true, json: async () => ({ data: [{ expiry: nearExpiry }] }) } as unknown as Response
        }
        if (resolved.includes('/option/chain')) {
          return {
            ok: true,
            json: async () => ({
              data: [24900, 24950, 25000, 25050, 25100].map((strike) => ({
                strike_price: strike,
                expiry: nearExpiry,
                underlying_spot_price: 25000,
                call_options: { instrument_key: `NSE_FO|CE_${strike}`, market_data: { ltp: 100, volume: 1, oi: 1 } },
                put_options: { instrument_key: `NSE_FO|PE_${strike}`, market_data: { ltp: 100, volume: 1, oi: 1 } },
              })),
            }),
          } as unknown as Response
        }
        throw new Error(`unexpected fetch ${resolved}`)
      }),
    )

    await h.source.acquire({ symbol: 'NIFTY 50', timestamp: 't0', candles: sampleCandles(2), optionChain: [] })
    await waitFor(() => h.source.getConnectionState() === 'open', 3000, 'ws open')

    const i1ts = Date.now()
    sendToLatest(
      h,
      indexFeedFrame('NSE_INDEX|Nifty 50', 25000, { open: 24990, high: 25010, low: 24980, close: 25000, vol: 10, ts: i1ts }),
    )
    await waitFor(
      async () => {
        const snapshot = await h.source.acquire({ symbol: 'NIFTY 50', timestamp: 't1', candles: sampleCandles(2), optionChain: [] })
        return snapshot.spotPrice === 25000
      },
      3000,
      'spot from ws',
    )

    // Settled subscription set: nearest two strikes × CE/PE (added incrementally).
    const expected = ['NSE_FO|CE_24950', 'NSE_FO|CE_25000', 'NSE_FO|PE_24950', 'NSE_FO|PE_25000']
    const settled = await waitFor(
      () => {
        const subscribed = [...computeSubscribed(h.messages)].filter((key) => key.startsWith('NSE_FO|')).sort()
        return JSON.stringify(subscribed) === JSON.stringify(expected) ? subscribed : null
      },
      3000,
      'window settled',
    )
    expect(settled).toHaveLength(4)
  })

  it('accumulates feed stats for calibration (frames, ticks, option keys, chain latency/failures)', async () => {
    const nearExpiry = istDatePlusDays(3)
    const h = await startHarness({
      source: { optionChainRefreshMs: 1, restApiBaseUrl: 'http://upstox-rest.test/v2' },
    })
    activeHarness = h

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const resolved = String(url)
        if (resolved.includes('/option/contract')) {
          return { ok: true, json: async () => ({ data: [{ expiry: nearExpiry }] }) } as unknown as Response
        }
        if (resolved.includes('/option/chain')) {
          return {
            ok: true,
            json: async () => ({
              data: [
                {
                  strike_price: 103,
                  expiry: nearExpiry,
                  underlying_spot_price: 103,
                  call_options: { instrument_key: 'NSE_FO|CE1', market_data: { ltp: 10, volume: 1, oi: 1 } },
                  put_options: { instrument_key: 'NSE_FO|PE1', market_data: { ltp: 20, volume: 1, oi: 1 } },
                },
              ],
            }),
          } as unknown as Response
        }
        throw new Error(`unexpected fetch ${resolved}`)
      }),
    )

    await h.source.acquire({ symbol: 'NIFTY 50', timestamp: 't0', candles: sampleCandles(2), optionChain: [] })
    await waitFor(() => h.source.getConnectionState() === 'open', 3000, 'ws open')
    await waitFor(() => computeSubscribed(h.messages).has('NSE_FO|CE1'), 3000, 'option subscription')

    const i1ts = Date.now()
    sendToLatest(
      h,
      indexFeedFrame('NSE_INDEX|Nifty 50', 104, { open: 100, high: 105, low: 99, close: 104, vol: 5, ts: i1ts }),
    )
    sendToLatest(h, optionFeedFrame('NSE_FO|CE1', 12.5))

    const stats = await waitFor(
      () => {
        const current = h.source.getStats()
        return current.ticks.index >= 1 && current.ticks.option >= 1 ? current : null
      },
      3000,
      'ticks counted',
    )

    expect(stats.state).toBe('open')
    expect(stats.activeForMs).toBeGreaterThanOrEqual(0)
    expect(stats.frames).toEqual({ initial: 0, live: 2, marketInfo: 0, other: 0, decodeErrors: 0 })
    expect(stats.ticks).toEqual({ index: 1, option: 1 })
    expect(stats.optionKeys).toEqual({ current: 2, peak: 2 })
    expect(stats.reconnects).toBe(0)
    expect(stats.chain.calls).toBe(1)
    expect(stats.chain.failures).toBe(0)
    expect(typeof stats.chain.lastLatencyMs).toBe('number')
    expect(stats.expiry).toEqual({ calls: 1, failures: 0 })
    expect(stats.lastMessageAgeMs).toBeGreaterThanOrEqual(0)

    // Chain failure on the next due refresh: counters record it, expiry stays cached.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('rest down')
      }),
    )
    await h.source.acquire({ symbol: 'NIFTY 50', timestamp: 't1', candles: sampleCandles(2), optionChain: [] })

    const failed = h.source.getStats()
    expect(failed.chain.calls).toBe(2)
    expect(failed.chain.failures).toBe(1)
    expect(failed.chain.lastError).toContain('rest down')
    expect(failed.expiry.calls).toBe(1)
  })

  it('emits a periodic feed-stats log line while active and stops on stop()', async () => {
    const h = await startHarness({ source: { statsIntervalMs: 25 } })
    activeHarness = h

    await h.source.acquire({ symbol: 'NIFTY 50', timestamp: 't0', candles: sampleCandles(2), optionChain: [] })
    await waitFor(() => h.source.getConnectionState() === 'open', 3000, 'ws open')

    const line = await waitFor(() => h.logs.find((entry) => entry.includes('feed-stats ')), 3000, 'stats log')
    const parsed = JSON.parse(line.slice(line.indexOf('feed-stats ') + 'feed-stats '.length))
    expect(parsed.state).toBe('open')
    expect(parsed.frames).toBeDefined()
    expect(parsed.optionKeys.current).toBeGreaterThanOrEqual(0)

    h.source.stop()
    const logged = h.logs.filter((entry) => entry.includes('feed-stats ')).length
    await sleep(80)
    expect(h.logs.filter((entry) => entry.includes('feed-stats ')).length).toBe(logged)
  })
})

describe('upstoxFeedV3Proto', () => {
  it('round-trips option feeds through the vendored V3 schema', () => {
    const type = getFeedResponseType()
    const bytes = type.encode(
      type.create({
        type: 1,
        feeds: {
          'NSE_FO|48000': {
            fullFeed: {
              marketFF: { ltpc: { ltp: 155.2 }, oi: 4200, optionGreeks: { delta: 0.52, iv: 12.5 } },
            },
          },
        },
        currentTs: 1725820200000,
      }),
    ).finish()

    const decoded = decodeFeedResponse(Buffer.from(bytes))
    expect(decoded.type).toBe('live_feed')
    const feed = decoded.feeds?.['NSE_FO|48000']
    expect(feed?.fullFeed?.marketFF?.ltpc?.ltp).toBe(155.2)
    expect(feed?.fullFeed?.marketFF?.oi).toBe(4200)
    expect(feed?.fullFeed?.marketFF?.optionGreeks?.delta).toBeCloseTo(0.52)
  })
})
