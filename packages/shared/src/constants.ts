export const SIGNAL_BUY_CE = 'BUY_CE' as const
export const SIGNAL_BUY_PE = 'BUY_PE' as const
export const SIGNAL_WAIT = 'WAIT' as const
export const SIGNAL_NO_TRADE = 'NO_TRADE' as const
export const TRADE_TYPE_SELLING = 'selling' as const
export const TRADE_TYPE_BUYING = 'buying' as const
export const TRADE_TYPE_BOTH = 'both' as const
export const SIGNAL_BUY = 'Buy' as const
export const SIGNAL_SELL = 'Sell' as const
export const SIGNAL_HOLD = 'Hold' as const
export const ORDER_TYPE_BUY = 'buy' as const
export const ORDER_TYPE_SELL = 'sell' as const
export const ORDER_TYPE_HOLD = 'hold' as const
export const CONFIDENCE_STRONG = 'strong' as const
export const CONFIDENCE_MODERATE = 'moderate' as const
export const CONFIDENCE_WEAK = 'weak' as const
export const CONFIDENCE_NONE = 'none' as const
export const POSITION_SIZE_FULL = 'full' as const
export const POSITION_SIZE_HALF = 'half' as const
export const POSITION_SIZE_NONE = 'none' as const
export const TRADE_STATUS_WIN = 'WIN' as const
export const TRADE_STATUS_LOSS = 'LOSS' as const
export const TRADE_STATUS_ACTIVE = 'ACTIVE' as const
export const TRADE_STATUS_CLOSED = 'CLOSED' as const
export const TRADE_STATUS_SL_HIT = 'SL_HIT' as const
export const TRADE_STATUS_TARGET_HIT = 'TARGET_HIT' as const
export const TRADE_STATUS_COMPLETED = 'COMPLETED' as const
export const TRADE_STATUS_CANCELLED = 'CANCELLED' as const
export const TRADE_STATUS_REJECTED = 'REJECTED' as const
export const LEG_DIRECTION_CE = 'CE' as const
export const LEG_DIRECTION_PE = 'PE' as const
export const MARKET_DATA_NSE_FO_INDEX_FUTURES = 'NSE_FO|INDEX_FUTURES' as const
export const MARKET_DATA_NSE_EQ_CASH = 'NSE_EQ|CASH' as const
export const MOMENTUM_OVERBOUGHT = 'Overbought' as const
export const MOMENTUM_OVERSOLD = 'Oversold' as const

export const DEFAULT_INITIAL_PAPER_BALANCE = 10000000 // 1,00,000 INR in paise

export const DEFAULT_STRATEGY_CONFIG = {
  underlyingMode: 'ALL_PARALLEL' as const,
  multiSymbolExecutionMode: 'independent' as const,
  strongThreshold: 14,
  moderateThreshold: 10,
  strongGap: 6,
  moderateGap: 3,
  maxProfitPct: 20,
  maxLossPct: 15,
  /** Trailing stop percentage from peak favorable premium (default 5). */
  trailPct: 5,
  maxTradesPerDay: 5,
  lastEntryTime: '15:15',
  squareOffTime: '15:35',
  /** 5-min EMA 10/42 confluence gate (default: enabled). */
  useMultiTimeframe: true,
  pollingIntervalSec: 2,
  minConfidence: 'moderate' as const,
  otmSkip: 0,
  executionMode: 'paper' as const,
  tradeType: 'buying' as const,
  brentCrudeExtremeThreshold: 90,
  brentCrudeOverhangThreshold: 85,
  exitCooldownSec: 60,
}

// ─── VIX thresholds (alerting) ────────────────────────────────────────────
// Ported from the always-on-daemon branch — keep the values in sync there.
export const VIX_ELEVATED_THRESHOLD = 18
export const VIX_CRITICAL_THRESHOLD = 24

/**
 * Streamed/REST VIX older than this window is not trusted for entries.
 * Prevents trading on stale volatility data after a feed disconnect.
 */
export const VIX_FRESHNESS_WINDOW_MS = 120_000 // 2 minutes

/** Hard-stop tradeability band (see scoreVix in the shared engine). */
export const VIX_HARD_STOP_MAX = 25
export const VIX_HARD_STOP_MIN = 10
export const VIX_CRITICAL_ALERT_COOLDOWN_MS = 5 * 60_000 // 5 minutes
