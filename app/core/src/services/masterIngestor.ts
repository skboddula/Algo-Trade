import { EventEmitter } from 'events'
import type {
  UnderlyingSymbol,
  MarketSnapshot,
  Candle,
  OptionData,
  VrdData,
  AllSignalData,
} from '../types'
import { UNDERLYING_INSTRUMENT_KEYS } from '../types'
import { computeAllIndicators } from './indicators'
import { getFinalSignal } from './strategyEngine'
import { DEFAULT_STRATEGY_CONFIG } from '../constants'
import { getIndiaTime } from '../utils/timeUtils'
import type { Notifier } from './notifier'
import type { MarketDataSource } from './marketDataSource'
import { MockMarketDataSource } from './marketDataSources/mockMarketDataSource'
import { RestMarketDataSource } from './marketDataSources/restMarketDataSource'
import { UpstoxFeedV3Source, type UpstoxFeedStats } from './marketDataSources/upstoxFeedV3Source'
import { DAEMON_SETTING_KEYS, type SettingsStore } from './daemonSettings'

export interface MasterIngestorConfig {
  pollingIntervalMs: number
  upstoxApiBaseUrl: string
  primaryUpstoxToken?: string
  mockMode?: boolean
  /** Live transport: 'rest' (LTP polling, default) or 'ws' (Upstox Feed V3 WebSocket). */
  liveSource?: 'rest' | 'ws'
  /**
   * WS mode: option-chain REST refresh cadence per symbol in ms
   * (default 15000; 0 disables the chain refresh).
   */
  optionChainRefreshMs?: number
  /**
   * WS mode: nearest strikes per symbol streamed at tick level around spot
   * (default 5; 0 disables the ATM window).
   */
  atmWindowStrikes?: number
  notifier?: Notifier
  /**
   * When provided, every setToken() persists the master token into the
   * daemon's settings store so a token entered in the window (or refreshed
   * via OAuth) survives daemon restarts and reboots.
   */
  settingsStore?: SettingsStore | null
}

/**
 * Upstox's intraday candle endpoint returns candles newest-first; the core
 * indicator engine expects chronological (oldest→newest) order. Reverse only
 * when needed so the WS merge (`append when newer`) stays consistent.
 */
export function normalizeCandleOrder(rows: Candle[]): Candle[] {
  if (rows.length < 2) return rows
  return rows[0][0] > rows[rows.length - 1][0] ? [...rows].reverse() : rows
}

export class MasterIngestionEngine extends EventEmitter {
  private static readonly CANDLE_REFRESH_MS = 30_000
  private isRunning = false
  private timer: NodeJS.Timeout | null = null
  private candleBuffer: Map<UnderlyingSymbol, Candle[]> = new Map()
  private latestSnapshots: Map<UnderlyingSymbol, MarketSnapshot> = new Map()
  private latestOptionChains: Map<UnderlyingSymbol, OptionData[]> = new Map()
  private lastCandleFetchMs: Map<UnderlyingSymbol, number> = new Map()
  private lastCandlesAtMs: Map<UnderlyingSymbol, number> = new Map()
  private latestVrd: VrdData | null = null
  private config: MasterIngestorConfig
  private consecutiveFailedTicks = 0
  private feedDownAlerted = false
  private lastFeedError = ''
  private readonly mockSource: MockMarketDataSource
  private readonly restSource: RestMarketDataSource
  private readonly wsSource: UpstoxFeedV3Source

  constructor(config?: Partial<MasterIngestorConfig>) {
    super()
    this.setMaxListeners(100) // Prevent memory leak warnings on high subscriber counts
    this.config = {
      pollingIntervalMs: config?.pollingIntervalMs ?? 2000,
      upstoxApiBaseUrl: config?.upstoxApiBaseUrl ?? 'https://api.upstox.com/v2',
      primaryUpstoxToken: config?.primaryUpstoxToken,
      mockMode: config?.mockMode ?? false,
      liveSource: config?.liveSource ?? 'rest',
      optionChainRefreshMs: config?.optionChainRefreshMs,
      atmWindowStrikes: config?.atmWindowStrikes,
      notifier: config?.notifier,
      settingsStore: config?.settingsStore ?? null,
    }

    // Pluggable transport sources (mock synthesis / Upstox REST polling today;
    // a WebSocket feed adapter plugs in behind the same interface)
    this.mockSource = new MockMarketDataSource()
    this.restSource = new RestMarketDataSource({
      upstoxApiBaseUrl: this.config.upstoxApiBaseUrl,
      getToken: () => this.config.primaryUpstoxToken,
    })
    this.wsSource = new UpstoxFeedV3Source({
      restApiBaseUrl: this.config.upstoxApiBaseUrl,
      getToken: () => this.config.primaryUpstoxToken,
      // undefined falls back to the source defaults (15000 ms / 5 strikes)
      optionChainRefreshMs: this.config.optionChainRefreshMs,
      atmWindowStrikes: this.config.atmWindowStrikes,
    })

    // Seed initial candle buffer
    for (const sym of ['NIFTY 50', 'BANKNIFTY', 'FINNIFTY'] as UnderlyingSymbol[]) {
      this.candleBuffer.set(sym, this.generateSeedCandles(sym))
    }
  }

  public setToken(token: string) {
    this.config.primaryUpstoxToken = token
    this.wsSource.setToken(token) // drop the WS connection so it reconnects with the new token

    // Persist the master token so window-entered / OAuth-refreshed tokens
    // survive daemon restarts (best effort — a settings write failure must
    // never break the feed swap).
    try {
      if (token) {
        this.config.settingsStore?.setSetting(DAEMON_SETTING_KEYS.upstoxMasterToken, token)
      } else {
        this.config.settingsStore?.deleteSetting(DAEMON_SETTING_KEYS.upstoxMasterToken)
      }
    } catch {
      // Ignore — settings persistence is a convenience, not the source of truth.
    }
  }

  /** Current master ingestion token (undefined when unset). */
  public getMasterToken(): string | undefined {
    return this.config.primaryUpstoxToken
  }

  /**
   * Declare which option contracts the live feed should stream at tick level
   * (open positions). Only the WebSocket transport acts on this.
   */
  public setWatchedOptionContracts(instrumentKeys: string[]): void {
    this.wsSource.setWatchedOptionContracts(instrumentKeys)
  }

  public setMockMode(enabled: boolean) {
    this.config.mockMode = enabled
  }

  public start() {
    if (this.isRunning) return
    this.isRunning = true
    this.runTick()
  }

  public stop() {
    this.isRunning = false
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.wsSource.stop()
  }

  public getSnapshot(symbol: UnderlyingSymbol): MarketSnapshot | undefined {
    return this.latestSnapshots.get(symbol)
  }

  public getAllSnapshots(): Record<UnderlyingSymbol, MarketSnapshot> {
    const result: Partial<Record<UnderlyingSymbol, MarketSnapshot>> = {}
    for (const [sym, snap] of this.latestSnapshots.entries()) {
      result[sym] = snap
    }
    return result as Record<UnderlyingSymbol, MarketSnapshot>
  }

  public getOptionChain(symbol: UnderlyingSymbol): OptionData[] {
    return this.latestOptionChains.get(symbol) || []
  }

  /** Live-feed diagnostics: active transport name + WS counters (calibration / health checks). */
  public getFeedStats(): { source: string; ws: UpstoxFeedStats } {
    return { source: this.resolveSource().name, ws: this.wsSource.getStats() }
  }

  private async runTick() {
    if (!this.isRunning) return

    try {
      await this.fetchAndComputeMarketData()
    } catch (err) {
      if (this.listenerCount('error') > 0) {
        this.emit('error', err)
      }
    } finally {
      if (this.isRunning) {
        this.timer = setTimeout(() => this.runTick(), this.config.pollingIntervalMs)
      }
    }
  }

  public async fetchAndComputeMarketData() {
    const symbols: UnderlyingSymbol[] = ['NIFTY 50', 'BANKNIFTY', 'FINNIFTY']
    const istInfo = getIndiaTime()
    const timestamp = istInfo.date.toISOString()
    let liveFetchFailures = 0

    for (const symbol of symbols) {
      // Acquire this symbol's data through the pluggable transport seam
      const source = this.resolveSource()
      const acquired = await source.acquire({
        symbol,
        timestamp,
        candles: this.candleBuffer.get(symbol) || [],
        optionChain: this.latestOptionChains.get(symbol) || [],
      })

      const spotPrice = acquired.spotPrice
      const optionChain = acquired.optionChain
      // Real-candle backfill: replaces boot-time synthetic seeds with the
      // day's actual 1-minute candles (throttled; keeps fallback on failure).
      const candles = await this.fetchLiveCandles(symbol, acquired.candles)
      this.candleBuffer.set(symbol, candles)
      this.latestOptionChains.set(symbol, optionChain)

      if (acquired.fetchFailed) {
        liveFetchFailures++
        this.lastFeedError = acquired.fetchError || 'unknown'
      }

      // Compute indicators and scoring ONCE
      const indicators = computeAllIndicators(candles, optionChain)
      const vrdData: VrdData = this.latestVrd ?? {
        mmi: { score: 45, label: 'Fear' },
        advancesDeclines: { advances: 30, declines: 20, ratio: 1.5, label: 'Healthy Breadth' },
        fiiLongShort: { longPct: 58, shortPct: 42, shortPctTrend: 'Rising' },
        fiiPositioning: { netPosition: 450, consecutiveShortDays: 0 },
        pcr: { value: indicators.pcrValue, zone: 'buy' },
        straddleIv: { elevated: false, percentAboveAvg: 0 },
        niftyPe: { pe: 21.5, label: 'Fair Value' },
        vix: 14.2,
        giftNifty: { price: spotPrice + 10, changePts: 10, changePct: 0.05, openingSignal: 'Flat' },
        supportWall: Math.floor(spotPrice / 100) * 100 - 200,
        resistanceWall: Math.floor(spotPrice / 100) * 100 + 200,
        maxPain: Math.round(spotPrice / 50) * 50,
        fetchedAt: timestamp,
      }

      const signalData: AllSignalData = {
        v3: indicators.ema === 'Buy' ? 'buy' : indicators.ema === 'Sell' ? 'sell' : 'hold',
        indicators,
        vrd: vrdData,
      }

      const finalSignal = getFinalSignal(signalData, DEFAULT_STRATEGY_CONFIG)

      const snapshot: MarketSnapshot = {
        timestamp,
        underlyingSymbol: symbol,
        spotPrice,
        candles,
        optionChain,
        vix: vrdData.vix ?? 14,
        pcr: indicators.pcrValue,
        indicators,
        vrdData,
        signal: finalSignal,
      }

      this.latestSnapshots.set(symbol, snapshot)
    }

    // Feed health monitoring (live mode only): alert after repeated wholesale failures
    if (!this.config.mockMode && this.config.primaryUpstoxToken) {
      this.trackFeedHealth(liveFetchFailures, symbols.length)
    }

    // Emit tick event to all listeners (TenantManager & WebSockets)
    this.emit('marketTick', {
      timestamp,
      snapshots: this.getAllSnapshots(),
    })
  }

  /**
   * Track live-feed health: a tick counts as failed only when every symbol's
   * quote fetch fails (e.g. expired token → HTTP 401). Alerts fire once after
   * consecutive wholesale failures and once when the feed recovers.
   */
  private trackFeedHealth(failures: number, total: number): void {
    if (failures < total) {
      this.consecutiveFailedTicks = 0
      if (this.feedDownAlerted) {
        this.feedDownAlerted = false
        this.fireAlert('🟢 Algo-Trade: market feed recovered — quotes are flowing again.')
      }
      return
    }

    this.consecutiveFailedTicks++
    if (!this.feedDownAlerted && this.consecutiveFailedTicks >= 5) {
      this.feedDownAlerted = true
      this.fireAlert(
        `🔴 Algo-Trade: market feed DOWN (last error: ${this.lastFeedError || 'unknown'}). ` +
          'The Upstox access token may have expired — refresh it and restart the daemon.',
      )
    }
  }

  private fireAlert(text: string): void {
    if (!this.config.notifier) return
    void this.config.notifier(text)
  }

  /**
   * Warm/refresh the candle buffer from Upstox's intraday 1-minute endpoint.
   *
   * Without this, the buffer runs on synthetic boot seeds (fixed base prices
   * far from live levels) until enough live minutes accumulate — the
   * seed→real transition reads as a spurious breakout, producing bogus
   * signals after every daemon restart. Throttled per symbol; on any failure
   * the previous buffer is kept.
   */
  private async fetchLiveCandles(
    symbol: UnderlyingSymbol,
    fallback: Candle[],
  ): Promise<Candle[]> {
    if (this.config.mockMode || !this.config.primaryUpstoxToken) return fallback
    const nowMs = Date.now()
    const lastFetch = this.lastCandleFetchMs.get(symbol) ?? 0
    if (nowMs - lastFetch < MasterIngestionEngine.CANDLE_REFRESH_MS) return fallback
    this.lastCandleFetchMs.set(symbol, nowMs)
    try {
      const instrumentKey = UNDERLYING_INSTRUMENT_KEYS[symbol]
      const res = await fetch(
        `${this.config.upstoxApiBaseUrl}/historical-candle/intraday/${encodeURIComponent(instrumentKey)}/1minute`,
        {
          headers: {
            Authorization: `Bearer ${this.config.primaryUpstoxToken}`,
            Accept: 'application/json',
          },
        },
      )
      if (!res.ok) return fallback
      const data = (await res.json()) as { data?: { candles?: unknown[] } }
      const rows = (data?.data?.candles ?? [])
        .filter(
          (row): row is Candle =>
            Array.isArray(row) &&
            row.length >= 6 &&
            typeof row[0] === 'string' &&
            Number.isFinite(Date.parse(row[0])) &&
            Number.isFinite(row[4]),
        )
        // Canonicalize to the same ISO form the WS feed and seeds use so the
        // per-minute in-place update in mergeOhlcIntoCandles keeps matching.
        .map((row) => [new Date(row[0]).toISOString(), row[1], row[2], row[3], row[4], row[5]] as Candle)
      if (!rows.length) return fallback
      this.lastCandlesAtMs.set(symbol, Date.now())
      return normalizeCandleOrder(rows)
    } catch {
      return fallback
    }
  }

  /** Age (ms) of the last successful live candle backfill, or null if none. */
  public getCandlesAgeMs(symbol: UnderlyingSymbol): number | null {
    const at = this.lastCandlesAtMs.get(symbol)
    return at === undefined ? null : Date.now() - at
  }

  private generateSeedCandles(symbol: UnderlyingSymbol): Candle[] {
    const basePrice = symbol === 'NIFTY 50' ? 24500 : symbol === 'BANKNIFTY' ? 51500 : 23000
    const candles: Candle[] = []
    let current = basePrice
    const now = Date.now()

    for (let i = 50; i >= 0; i--) {
      const time = new Date(now - i * 60000).toISOString()
      const delta = (Math.random() - 0.48) * 15
      const open = current
      const close = Math.round((current + delta) * 100) / 100
      const high = Math.max(open, close) + Math.random() * 5
      const low = Math.min(open, close) - Math.random() * 5
      const volume = Math.floor(Math.random() * 8000) + 2000
      candles.push([time, open, high, low, close, volume])
      current = close
    }
    return candles
  }

  /**
   * Transport selection: mock synthesis unless a live master token is present;
   * with a token, the configured live transport (REST polling or Feed V3 WS).
   */
  private resolveSource(): MarketDataSource {
    if (this.config.mockMode || !this.config.primaryUpstoxToken) return this.mockSource
    return this.config.liveSource === 'ws' ? this.wsSource : this.restSource
  }
}
