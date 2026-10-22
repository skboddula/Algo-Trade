import type {
  AllSignalData,
  Candle,
  FinalSignal,
  McMarketItem,
  OptionData,
  SignalType,
  StrategyConfig,
  UnderlyingSymbol,
  V3OrderType,
} from '../../../../packages/shared/src/types'

/** How option costs are computed. `statutory` includes the SEBI turnover fee. */
export type CostModelName = 'statutory' | 'paper-parity'

export interface CostRates {
  brokeragePerOrder: number
  /** STT on option premium, sell side only (0.1% since Oct 2024). */
  sttSellRate: number
  /** NSE exchange transaction charge on premium. */
  exchangeRate: number
  /** Stamp duty on the buy side. */
  stampBuyRate: number
  /** SEBI turnover fee (₹10 per crore). */
  sebiRate: number
  gstRate: number
}

export interface OptionCharges {
  brokerage: number
  stt: number
  stampDuty: number
  exchangeFee: number
  sebi: number
  gst: number
  statutoryTaxes: number
  total: number
  totalPaise: number
}

export interface OptionBar {
  /** ISO UTC timestamp of the bar start. */
  timestamp: string
  istDate: string
  /** Minutes after IST midnight (e.g. 09:15 = 555). */
  minute: number
  strike: number
  side: 'CE' | 'PE'
  open: number
  high: number
  low: number
  close: number
  volume: number
  oi: number
}

export interface OptionSeries {
  strike: number
  side: 'CE' | 'PE'
  bars: OptionBar[]
  byMinute: Map<number, OptionBar>
}

export interface OptionDayRaw {
  expiry: string
  series: Map<string, OptionSeries>
  strikes: number[]
}

export interface MacroBar {
  date: string
  open: number | null
  high: number | null
  low: number | null
  close: number | null
}

export interface YahooMacroSymbol {
  label: string
  bars: MacroBar[]
}

export interface YahooMacroFile {
  source: string
  fetchedAt: string
  symbols: Record<string, YahooMacroSymbol>
}

export interface MacroDay {
  date: string
  items: McMarketItem[]
  vix: number | null
  vixSource: 'daily-open' | 'previous-close' | 'missing'
  symbolsWithData: number
}

export interface ReplaySignalContext {
  timestamp: string
  date: string
  minute: number
  spot: number
  candles: Candle[]
  htfCandles: Candle[]
  chain: OptionData[]
  macro: MacroDay | null
}

export interface ReplaySignalSource {
  buildData(context: ReplaySignalContext): AllSignalData
  /**
   * Optional signal resolver for exact snapshot replay and deterministic
   * tests. Return undefined to use the production `getFinalSignal` path.
   */
  signalFor?(
    context: ReplaySignalContext,
    data: AllSignalData,
    config: StrategyConfig,
  ): FinalSignal | undefined
}

export interface ReplayDay {
  date: string
  expiry: string | null
  spotCandles: Candle[]
  previousCandles: Candle[]
  optionSeries: Map<string, OptionSeries>
  strikes: number[]
  chainAt(minute: number, spot: number): OptionData[]
}

export interface ReplayDataset {
  symbol: UnderlyingSymbol
  /** Sorted IST dates with spot data. */
  dates: string[]
  getDay(date: string): Promise<ReplayDay | null>
  nearestExpiry(date: string): string | null
}

export interface ReplayRunOptions {
  from: string
  to: string
  symbol: UnderlyingSymbol
  initialCapital: number
  lots: number
  /** Actual NIFTY lot size (75 for the 2026 contract). */
  lotSize: number
  /** Slippage applied to the next bar open, per side. */
  slippageBps: number
  costModel: CostModelName
  /** How many bars after the signal we may still enter (default 1 = next bar). */
  maxEntryDelayBars: number
  /** Peak used by the trailing stop: close (production-like) or high. */
  peakSource: 'close' | 'high'
  /** Reject a selected strike farther than this from spot (data-gap guard). */
  maxStrikeDistancePct: number
  /** Minimum spot bars for a session to be replayable. */
  minBarsPerSession: number
  strategy: StrategyConfig
}

export interface SignalCounters {
  evaluations: number
  actionable: number
  filterVetoed: number
  hardStopBlocked: number
  dailyLossBlocked: number
  capBlocked: number
  cooldownBlocked: number
  entryCutoff: number
  warmupBlocked: number
  premiumMoveBlocked: number
  noExpiry: number
  noContract: number
  noOptionBar: number
  insufficientCash: number
  entries: number
  ceSignals: number
  peSignals: number
  htfBuy: number
  htfSell: number
  htfHold: number
  v3Buy: number
  v3Sell: number
  v3Hold: number
  pcrSum: number
  pcrCount: number
}

export interface ReplayTrade {
  id: string
  date: string
  symbol: UnderlyingSymbol
  expiry: string
  strike: number
  direction: 'CE' | 'PE'
  instrumentKey: string
  lots: number
  lotSize: number
  quantity: number
  entryTime: string
  entryMinute: number
  entrySignalMinute: number
  entryRawPrice: number
  entryPrice: number
  entrySpot: number
  entrySignal: string
  entryConfidence: string
  entryBullScore: number
  entryBearScore: number
  entryV3: V3OrderType
  entryV4: SignalType
  entryHtf: SignalType | undefined
  entryPcr: number
  entryVix: number | null
  exitTime: string
  exitMinute: number
  exitRawPrice: number
  exitPrice: number
  exitSpot: number | null
  exitReason: string
  holdMinutes: number
  mfePct: number
  maePct: number
  grossPnl: number
  rawPnl: number
  slippageCost: number
  entryCharges: number
  exitCharges: number
  totalCharges: number
  netPnl: number
  netPnlPerUnit: number
  returnPct: number
  capitalAfter: number
}

export interface ReplayDayResult {
  date: string
  expiry: string | null
  spotOpen: number | null
  spotClose: number | null
  spotBars: number
  optionBars: number
  optionStrikes: number
  chainMinutes: number
  macroItems: number
  vix: number | null
  vixSource: MacroDay['vixSource'] | 'no-macro'
  signals: SignalCounters
  entries: number
  trades: number
  grossPnl: number
  totalCharges: number
  netPnl: number
  equity: number
  dailyReturnPct: number
  maxDrawdownPct: number
  notes: string[]
}

export interface ReplayMetrics {
  totalTrades: number
  wins: number
  losses: number
  flats: number
  winRatePct: number
  grossPnl: number
  netPnl: number
  totalCharges: number
  slippageCost: number
  profitFactor: number | null
  expectancy: number
  avgWin: number
  avgLoss: number
  largestWin: number
  largestLoss: number
  avgHoldMinutes: number
  avgMfePct: number
  avgMaePct: number
  returnPct: number
  maxDrawdown: number
  maxDrawdownPct: number
  sharpeDaily: number | null
  tradedSessions: number
  totalSessions: number
  positiveDays: number
  negativeDays: number
  flatDays: number
  avgTradesPerSession: number
}

export interface ReplayCoverage {
  totalSessions: number
  sessionsWithSpot: number
  sessionsWithOptionData: number
  sessionsWithMacro: number
  sessionsWithVix: number
  sessionsWithSignals: number
  optionBars: number
  chainMinutes: number
  macroSymbolDays: number
  disabledVrdLayers: string[]
  notes: string[]
}

export interface ReplayComparisonRow {
  label: string
  filter: string
  slippageBps: number
  trades: number
  winRatePct: number
  grossPnl: number
  totalCharges: number
  netPnl: number
  returnPct: number
  maxDrawdownPct: number
  avgHoldMinutes: number
}

export interface ReplayResult {
  label: string
  from: string
  to: string
  symbol: UnderlyingSymbol
  dataSource: string
  dataLicense: string
  generatedAt: string
  options: ReplayRunOptions
  metrics: ReplayMetrics
  coverage: ReplayCoverage
  signals: SignalCounters
  exitReasons: Record<string, number>
  trades: ReplayTrade[]
  days: ReplayDayResult[]
  comparisons?: ReplayComparisonRow[]
  warnings: string[]
}
