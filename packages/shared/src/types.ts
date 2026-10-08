// Shared Quantitative & Trading Domain Types

export type SignalType = 'Buy' | 'Sell' | 'Hold'
export type MomentumType = 'Overbought' | 'Oversold' | 'Hold'
export type TrendType = 'Up' | 'Down' | 'Neutral'
export type VolatilityLevel = 'High' | 'Low' | 'Neutral'
export type GlobalSentiment = 'bullish' | 'bearish' | 'neutral'
export type NiftySentiment =
  | 'very bullish'
  | 'bullish'
  | 'neutral'
  | 'bearish'
  | 'very bearish'
export type PcrZone = 'buy' | 'sell' | 'neutral' | 'overbought' | 'oversold'
export type V3OrderType = 'buy' | 'sell' | 'hold'
export type ExecutionMode = 'live' | 'paper'
export type BrokerPurpose = 'analytics' | 'market-data' | 'orders'
export type NotificationType = 'info' | 'success' | 'warn' | 'error'

export type UnderlyingSymbol = 'NIFTY 50' | 'BANKNIFTY' | 'FINNIFTY'
export type UnderlyingMode = UnderlyingSymbol | 'ALL_PARALLEL'

export const UNDERLYING_INSTRUMENT_KEYS: Record<UnderlyingSymbol, string> = {
  'NIFTY 50': 'NSE_INDEX|Nifty 50',
  BANKNIFTY: 'NSE_INDEX|Nifty Bank',
  FINNIFTY: 'NSE_INDEX|Nifty Fin Service',
}

// Candle format: [timestamp, open, high, low, close, volume, oi?]
export type Candle = [
  string,
  number,
  number,
  number,
  number,
  number,
  (number | undefined)?,
]

export interface OptionGreeks {
  iv: number
  delta: number
  theta: number
  vega: number
  gamma: number
}

export interface OptionData {
  expiry: string
  strike_price: number
  underlying_spot_price: number
  call_options: {
    instrument_key: string
    trading_symbol?: string
    market_data: { ltp: number; volume: number; oi: number }
    option_greeks?: OptionGreeks
  }
  put_options: {
    instrument_key: string
    trading_symbol?: string
    market_data: { ltp: number; volume: number; oi: number }
    option_greeks?: OptionGreeks
  }
}

export interface OptionContract {
  instrument_key: string
  trading_symbol: string
  expiry: string
  lot_size: number
  minimum_lot?: number
  weekly?: boolean
}

export interface IndicatorsResult {
  ema: SignalType
  adx: SignalType
  rsi: { value: number; signal: MomentumType }
  stochastic: { k: number; d: number; signal: SignalType }
  bollinger: {
    upper: number
    middle: number
    lower: number
    signal: SignalType
    trend: TrendType
  }
  atr: { value: number; level: VolatilityLevel }
  pcr: SignalType
  pcrValue: number
  /**
   * Higher-timeframe (5-min resampled) EMA 10/42 trend direction.
   * Used as a multi-timeframe confluence filter: BUY_CE signals are blocked
   * when the 5-min trend is bearish, and BUY_PE signals are blocked when it
   * is bullish. 'Hold' (neutral) or undefined does not block either direction.
   */
  higherTimeframeTrend?: SignalType
}

export interface NewsAlert {
  id: string
  headline: string
  summary: string
  type: 'MACRO' | 'EARNINGS' | 'GENERAL'
  severity: 'HIGH' | 'MEDIUM' | 'LOW'
  timestamp: number
  matchedKeywords: string[]
}

export interface UpstoxNewsItem {
  headline: string
  summary: string
  thumbnail_url?: string
  article_link?: string
  published_timestamp: number
}

export interface VrdData {
  mmi: { score: number | null; label: string | null } | null
  advancesDeclines: {
    advances: number | null
    declines: number | null
    ratio: number | null
    label: string | null
  } | null
  fiiLongShort: {
    longPct: number | null
    shortPct: number | null
    shortPctTrend: 'Rising' | 'Falling' | 'Stable' | null
  } | null
  fiiPositioning: {
    netPosition: number | null
    consecutiveShortDays: number | null
  } | null
  pcr: { value: number | null; zone: string | null } | null
  straddleIv: {
    elevated: boolean | null
    percentAboveAvg: number | null
  } | null
  niftyPe: { pe: number | null; label: string | null } | null
  vix: number | null
  giftNifty: {
    price: number | null
    changePts: number | null
    changePct: number | null
    openingSignal: 'Gap Up' | 'Gap Down' | 'Flat' | null
  } | null
  supportWall: number | null
  resistanceWall: number | null
  maxPain: number | null
  newsAlerts?: NewsAlert[]
  fetchedAt: string
}

export interface VrdScore {
  score: number
  max: number
  label: string
  detail?: string
}

export interface McMarketItem {
  symbol: string
  technical_rating?: string
  change_per?: number
  [key: string]: unknown
}

export interface ScoreBreakdown {
  layer: string
  indicator: string
  condition: string
  points: number
  max: number
}

export interface ScoreResult {
  score: number
  max: number
  breakdown: ScoreBreakdown[]
}

export interface FinalSignal {
  signal: 'BUY_CE' | 'BUY_PE' | 'WAIT' | 'NO_TRADE'
  confidence: 'strong' | 'moderate' | 'weak' | 'none'
  positionSize: 'full' | 'half' | 'none'
  v3: V3OrderType
  v4: SignalType
  bullScore: number
  bearScore: number
  scoreMax: number
}

export interface AllSignalData {
  v3: V3OrderType
  indicators: IndicatorsResult
  vrd: VrdData | null
  globalIndices?: McMarketItem[]
}

export interface PositionLeg {
  instrumentKey: string
  direction: 'CE' | 'PE'
  entryPrice: number
  quantity: number
  lotSize?: number
  tradeType: 'buying' | 'selling'
  paperTradeId?: string
  currentPrice?: number
  unrealizedPnl?: number
  status?: 'OPEN' | 'CLOSED'
}

export interface ActivePosition {
  instrumentKey: string
  direction: 'CE' | 'PE'
  entryPrice: number
  quantity: number
  lotSize?: number
  entryTime: string
  tradeId: number
  executionMode?: ExecutionMode
  paperTradeId?: string
  tradeType?: 'buying' | 'selling' | 'both'
  currentPrice?: number
  unrealizedPnl?: number
  peakFavorablePrice?: number
  legs?: PositionLeg[]
  exitedLegs?: string[]
  underlyingSymbol?: UnderlyingSymbol
}

export interface StrategyConfig {
  underlyingMode: UnderlyingMode
  multiSymbolExecutionMode?: 'independent' | 'consensus' | 'best_signal'
  strongThreshold: number
  moderateThreshold: number
  strongGap: number
  moderateGap: number
  maxProfitPct: number
  maxLossPct: number
  /** Trailing stop percentage from peak favorable price (default 5). */
  trailPct?: number
  maxTradesPerDay: number
  lastEntryTime: string
  pollingIntervalSec: number
  minConfidence: 'strong' | 'moderate'
  otmSkip: number
  executionMode: ExecutionMode
  tradeType: 'buying' | 'selling' | 'both'
  brentCrudeExtremeThreshold: number
  brentCrudeOverhangThreshold: number
  exitCooldownSec?: number
  /**
   * When true (default), open-position exit checks and displayed PnL prefer
   * tick-level prices from the Upstox Market Data Feed V3 WebSocket when a
   * live stream is available, falling back to REST option-chain prices.
   */
  useMarketStream?: boolean
  /**
   * When true (default), BUY_CE signals are blocked when the 5-min
   * resampled EMA 10/42 trend is bearish, and BUY_PE signals are blocked
   * when it is bullish. Filters out counter-trend entries from 1-min noise.
   */
  useMultiTimeframe?: boolean
}

export interface PaperAccount {
  id: string
  mode?: string
  userId?: string
  balance: number
  currency: string
  updatedAt?: string
  updated_at?: string
}

export interface PaperStatementEntry {
  id: string
  entry_type: string
  amount: number
  balance_before: number
  balance_after: number
  note: string | null
  metadata_json: string | null
  created_at: string
}

export interface PaperTrade {
  id: string
  account_id: string
  status: string
  instrument_key: string
  direction: string
  quantity: number
  entry_price: number
  entry_value: number
  exit_price: number | null
  exit_value: number | null
  realized_pnl: number | null
  opened_at: string
  closed_at: string | null
  metadata_json: string | null
}

export interface PaperTradeRecord {
  id: string
  accountId: string
  status: 'OPEN' | 'CLOSED' | 'CANCELLED'
  instrumentKey: string
  direction: 'CE' | 'PE'
  quantity: number
  entryPrice: number
  entryValue: number
  exitPrice?: number
  exitValue?: number
  realizedPnl?: number
  openedAt: string
  closedAt?: string
  metadata?: Record<string, unknown>
}

export interface PaperAccountSummary {
  account: PaperAccount
  recentEntries: PaperStatementEntry[]
  openTradeCount: number
  trades?: PaperTrade[]
  openTrades?: PaperTrade[]
}

export interface BrokerAccount {
  id: string
  label: string
  broker: 'upstox'
  apiKey?: string
  accessToken?: string
  analyticsToken?: string
  purpose: BrokerPurpose[]
  status: 'connected' | 'disconnected'
  connectedAt?: string
}

export interface AppNotification {
  id: string
  title: string
  message: string
  type: NotificationType
  timestamp: string
  read: boolean
}

export type TradeRowStatus =
  | 'ACTIVE'
  | 'CLOSED'
  | 'SL_HIT'
  | 'TARGET_HIT'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'REJECTED'

export const DEFAULT_CONFIG: StrategyConfig = {
  underlyingMode: 'ALL_PARALLEL',
  multiSymbolExecutionMode: 'independent',
  strongThreshold: 14,
  moderateThreshold: 10,
  strongGap: 6,
  moderateGap: 3,
  maxProfitPct: 10,
  maxLossPct: 5,
  trailPct: 5,
  maxTradesPerDay: 3,
  lastEntryTime: '14:30',
  pollingIntervalSec: 60,
  minConfidence: 'moderate',
  otmSkip: 3,
  executionMode: 'paper',
  tradeType: 'buying',
  brentCrudeExtremeThreshold: 125,
  brentCrudeOverhangThreshold: 88,
  useMarketStream: true,
  useMultiTimeframe: true,
}

export const ACCOUNTS_CHANGED_EVENT = 'algo-trade:accounts-changed'
export const SKIP_SYMBOLS: string[] = []

export const globalNiftyMapping = [
  { globalSentiment: 'bearish', marketSentiment: 'very bearish', canTrade: 1 },
  { globalSentiment: 'bearish', marketSentiment: 'bearish', canTrade: 1 },
  { globalSentiment: 'bearish', marketSentiment: 'neutral', canTrade: 1 },
  { globalSentiment: 'bearish', marketSentiment: 'bullish', canTrade: 0 },
  { globalSentiment: 'bearish', marketSentiment: 'very bullish', canTrade: 0 },
  { globalSentiment: 'neutral', marketSentiment: 'very bearish', canTrade: 1 },
  { globalSentiment: 'neutral', marketSentiment: 'bearish', canTrade: 1 },
  { globalSentiment: 'neutral', marketSentiment: 'neutral', canTrade: 1 },
  { globalSentiment: 'neutral', marketSentiment: 'bullish', canTrade: 1 },
  { globalSentiment: 'neutral', marketSentiment: 'very bullish', canTrade: 1 },
  { globalSentiment: 'bullish', marketSentiment: 'very bearish', canTrade: 0 },
  { globalSentiment: 'bullish', marketSentiment: 'bearish', canTrade: 0 },
  { globalSentiment: 'bullish', marketSentiment: 'neutral', canTrade: 1 },
  { globalSentiment: 'bullish', marketSentiment: 'bullish', canTrade: 1 },
  { globalSentiment: 'bullish', marketSentiment: 'very bullish', canTrade: 1 },
]

export const marketStrategyMapping: {
  marketSentiment: string
  putCallRatio: string
  orderType: string | null
}[] = [
  { marketSentiment: 'very bearish', putCallRatio: 'oversold', orderType: 'buy' },
  { marketSentiment: 'bearish', putCallRatio: 'oversold', orderType: 'buy' },
  { marketSentiment: 'neutral', putCallRatio: 'oversold', orderType: 'buy' },
  { marketSentiment: 'bullish', putCallRatio: 'oversold', orderType: 'buy' },
  { marketSentiment: 'very bullish', putCallRatio: 'oversold', orderType: 'buy' },
  { marketSentiment: 'very bearish', putCallRatio: 'sell', orderType: 'sell' },
  { marketSentiment: 'bearish', putCallRatio: 'sell', orderType: 'sell' },
  { marketSentiment: 'neutral', putCallRatio: 'sell', orderType: 'sell' },
  { marketSentiment: 'bullish', putCallRatio: 'sell', orderType: null },
  { marketSentiment: 'very bullish', putCallRatio: 'sell', orderType: null },
  { marketSentiment: 'very bearish', putCallRatio: 'neutral', orderType: 'sell' },
  { marketSentiment: 'bearish', putCallRatio: 'neutral', orderType: 'sell' },
  { marketSentiment: 'neutral', putCallRatio: 'neutral', orderType: 'hold' },
  { marketSentiment: 'bullish', putCallRatio: 'neutral', orderType: 'buy' },
  { marketSentiment: 'very bullish', putCallRatio: 'neutral', orderType: 'buy' },
  { marketSentiment: 'very bearish', putCallRatio: 'buy', orderType: 'buy' },
  { marketSentiment: 'bearish', putCallRatio: 'buy', orderType: 'buy' },
  { marketSentiment: 'neutral', putCallRatio: 'buy', orderType: 'buy' },
  { marketSentiment: 'bullish', putCallRatio: 'buy', orderType: 'buy' },
  { marketSentiment: 'very bullish', putCallRatio: 'buy', orderType: 'buy' },
  { marketSentiment: 'very bearish', putCallRatio: 'overbought', orderType: 'sell' },
  { marketSentiment: 'bearish', putCallRatio: 'overbought', orderType: 'sell' },
  { marketSentiment: 'neutral', putCallRatio: 'overbought', orderType: 'sell' },
  { marketSentiment: 'bullish', putCallRatio: 'overbought', orderType: 'sell' },
  { marketSentiment: 'very bullish', putCallRatio: 'overbought', orderType: 'sell' },
]

export interface MarketSnapshot {
  timestamp: string
  underlyingSymbol: UnderlyingSymbol
  spotPrice: number
  candles: Candle[]
  optionChain?: OptionData[]
  vix?: number
  pcr?: number
  indicators?: IndicatorsResult
  vrdData?: VrdData
  signal?: FinalSignal
}

export interface UserBotState {
  userId: string
  state: 'IDLE' | 'RUNNING' | 'ORDERED' | 'STOPPED'
  executionMode: ExecutionMode
  config: StrategyConfig
  upstoxToken?: string
  positions: Record<UnderlyingSymbol, ActivePosition | null>
  tradesCountToday: number
  tradesCountPerSymbol: Partial<Record<UnderlyingSymbol, number>>
  lastTradeDate: string
  lastExitTimes: Record<string, number>
  totalRealizedPnl: number
  paperBalance: number
  error?: string
  updatedAt: string
}
