import type { Candle, OptionData, UnderlyingSymbol } from '../types'

/**
 * Single-symbol acquisition request handed to a market data source.
 */
export interface SymbolDataRequest {
  symbol: UnderlyingSymbol
  /** Tick timestamp (shared across all symbols within one tick). */
  timestamp: string
  /** Current candle series for the symbol (most recent last). */
  candles: Candle[]
  /** Current option chain for the symbol (may be empty). */
  optionChain: OptionData[]
}

/**
 * Result of one acquisition for one symbol.
 */
export interface SymbolMarketData {
  /** Latest spot price to build the snapshot with. */
  spotPrice: number
  /** Candle series after this acquisition (sources may append live candles). */
  candles: Candle[]
  /** Option chain after this acquisition (sources may synthesize or refresh it). */
  optionChain: OptionData[]
  /** Set when a *live* acquisition failed this tick (feeds the feed-health watchdog). */
  fetchFailed?: boolean
  /** Human-readable reason for the failure, surfaced in feed-down alerts. */
  fetchError?: string
}

/**
 * Pluggable market-data acquisition seam.
 *
 * Implementations own *transport* only: mock synthesis for development,
 * Upstox REST quote polling today, and — behind the same interface — the
 * Upstox Market Data Feed V3 (WebSocket) adapter next.
 *
 * Indicator computation, signal scoring, snapshot assembly and fan-out stay in
 * MasterIngestionEngine, so downstream consumers (TenantManager, WS broadcast,
 * REST status, persistence, alerts) are unaffected by the feed transport.
 */
export interface MarketDataSource {
  readonly name: string
  /** Acquire the latest data for one symbol. Called once per symbol per tick. */
  acquire(req: SymbolDataRequest): Promise<SymbolMarketData>
}
