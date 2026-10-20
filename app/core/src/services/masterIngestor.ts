import { EventEmitter } from 'events'
import type {
  UnderlyingSymbol,
  MarketSnapshot,
  Candle,
  OptionData,
  VrdData,
  AllSignalData,
  IndicatorsResult,
} from '../types'
import { UNDERLYING_INSTRUMENT_KEYS } from '../types'
import { computeAllIndicators } from './indicators'
import { getFinalSignal } from './strategyEngine'
import { SentimentIngestor } from './sentimentIngestor'
import { computeV3Signal } from './v3Sentiment'
import { DEFAULT_STRATEGY_CONFIG, VIX_FRESHNESS_WINDOW_MS } from '../constants'
import { fetchWithRetry } from '../utils/http/fetchRetry'
import { getIndiaTime, getPreviousTradingSessionDate } from '../utils/timeUtils'
import { buildHtfCandleHistory } from '../../../../packages/shared/src/candleHistory'
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
   * When true (default), VRD sentiment is fetched live from Upstox (breadth,
   * FII, PCR, max pain, GIFT, news). Set false only for deterministic staging;
   * live entries are blocked while this is off. Mock mode always uses the
   * deterministic fallback.
   */
  useRealVrd?: boolean
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
  /** CR-11: entries are blocked when the candle backfill is older than this. */
  private static readonly QUOTE_MAX_AGE_MS = 30_000
  private static readonly CANDLES_MAX_AGE_MS = 120_000
  private static readonly CHAIN_MAX_AGE_MS = 60_000
  private static readonly VIX_REFRESH_MS = 60_000
  /** Retry cadence for the previous-session HTF pre-seed fetch after a failure. */
  private static readonly PREV_SESSION_RETRY_MS = 5 * 60_000
  private isRunning = false
  private timer: NodeJS.Timeout | null = null
  private candleBuffer: Map<UnderlyingSymbol, Candle[]> = new Map()
  private latestSnapshots: Map<UnderlyingSymbol, MarketSnapshot> = new Map()
  private latestOptionChains: Map<UnderlyingSymbol, OptionData[]> = new Map()
  private lastCandleFetchMs: Map<UnderlyingSymbol, number> = new Map()
  private lastCandlesAtMs: Map<UnderlyingSymbol, number> = new Map()
  /** Previous trading session's 1-minute candles per symbol (HTF pre-seed). */
  private previousSessionCandles: Map<UnderlyingSymbol, { date: string; candles: Candle[] }> = new Map()
  private previousSessionFetchMs: Map<UnderlyingSymbol, number> = new Map()
  /** REST-mode stamp: last successful per-symbol quote acquire (CR-11). */
  private lastQuoteAtMs: Map<UnderlyingSymbol, number> = new Map()
  private readonly sentimentIngestor: SentimentIngestor
  private vixValue: number | null = null
  private lastVixAtMs = 0
  private lastVixFetchMs = 0
  /** Last snapshot's VRD provenance (live fetch vs deterministic fallback). */
  private lastVrdSource: 'live' | 'fallback' = 'fallback'
  /**
   * Fail-closed sentiment fault, stamped onto every snapshot. Non-null blocks
   * LIVE entries only (paper staging continues on the fallback).
   */
  private sentimentFault: string | null = null
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
      useRealVrd: config?.useRealVrd ?? true,
    }

    this.sentimentIngestor = new SentimentIngestor({
      upstoxApiBaseUrl: this.config.upstoxApiBaseUrl,
      token: this.config.primaryUpstoxToken,
    })

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
    this.sentimentIngestor.setToken(token)

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

    // Live VRD/VIX ingestion is enabled by default. Mock mode is always
    // deterministic; useRealVrd=false is a deliberate staging escape hatch
    // that also blocks live entries (fail-closed).
    const liveVrdEnabled =
      !this.config.mockMode && !!this.config.primaryUpstoxToken && this.config.useRealVrd !== false
    if (liveVrdEnabled) {
      await this.fetchLiveVix()
    }

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
      // REST-mode CR-11 stamp: a successful acquire proves the quote just came
      // off the wire. WS mode tracks per-symbol freshness inside the feed.
      if (!acquired.fetchFailed && source === this.restSource) {
        this.lastQuoteAtMs.set(symbol, Date.now())
      }
      // Real-candle backfill: replaces boot-time synthetic seeds with the
      // day's actual 1-minute candles (throttled; keeps fallback on failure).
      const candles = await this.fetchLiveCandles(symbol, acquired.candles)
      this.candleBuffer.set(symbol, candles)
      this.latestOptionChains.set(symbol, optionChain)

      if (acquired.fetchFailed) {
        liveFetchFailures++
        this.lastFeedError = acquired.fetchError || 'unknown'
      }

      // Multi-timeframe history: previous session + today (pre-seeded so the
      // 5-minute EMA trend is warm from the open). Today's buffer and all
      // 1-minute indicators stay reference-identical.
      const htfCandles = await this.getHtfCandles(symbol, candles)

      // Compute indicators and scoring ONCE
      const indicators = computeAllIndicators(candles, optionChain, htfCandles)

      let vrdData: VrdData
      let vrdSource: 'live' | 'fallback' = 'fallback'
      if (liveVrdEnabled) {
        try {
          vrdData = await this.sentimentIngestor.buildSymbolVrd(
            symbol,
            optionChain[0]?.expiry ?? null,
            optionChain,
            indicators,
            this.vixValue,
          )
          // "live" means authoritative for live entries: the market-wide
          // fetch is fresh AND VIX is present. Otherwise the composition is
          // degraded (chain-derived/null fields) and marked fallback.
          const status = this.sentimentIngestor.getStatus()
          vrdSource = status.live && this.vixValue !== null ? 'live' : 'fallback'
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          this.sentimentFault = `sentiment assembly failed: ${message}`
          vrdData = this.buildFallbackVrd(spotPrice, indicators, timestamp)
        }
      } else {
        vrdData = this.buildFallbackVrd(spotPrice, indicators, timestamp)
      }
      this.lastVrdSource = vrdSource
      this.updateSentimentFault(liveVrdEnabled)
      if (liveVrdEnabled && vrdSource !== 'live' && this.sentimentFault === null) {
        this.sentimentFault = 'live VRD unavailable'
      }

      // V3 macro signal (reference/browser parity): global sentiment +
      // breadth advances + this symbol's chain OI ratio through the shared
      // mapping tables — never a copy of the EMA.
      const marketWide = this.sentimentIngestor.getMarketWideSnapshot()
      const globalIndices = this.sentimentIngestor.getGlobalIndices()
      let chainPutOi = 0
      let chainCallOi = 0
      for (const row of optionChain) {
        chainPutOi += row.put_options?.market_data?.oi ?? 0
        chainCallOi += row.call_options?.market_data?.oi ?? 0
      }
      const v3 = computeV3Signal(
        globalIndices,
        marketWide.breadth?.advances ?? null,
        chainPutOi,
        chainCallOi,
      )

      const signalData: AllSignalData = {
        v3,
        indicators,
        vrd: vrdData,
        globalIndices,
      }

      const finalSignal = getFinalSignal(signalData, DEFAULT_STRATEGY_CONFIG)
      // Reference scoring with the multi-timeframe veto disabled. Each user's
      // entry path applies their own `useMultiTimeframe` setting to this base
      // rather than recomputing V3/VRD per tenant.
      const unfilteredSignal = getFinalSignal(signalData, {
        ...DEFAULT_STRATEGY_CONFIG,
        useMultiTimeframe: false,
      })

      const snapshot: MarketSnapshot = {
        timestamp,
        underlyingSymbol: symbol,
        spotPrice,
        candles,
        optionChain,
        // Never invent a VIX level: a missing/stale VIX must stay visible to
        // the fail-closed gate instead of being silently replaced with 14.
        vix: vrdData.vix ?? undefined,
        pcr: indicators.pcrValue,
        indicators,
        vrdData,
        v3,
        signal: finalSignal,
        unfilteredSignal,
        globalIndices,
        sources: this.buildSourcesBlock(symbol),
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
   * Validates + canonicalizes Upstox candle rows. Timestamps are normalized
   * to the same ISO form the WS feed and seeds use so the per-minute in-place
   * update in mergeOhlcIntoCandles keeps matching.
   */
  private static parseCandleRows(rows: unknown[]): Candle[] {
    return rows
      .filter(
        (row): row is Candle =>
          Array.isArray(row) &&
          row.length >= 6 &&
          typeof row[0] === 'string' &&
          Number.isFinite(Date.parse(row[0])) &&
          Number.isFinite(row[4]),
      )
      .map((row) => [new Date(row[0]).toISOString(), row[1], row[2], row[3], row[4], row[5]] as Candle)
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
      const rows = MasterIngestionEngine.parseCandleRows(data?.data?.candles ?? [])
      if (!rows.length) return fallback
      this.lastCandlesAtMs.set(symbol, Date.now())
      return normalizeCandleOrder(rows)
    } catch {
      return fallback
    }
  }

  /**
   * Fetches one trading day's 1-minute candles (the previous session, for the
   * multi-timeframe pre-seed). Best-effort: [] on any failure, so callers fall
   * back to today-only history (reference behavior).
   */
  private async fetchPreviousSessionCandles(
    symbol: UnderlyingSymbol,
    date: string,
  ): Promise<Candle[]> {
    try {
      const instrumentKey = UNDERLYING_INSTRUMENT_KEYS[symbol]
      const res = await fetch(
        `${this.config.upstoxApiBaseUrl}/historical-candle/${encodeURIComponent(instrumentKey)}/1minute/${date}/${date}`,
        {
          headers: {
            Authorization: `Bearer ${this.config.primaryUpstoxToken}`,
            Accept: 'application/json',
          },
        },
      )
      if (!res.ok) return []
      const data = (await res.json()) as { data?: { candles?: unknown[] } }
      return normalizeCandleOrder(
        MasterIngestionEngine.parseCandleRows(data?.data?.candles ?? []),
      )
    } catch {
      return []
    }
  }

  /**
   * Multi-timeframe trend input for this cycle: the previous trading session's
   * candles prepended to today's (deduplicated, group-aligned by
   * `buildHtfCandleHistory`), so the 5-minute EMA 10/42 filter is warm from
   * the open instead of abstaining until ~12:45 IST.
   *
   * Cached once per session per symbol; failed fetches retry after
   * PREV_SESSION_RETRY_MS. Only real intraday buffers are extended — synthetic
   * boot seeds stay today-only so the filter never mixes fake history.
   */
  private async getHtfCandles(
    symbol: UnderlyingSymbol,
    todayCandles: Candle[],
  ): Promise<Candle[]> {
    if (
      this.config.mockMode ||
      !this.config.primaryUpstoxToken ||
      !todayCandles.length ||
      !this.lastCandlesAtMs.has(symbol)
    ) {
      return todayCandles
    }

    const prevDate = getPreviousTradingSessionDate()
    let entry = this.previousSessionCandles.get(symbol)
    if (!entry || entry.date !== prevDate || !entry.candles.length) {
      const nowMs = Date.now()
      const lastAttempt = this.previousSessionFetchMs.get(symbol) ?? 0
      if (nowMs - lastAttempt >= MasterIngestionEngine.PREV_SESSION_RETRY_MS) {
        this.previousSessionFetchMs.set(symbol, nowMs)
        const fetched = await this.fetchPreviousSessionCandles(symbol, prevDate)
        if (fetched.length) {
          entry = { date: prevDate, candles: fetched }
          this.previousSessionCandles.set(symbol, entry)
        }
      }
    }

    if (!entry?.candles.length) return todayCandles
    return buildHtfCandleHistory(entry.candles, todayCandles)
  }

  /**
   * Deterministic fallback VRD used in mock mode / when live ingestion fails.
   * It is deliberately shaped like a neutral-to-bull session so paper staging
   * exercises the engine, but it is NEVER trusted for live entries (see
   * updateSentimentFault).
   */
  private buildFallbackVrd(
    spotPrice: number,
    indicators: IndicatorsResult,
    timestamp: string,
  ): VrdData {
    return {
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
  }

  /**
   * Fail-closed sentiment gate. Live entries are blocked unless the latest
   * market-wide VRD fetch is live + fresh AND India VIX is present + fresh.
   * Paper staging keeps running on the deterministic fallback.
   */
  private updateSentimentFault(liveVrdEnabled: boolean): void {
    if (!liveVrdEnabled) {
      this.sentimentFault = this.config.mockMode
        ? null
        : 'live VRD disabled (useRealVrd=false)'
      return
    }
    const status = this.sentimentIngestor.getStatus()
    if (!status.live) {
      this.sentimentFault = status.lastError ?? 'live VRD stale or unavailable'
      return
    }
    if (this.vixValue === null) {
      this.sentimentFault = 'India VIX unavailable'
      return
    }
    const vixAgeMs = this.lastVixAtMs > 0 ? Date.now() - this.lastVixAtMs : null
    if (vixAgeMs === null || vixAgeMs > VIX_FRESHNESS_WINDOW_MS) {
      this.sentimentFault = 'India VIX stale'
      return
    }
    this.sentimentFault = null
  }

  /** Public fail-closed sentiment status for health endpoints/tests. */
  public getSentimentStatus(): {
    live: boolean
    fetchedAtMs: number | null
    ageMs: number | null
    lastError: string | null
    vix: number | null
    vixAgeMs: number | null
    source: 'live' | 'fallback'
    fault: string | null
  } {
    const status = this.sentimentIngestor.getStatus()
    return {
      ...status,
      vix: this.vixValue,
      vixAgeMs: this.lastVixAtMs > 0 ? Date.now() - this.lastVixAtMs : null,
      source: this.lastVrdSource,
      fault: this.sentimentFault,
    }
  }

  /** Fetches the India VIX spot quote (60s cadence) for VRD + fail-closed gates. */
  private async fetchLiveVix(): Promise<void> {
    if (this.config.mockMode || !this.config.primaryUpstoxToken) return
    const nowMs = Date.now()
    if (nowMs - this.lastVixFetchMs < MasterIngestionEngine.VIX_REFRESH_MS) return
    this.lastVixFetchMs = nowMs
    try {
      const res = await fetchWithRetry(
        `${this.config.upstoxApiBaseUrl}/market-quote/quotes?instrument_key=${encodeURIComponent('NSE_INDEX|India VIX')}`,
        {
          headers: {
            Authorization: `Bearer ${this.config.primaryUpstoxToken}`,
            Accept: 'application/json',
          },
        },
      )
      if (!res.ok) return
      const data = (await res.json()) as {
        data?: Record<string, { last_price?: number }>
      }
      const quote = data?.data?.['NSE_INDEX:India VIX'] ?? Object.values(data?.data ?? {})[0]
      if (typeof quote?.last_price === 'number') {
        this.vixValue = quote.last_price
        this.lastVixAtMs = Date.now()
      }
    } catch {
      // Keep the previous VIX on transient failure; the freshness gate blocks
      // live entries once it goes stale.
    }
  }

  /** Age (ms) of the last successful live candle backfill, or null if none. */
  public getCandlesAgeMs(symbol: UnderlyingSymbol): number | null {    const at = this.lastCandlesAtMs.get(symbol)
    return at === undefined ? null : Date.now() - at
  }

  /**
   * CR-11 entry blockers for a symbol (public accessor for callers/tests —
   * tenants read the same reasons from snapshot.sources). No-op in mock mode /
   * without a token (mock fallback semantics never gate entries).
   */
  public getEntryBlockers(symbol: UnderlyingSymbol): string[] {
    return this.buildSourcesBlock(symbol).entryBlockedReasons
  }

  /**
   * CR-11 data-freshness block stamped on every snapshot (always-on-daemon
   * parity). Ages are measured against the data a new entry would rely on:
   *   - quote:   last index tick for the symbol (WS) / last successful REST
   *              quote acquire;
   *   - candles: last successful 1-minute real-candle backfill;
   *   - chain:   last successful option-chain refresh (WS only — the REST
   *              transport passes chains through untouched, so the arm is not
   *              enforceable there).
   * The VIX arm is intentionally omitted until live VRD/VIX ingestion is
   * wired: the vrdData fallback re-stamps `fetchedAt` every tick and cannot
   * prove freshness.
   */
  private buildSourcesBlock(symbol: UnderlyingSymbol): NonNullable<MarketSnapshot['sources']> {
    const now = Date.now()
    const vrdStatus = this.sentimentIngestor.getStatus()
    const vixAgeMs = this.lastVixAtMs > 0 ? now - this.lastVixAtMs : null
    if (this.config.mockMode || !this.config.primaryUpstoxToken) {
      return {
        quoteAgeMs: null,
        candlesAgeMs: null,
        chainAgeMs: null,
        vixAgeMs: null,
        vrdAgeMs: null,
        vrdSource: this.lastVrdSource,
        sentimentFault: null,
        entryBlockedReasons: [],
      }
    }

    const usingWs = this.config.liveSource === 'ws'
    const quoteAt = usingWs ? undefined : this.lastQuoteAtMs.get(symbol)
    const quoteAgeMs = usingWs
      ? this.wsSource.getLastIndexTickAgeMs(symbol)
      : quoteAt === undefined
        ? null
        : now - quoteAt
    const chainAgeMs = usingWs ? this.wsSource.getLastChainSuccessAgeMs(symbol) : null
    const candlesAgeMs = this.getCandlesAgeMs(symbol)

    const entryBlockedReasons: string[] = []
    if (quoteAgeMs === null || quoteAgeMs > MasterIngestionEngine.QUOTE_MAX_AGE_MS) {
      entryBlockedReasons.push('underlying quote stale or missing')
    }
    if (candlesAgeMs === null || candlesAgeMs > MasterIngestionEngine.CANDLES_MAX_AGE_MS) {
      entryBlockedReasons.push('candles/indicators stale or missing')
    }
    if (usingWs && (chainAgeMs === null || chainAgeMs > MasterIngestionEngine.CHAIN_MAX_AGE_MS)) {
      entryBlockedReasons.push('option chain stale or missing')
    }

    return {
      quoteAgeMs,
      candlesAgeMs,
      chainAgeMs,
      vixAgeMs,
      vrdAgeMs: vrdStatus.ageMs,
      vrdSource: this.lastVrdSource,
      sentimentFault: this.sentimentFault,
      entryBlockedReasons,
    }
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
