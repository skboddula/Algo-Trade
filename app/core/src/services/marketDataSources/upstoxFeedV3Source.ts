// Upstox Market Data Feed V3 (WebSocket) source.
//
// Transport responsibilities:
//   - index ticks (LTPC) for the three tracked underlyings               [WS]
//   - live 1-minute candles, merged from the feed's I1 OHLC entries       [WS]
//   - tradeable option chains (strikes/keys/ltp/oi), refreshed from REST  [fallback]
//   - connection watchdog: a silent or dropped feed surfaces as `fetchFailed`,
//     so the engine's existing feed-health alerts fire exactly once
//
// Connection: optionally authorize via GET {feedApiBaseUrl}/feed/market-data-feed/authorize
// (docs: alternative method), falling back to the documented direct wss endpoint with
// automatic-redirect following. Tests override the URL entirely via `wsUrlOverride`.

import WebSocket from 'ws'
import type { Candle, OptionData, UnderlyingSymbol } from '../../types'
import { UNDERLYING_INSTRUMENT_KEYS } from '../../types'
import { getIndiaTime, isMarketOpen } from '../../utils/timeUtils'
import type { MarketDataSource, SymbolDataRequest, SymbolMarketData } from '../marketDataSource'
import { decodeFeedResponse, type DecodedFeed, type DecodedFeedResponse, type DecodedOhlc } from './upstoxFeedV3Proto'
import { fetchNearestExpiry, fetchOptionChain } from './upstoxOptionChain'

export interface UpstoxFeedV3SourceOptions {
  /** REST base for the option-chain fallback, e.g. https://api.upstox.com/v2 */
  restApiBaseUrl: string
  /** Current master token; read on every (re)connect so runtime swaps work. */
  getToken: () => string | undefined
  /** V3 API base used for the authorize call (default https://api.upstox.com/v3). */
  feedApiBaseUrl?: string
  /** Direct V3 WebSocket endpoint (default wss://api.upstox.com/v3/feed/market-data-feed). */
  feedWssUrl?: string
  /** Test seam: connect straight to this URL and skip the authorize call. */
  wsUrlOverride?: string
  /** Silence after which an open feed counts as stale (default 15000 ms). */
  staleMs?: number
  /** Grace period for a connection attempt before it counts as failed (default 20000 ms). */
  connectGraceMs?: number
  /** Reconnect backoff bounds (default 3000–30000 ms). */
  reconnectMinMs?: number
  reconnectMaxMs?: number
  /** Option-chain refresh cadence per symbol (default 15000 ms; 0 disables). */
  optionChainRefreshMs?: number
  /** Test seam overriding local market-hours detection. */
  isMarketOpen?: () => boolean
  /** Diagnostics sink (defaults to console.warn). */
  onLog?: (message: string) => void
}

type ConnectionState = 'idle' | 'connecting' | 'open' | 'closed'

interface IndexTick {
  ltp: number
  ltt: number
  ohlcI1?: DecodedOhlc
}

interface ExpiryCacheEntry {
  date: string
  expiry: string | null
  failedAt?: number
}

const DEFAULT_STALE_MS = 15_000
const DEFAULT_CONNECT_GRACE_MS = 20_000
const DEFAULT_RECONNECT_MIN_MS = 3_000
const DEFAULT_RECONNECT_MAX_MS = 30_000
const DEFAULT_OPTION_CHAIN_REFRESH_MS = 15_000
const EXPIRY_RETRY_MS = 60_000
const I1_INTERVAL = 'I1'

const INSTRUMENT_KEY_TO_SYMBOL: Record<string, UnderlyingSymbol> = Object.fromEntries(
  (Object.entries(UNDERLYING_INSTRUMENT_KEYS) as [UnderlyingSymbol, string][]).map(([symbol, key]) => [key, symbol]),
)

export class UpstoxFeedV3Source implements MarketDataSource {
  public readonly name = 'upstox-ws-v3'

  private readonly restApiBaseUrl: string
  private readonly feedApiBaseUrl: string
  private readonly feedWssUrl: string
  private readonly wsUrlOverride?: string
  private readonly getToken: () => string | undefined
  private readonly staleMs: number
  private readonly connectGraceMs: number
  private readonly reconnectMinMs: number
  private readonly reconnectMaxMs: number
  private readonly optionChainRefreshMs: number
  private readonly isMarketOpenFn: () => boolean
  private readonly onLog: (message: string) => void

  private state: ConnectionState = 'idle'
  private socket: WebSocket | null = null
  private stopped = false
  private reconnectTimer: NodeJS.Timeout | null = null
  private reconnectDelay: number
  private connectStartedAt = 0
  private lastConnectAttemptAt = 0
  private lastMessageAt = 0

  private readonly indexCache = new Map<UnderlyingSymbol, IndexTick>()
  private readonly lastChainFetchAt = new Map<UnderlyingSymbol, number>()
  private readonly expiryCache = new Map<UnderlyingSymbol, ExpiryCacheEntry>()

  constructor(opts: UpstoxFeedV3SourceOptions) {
    this.restApiBaseUrl = opts.restApiBaseUrl
    this.feedApiBaseUrl = opts.feedApiBaseUrl ?? 'https://api.upstox.com/v3'
    this.feedWssUrl = opts.feedWssUrl ?? 'wss://api.upstox.com/v3/feed/market-data-feed'
    this.wsUrlOverride = opts.wsUrlOverride
    this.getToken = opts.getToken
    this.staleMs = opts.staleMs ?? DEFAULT_STALE_MS
    this.connectGraceMs = opts.connectGraceMs ?? DEFAULT_CONNECT_GRACE_MS
    this.reconnectMinMs = opts.reconnectMinMs ?? DEFAULT_RECONNECT_MIN_MS
    this.reconnectMaxMs = opts.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS
    this.optionChainRefreshMs = opts.optionChainRefreshMs ?? DEFAULT_OPTION_CHAIN_REFRESH_MS
    this.isMarketOpenFn = opts.isMarketOpen ?? (() => isMarketOpen())
    this.onLog = opts.onLog ?? ((message) => console.warn(message))
    this.reconnectDelay = this.reconnectMinMs
  }

  // -- MarketDataSource ------------------------------------------------------

  public async acquire(req: SymbolDataRequest): Promise<SymbolMarketData> {
    const { symbol, candles, optionChain } = req
    this.ensureConnection()

    const marketOpen = this.isMarketOpenFn()
    const cached = this.indexCache.get(symbol)
    const fallbackPrice = candles.length ? candles[candles.length - 1][4] : 24500
    const spotPrice = cached?.ltp ?? fallbackPrice
    const mergedCandles = cached?.ohlcI1 ? mergeOhlcIntoCandles(candles, cached.ohlcI1) : candles

    let nextChain = optionChain
    if (marketOpen && this.optionChainRefreshMs > 0) {
      nextChain = await this.refreshOptionChainIfDue(symbol, optionChain, spotPrice)
    }

    const staleReason = this.stalenessIssue(marketOpen)
    if (staleReason) {
      return { spotPrice, candles: mergedCandles, optionChain: nextChain, fetchFailed: true, fetchError: staleReason }
    }
    return { spotPrice, candles: mergedCandles, optionChain: nextChain }
  }

  /** Drop the current connection so the next acquire() reconnects with the new token. */
  public setToken(_token: string): void {
    this.teardownSocket()
  }

  /** Close the feed and stop reconnecting (called on engine shutdown). */
  public stop(): void {
    this.stopped = true
    this.teardownSocket()
  }

  /** Visible for diagnostics/tests. */
  public getConnectionState(): ConnectionState {
    return this.state
  }

  // -- connection management -------------------------------------------------

  private ensureConnection(): void {
    if (!this.getToken()) return
    if (this.state === 'connecting' || this.state === 'open') return
    this.stopped = false
    void this.connect()
  }

  private async connect(): Promise<void> {
    const token = this.getToken()
    if (!token) return

    this.state = 'connecting'
    this.connectStartedAt = Date.now()
    this.lastConnectAttemptAt = this.connectStartedAt

    let url = this.wsUrlOverride ?? this.feedWssUrl
    if (!this.wsUrlOverride) {
      const authorized = await this.authorizeUrl(token)
      if (authorized) url = authorized
    }
    if (this.stopped) {
      this.state = 'closed'
      return
    }

    let socket: WebSocket
    try {
      socket = new WebSocket(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        followRedirects: true,
      })
    } catch (err) {
      this.log(`ws connect failed: ${(err as Error).message}`)
      this.state = 'closed'
      this.scheduleReconnect()
      return
    }

    this.socket = socket
    socket.on('open', () => {
      this.state = 'open'
      this.lastMessageAt = Date.now()
      this.reconnectDelay = this.reconnectMinMs
      this.sendSubscription(socket)
    })
    socket.on('message', (data) => this.handleMessage(toBuffer(data)))
    socket.on('error', (err) => this.log(`ws error: ${err.message}`))
    socket.on('close', (code, reason) => this.handleClose(code, reason))
  }

  private async authorizeUrl(token: string): Promise<string | null> {
    try {
      const res = await fetch(`${this.feedApiBaseUrl}/feed/market-data-feed/authorize`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      })
      if (!res.ok) return null
      const payload = (await res.json()) as {
        data?: { authorized_redirect_uri?: unknown; authorizedRedirectUri?: unknown }
      }
      const uri = payload?.data?.authorized_redirect_uri ?? payload?.data?.authorizedRedirectUri
      return typeof uri === 'string' && uri.startsWith('wss://') ? uri : null
    } catch {
      // Not fatal: the direct endpoint handles auth via redirect.
      return null
    }
  }

  private sendSubscription(socket: WebSocket): void {
    try {
      socket.send(
        Buffer.from(
          JSON.stringify({
            guid: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
            method: 'sub',
            data: { mode: 'full', instrumentKeys: Object.values(UNDERLYING_INSTRUMENT_KEYS) },
          }),
        ),
      )
    } catch (err) {
      this.log(`subscription send failed: ${(err as Error).message}`)
    }
  }

  private handleMessage(data: Buffer): void {
    let decoded: DecodedFeedResponse
    try {
      decoded = decodeFeedResponse(data)
    } catch (err) {
      this.log(`ws frame decode failed: ${(err as Error).message}`)
      return
    }

    this.lastMessageAt = Date.now()
    if (!decoded.feeds) return
    for (const [instrumentKey, feed] of Object.entries(decoded.feeds)) {
      const symbol = INSTRUMENT_KEY_TO_SYMBOL[instrumentKey]
      if (!symbol) continue
      const tick = extractIndexTick(feed)
      if (tick) this.indexCache.set(symbol, tick)
    }
  }

  private handleClose(code: number, reason: Buffer): void {
    this.socket = null
    this.state = 'closed'
    if (this.stopped) return
    const detail = reason?.length ? `: ${reason.toString()}` : ''
    this.log(`ws closed (code ${code}${detail})`)
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return
    const delay = this.reconnectDelay
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.reconnectDelay = Math.min(Math.round(this.reconnectDelay * 1.5), this.reconnectMaxMs)
      void this.connect()
    }, delay)
    this.reconnectTimer.unref()
  }

  private teardownSocket(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    const socket = this.socket
    this.socket = null
    this.state = 'closed'
    this.reconnectDelay = this.reconnectMinMs
    if (!socket) return
    socket.removeAllListeners()
    socket.on('error', () => {}) // swallow the abort-of-handshake error, if any
    try {
      socket.close()
    } catch {
      // already closed
    }
  }

  // -- watchdog --------------------------------------------------------------

  private stalenessIssue(marketOpen: boolean): string | null {
    if (!marketOpen) return null // overnight/weekend silence is expected
    const now = Date.now()

    if (this.state === 'open') {
      const silentFor = now - this.lastMessageAt
      if (silentFor > this.staleMs) return `stale (no feed data for ${Math.round(silentFor / 1000)}s)`
      return null
    }
    if (this.state === 'idle' || this.lastConnectAttemptAt === 0) return null

    const sinceAttempt = now - Math.max(this.lastConnectAttemptAt, this.connectStartedAt)
    if (sinceAttempt > this.connectGraceMs) {
      return `disconnected (connection unavailable for ${Math.round(sinceAttempt / 1000)}s)`
    }
    return null
  }

  // -- option-chain fallback ---------------------------------------------------

  private async refreshOptionChainIfDue(
    symbol: UnderlyingSymbol,
    currentChain: OptionData[],
    spotPrice: number,
  ): Promise<OptionData[]> {
    const now = Date.now()
    if (now - (this.lastChainFetchAt.get(symbol) ?? 0) < this.optionChainRefreshMs) return currentChain

    const token = this.getToken()
    if (!token) return currentChain
    this.lastChainFetchAt.set(symbol, now)

    const instrumentKey = UNDERLYING_INSTRUMENT_KEYS[symbol]
    try {
      const expiry = await this.ensureExpiry(symbol, token, instrumentKey)
      if (!expiry) return currentChain
      const chain = await fetchOptionChain({
        restApiBaseUrl: this.restApiBaseUrl,
        token,
        instrumentKey,
        expiry,
        fallbackSpotPrice: spotPrice,
      })
      return chain.length ? chain : currentChain
    } catch (err) {
      this.log(`option-chain refresh failed for ${symbol}: ${(err as Error).message}`)
      return currentChain
    }
  }

  private async ensureExpiry(symbol: UnderlyingSymbol, token: string, instrumentKey: string): Promise<string | null> {
    const today = getIndiaTime().dateString
    const cached = this.expiryCache.get(symbol)
    if (cached && cached.date === today) {
      if (cached.expiry) return cached.expiry
      if (cached.failedAt && Date.now() - cached.failedAt < EXPIRY_RETRY_MS) return null
    }

    try {
      const expiry = await fetchNearestExpiry({ restApiBaseUrl: this.restApiBaseUrl, token, instrumentKey })
      this.expiryCache.set(symbol, { date: today, expiry })
      return expiry
    } catch (err) {
      this.log(`expiry lookup failed for ${symbol}: ${(err as Error).message}`)
      this.expiryCache.set(symbol, { date: today, expiry: null, failedAt: Date.now() })
      return null
    }
  }

  private log(message: string): void {
    this.onLog(`[upstox-ws-v3] ${message}`)
  }
}

// -- helpers -------------------------------------------------------------------

function extractIndexTick(feed: DecodedFeed): IndexTick | null {
  const ltpc = feed.ltpc ?? feed.fullFeed?.indexFF?.ltpc ?? feed.fullFeed?.marketFF?.ltpc
  if (!ltpc || typeof ltpc.ltp !== 'number' || ltpc.ltp <= 0) return null

  const ohlcEntries = feed.fullFeed?.indexFF?.marketOHLC?.ohlc ?? []
  const ohlcI1 = ohlcEntries.find(
    (entry) => entry?.interval === I1_INTERVAL && typeof entry.open === 'number' && typeof entry.ts === 'number',
  )
  return {
    ltp: ltpc.ltp,
    ltt: typeof ltpc.ltt === 'number' ? ltpc.ltt : 0,
    ohlcI1,
  }
}

/**
 * Merge one live I1 OHLC entry into the candle series:
 * same timestamp updates the open candle in place, newer timestamps append
 * (capped at 100), older ones are ignored.
 */
function mergeOhlcIntoCandles(candles: Candle[], ohlc: DecodedOhlc): Candle[] {
  const ts = ohlc.ts
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return candles

  const timestamp = new Date(ts).toISOString()
  const candle: Candle = [timestamp, ohlc.open ?? 0, ohlc.high ?? 0, ohlc.low ?? 0, ohlc.close ?? 0, ohlc.vol ?? 0]
  if (!Number.isFinite(candle[4]) || candle[4] <= 0) return candles

  const last = candles[candles.length - 1]
  if (!last) return [candle]
  if (timestamp === last[0]) return [...candles.slice(0, -1), candle]
  if (ts > Date.parse(last[0])) return [...candles.slice(-99), candle]
  return candles
}

function toBuffer(data: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(data)) return data
  if (Array.isArray(data)) return Buffer.concat(data)
  return Buffer.from(data)
}
