export const ALGO_TRADE_PREFIX = 'algo-trade'

export const STORAGE_KEY_STRATEGY_CONFIG = 'algo-trade:strategy-config'
export const STORAGE_KEY_BROKER_ACCOUNTS = 'algo-trade:broker-accounts'
export const STORAGE_KEY_NOTIFICATIONS = 'algo-trade:notifications'
export const STORAGE_KEY_TICK_LOG = 'algo-trade:tick-log'
export const STORAGE_KEY_ACTIVE_USER = 'algo-trade:active-user'
export const STORAGE_KEY_LIVE_TRADES_PAGE_MODE =
  'algo-trade:livetradespage-mode'
export const STORAGE_KEY_BOT_STATE = 'algo-trade:bot-state'
export const STORAGE_KEY_BOT_POSITION = 'algo-trade:bot-position'
export const STORAGE_KEY_BOT_POSITIONS = 'algo-trade:bot-positions'
export const STORAGE_KEY_BOT_TRADES_TODAY = 'algo-trade:bot-trades-today'
export const STORAGE_KEY_BOT_TRADES_PER_SYMBOL =
  'algo-trade:bot-trades-per-symbol'
export const STORAGE_KEY_BOT_TRADES_DATE = 'algo-trade:bot-trades-date'
export const STORAGE_KEY_VRD_CACHE = 'algo-trade:vrd-cache'
export const STORAGE_KEY_BOT_LOGS = 'algo-trade:bot-logs'
export const STORAGE_KEY_BOT_SNAPSHOT = 'algo-trade:bot-snapshot'
export const STORAGE_KEY_BOT_EXIT_TIMES = 'algo-trade:bot-last-exit-times'
export const STORAGE_KEY_PROXY_HISTORY = 'algo-trade:proxy-history'

export const REMOTE_STATE_KEY_STRATEGY_CONFIG = 'strategyConfig'
export const REMOTE_STATE_KEY_BROKER_ACCOUNTS = 'brokerAccounts'

export const API_PAPER_ACCOUNT = '/api/paper/account'
export const API_PAPER_HISTORY = '/api/paper/history'
export const API_PAPER_ACCOUNT_ADJUST = '/api/paper/account/adjust'
export const API_PAPER_RESET = '/api/paper/reset'
export const API_PAPER_TRADES_ENTER = '/api/paper/trades/enter'
export const API_PAPER_TRADES_EXIT = '/api/paper/trades/exit'
export const API_CLIENT_STATE = '/api/client-state'
export const API_UPSTOX_PROFILE = '/api/broker/upstox/profile'
export const API_UPSTOX_FUNDS = '/api/broker/upstox/funds'
export const API_UPSTOX_TOKEN = '/api/broker/upstox/token'
export const API_ORDER_LIST = '/api/order/list'
export const API_ORDER_PLACE = '/api/order/place'
export const API_MARKET_VIX = '/api/market/vix'
export const API_MARKET_FII = '/api/market/upstox/fii'
export const API_MARKET_DII = '/api/market/upstox/dii'
export const API_MARKET_NEWS = '/api/market/upstox/news'
export const API_MARKET_PCR = '/api/market/upstox/pcr'
export const API_MARKET_MAX_PAIN = '/api/market/upstox/max-pain'
export const API_MARKET_CANDLES_INTRADAY = '/api/market/candles/intraday'
export const API_MARKET_BREADTH = '/api/market/breadth'
export const API_MARKET_OPTION_CONTRACTS = '/api/market/option-contracts'
export const API_MARKET_CANDLES_HISTORICAL = '/api/market/candles/historical'
export const API_MARKET_GLOBAL_INDICES = '/api/market/upstox/global-indices'
export const API_MARKET_OPTION_CHAIN = '/api/market/option-chain'
export const API_MARKET_QUOTES = '/api/market/quotes'
export const API_MARKET_FEED_AUTHORIZE = '/api/market/feed-authorize'
export const API_MARKET_INDICES = '/api/market/indices'
export const API_NOTIFY_TELEGRAM = '/api/notify/telegram'

// ─── India VIX Streaming ─────────────────────────────────────────────────────

/** Upstox instrument key for streaming India VIX on Market Data Feed V3. */
export const INDIA_VIX_INSTRUMENT_KEY = 'NSE_INDEX|India VIX'

/** VIX thresholds for early-warning alerts (hard stop bounds are 10 and 25). */
export const VIX_ELEVATED_THRESHOLD = 18
export const VIX_CRITICAL_THRESHOLD = 24

/**
 * Streamed VIX older than this window is ignored in favor of the REST-polled
 * value. Prevents trading on stale volatility data after a stream disconnect.
 */
export const VIX_FRESHNESS_WINDOW_MS = 120_000 // 2 minutes

/**
 * Minimum time between critical VIX Telegram alerts so boundary oscillation
 * (VIX bouncing around the 24 threshold) doesn't spam the user's phone.
 */
export const VIX_CRITICAL_ALERT_COOLDOWN_MS = 5 * 60_000 // 5 minutes

export const MCP_UPSTOX_URL = 'https://mcp.upstox.com/mcp'
export const UPSTOX_MCP_DOCS_URL =
  'https://upstox.com/developer/api-documentation/mcp-integration'
export const UPSTOX_AUTH_URL =
  'https://api.upstox.com/v2/login/authorization/dialog'
export const UPSTOX_DEVELOPER_APPS_URL =
  'https://account.upstox.com/developer/apps#analytics'
export const UPSTOX_DEVELOPER_APPS_BASE_URL =
  'https://account.upstox.com/developer/apps'

// Re-export core domain signals, order types, and trading constants from shared
export * from '../../../../packages/shared/src/constants'

export const MAX_LOGS = 200
export const VRD_CACHE_MAX_MS = 30 * 60 * 1000
export const COOLDOWN_MS = 60 * 1000
export const MAX_TICKS = 500
