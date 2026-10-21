// Daemon (app/core) transport for the window UI served at the daemon's own
// origin (http://127.0.0.1:3000). This module is only active in bundles built
// with `yarn build:daemon` (vite mode "daemon").
import type {
  MarketSnapshot,
  PaperTradeRecord,
  StrategyConfig,
  UnderlyingSymbol,
  UserBotState,
} from './types'

/** True when this bundle was built to be served by the daemon (`build:daemon`). */
export const DAEMON_MODE = import.meta.env.MODE === 'daemon'

/** Bot user the daemon's CLI (scripts/bot.sh) also defaults to. */
export const DAEMON_USER_ID = 'default_user'

export const DAEMON_SYMBOLS: UnderlyingSymbol[] = [
  'NIFTY 50',
  'BANKNIFTY',
  'FINNIFTY',
]

/** Mirrors UpstoxFeedStats from the daemon (app/core). */
export interface DaemonWsFeedStats {
  state: 'idle' | 'connecting' | 'open' | 'closed'
  activeForMs: number
  frames: {
    initial: number
    live: number
    marketInfo: number
    other: number
    decodeErrors: number
  }
  ticks: { index: number; option: number }
  optionKeys: { current: number; peak: number }
  reconnects: number
  chain: {
    calls: number
    failures: number
    lastLatencyMs: number | null
    lastError?: string
  }
  expiry: { calls: number; failures: number }
  lastMessageAgeMs: number | null
}

export interface DaemonFeedStats {
  /** Active transport name, e.g. 'upstox-ws-v3' or 'upstox-rest'. */
  source: string
  ws: DaemonWsFeedStats
}

export interface DaemonHealth {
  status: string
  timestamp: string
  memoryUsage?: { rss?: number; heapUsed?: number }
  feed: DaemonFeedStats
}

export interface DaemonStatus {
  serverTime: string
  snapshots: Partial<Record<UnderlyingSymbol, MarketSnapshot>>
  userState: UserBotState
  paperTrades: PaperTradeRecord[]
  /** Whether the daemon holds a working master token (boolean only). */
  hasToken?: boolean
  /** Whether this user has a per-user order-token override (boolean only). */
  hasOrderTokenOverride?: boolean
}

/** Masked view of the daemon's Upstox account settings (secrets never returned). */
export interface DaemonUpstoxSettings {
  hasApiKey: boolean
  /** Masked prefix of the saved API key (client id), or null when unset. */
  apiKeyHint: string | null
  hasApiSecret: boolean
  redirectUri: string | null
  hasMasterToken: boolean
}

/** Masked view of the daemon's Telegram alert settings (secrets never returned). */
export interface DaemonTelegramSettings {
  hasBotToken: boolean
  /** Masked prefix of the saved bot token, or null when unset. */
  botTokenHint: string | null
  hasChatId: boolean
  /** Masked suffix of the chat id (e.g. •••••6003), or null when unset. */
  chatIdHint: string | null
}

export interface DaemonSettings {
  upstox: DaemonUpstoxSettings
  telegram: DaemonTelegramSettings
}

async function parseJson<T>(res: Response): Promise<T> {
  let data: T | { error?: string } | null = null
  try {
    data = await res.json()
  } catch {
    // Non-JSON body — fall through to status-based errors.
  }
  if (!res.ok) {
    const err =
      data && typeof data === 'object' && 'error' in data
        ? data.error
        : `daemon HTTP ${res.status}`
    throw new Error(err ?? `daemon HTTP ${res.status}`)
  }
  if (data === null) {
    throw new Error('daemon returned a non-JSON response')
  }
  return data as T
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  })
  return parseJson<T>(res)
}

function post<T>(path: string, payload: unknown): Promise<T> {
  return request<T>(path, { method: 'POST', body: JSON.stringify(payload) })
}

/** One daemon activity entry streamed over /ws (type "LOG") or fetched from
 * the /api/bot/logs backlog. `seq` dedupes backlog + live frames. */
export interface DaemonActivityEntry {
  seq: number
  ts: string
  level: 'info' | 'warn' | 'error' | 'debug'
  source: string
  msg: string
}

/** Same-origin calls into the daemon's bot API. */
export const daemonApi = {
  status: (): Promise<DaemonStatus> =>
    request<DaemonStatus>(`/api/bot/status?userId=${DAEMON_USER_ID}`),

  health: (): Promise<DaemonHealth> => request<DaemonHealth>('/health'),

  /** Daemon activity backlog — Bot Logs backfill before live LOG frames. */
  logs: (
    limit = 200,
  ): Promise<{ entries: DaemonActivityEntry[]; debugEnabled: boolean }> =>
    request(`/api/bot/logs?limit=${limit}`),

  start: (executionMode: 'paper' | 'live'): Promise<unknown> =>
    post('/api/bot/start', { userId: DAEMON_USER_ID, executionMode }),

  stop: (): Promise<unknown> =>
    post('/api/bot/stop', { userId: DAEMON_USER_ID }),

  /**
   * Per-user live-order token (overrides the daemon's master token).
   * `alsoMaster` additionally refreshes the token driving ALL market data.
   */
  setToken: (token: string, alsoMaster = false): Promise<unknown> =>
    post('/api/bot/token', { userId: DAEMON_USER_ID, token, alsoMaster }),

  /** Drop the per-user order-token override (falls back to the master token). */
  clearToken: (): Promise<unknown> =>
    post('/api/bot/token', { userId: DAEMON_USER_ID, clear: true }),

  /**
   * Window-managed daemon settings (Upstox OAuth credentials + master token
   * presence). Secrets come back masked — the full values stay server-side.
   */
  settings: (): Promise<DaemonSettings> =>
    request<DaemonSettings>('/api/daemon/settings'),

  /**
   * Save Upstox API credentials into the daemon's SQLite (used by the daily
   * "Refresh token via Upstox login" flow). Omitted fields keep their value.
   */
  saveUpstoxSettings: (payload: {
    apiKey?: string
    apiSecret?: string
    redirectUri?: string
    clearApiSecret?: boolean
  }): Promise<DaemonSettings & { success?: boolean }> =>
    post('/api/daemon/settings/upstox', payload),

  /**
   * Save the Telegram alert bot token / chat id into the daemon's SQLite.
   * Omitted fields keep their value; takes effect on the next alert (the
   * daemon resolves the config per send — no restart needed).
   */
  saveTelegramSettings: (payload: {
    botToken?: string
    chatId?: string
  }): Promise<DaemonSettings & { success?: boolean }> =>
    post('/api/daemon/settings/telegram', payload),

  /** Deliver a test alert through the effective Telegram config. */
  testTelegram: (): Promise<{ success?: boolean; error?: string }> =>
    post('/api/daemon/settings/telegram/test', {}),

  saveConfig: (config: StrategyConfig): Promise<unknown> =>
    post('/api/bot/config', { userId: DAEMON_USER_ID, config }),

  resetPaper: (): Promise<unknown> =>
    post('/api/bot/paper-reset', { userId: DAEMON_USER_ID }),

  exitPosition: (symbol: UnderlyingSymbol, reason?: string): Promise<unknown> =>
    post('/api/bot/trade/exit', {
      userId: DAEMON_USER_ID,
      symbol,
      reason: reason ?? 'Manual window exit',
    }),
}
