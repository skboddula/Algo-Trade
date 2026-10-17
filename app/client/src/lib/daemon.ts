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

/** Same-origin calls into the daemon's bot API. */
export const daemonApi = {
  status: (): Promise<DaemonStatus> =>
    request<DaemonStatus>(`/api/bot/status?userId=${DAEMON_USER_ID}`),

  health: (): Promise<DaemonHealth> => request<DaemonHealth>('/health'),

  start: (executionMode: 'paper' | 'live'): Promise<unknown> =>
    post('/api/bot/start', { userId: DAEMON_USER_ID, executionMode }),

  stop: (): Promise<unknown> =>
    post('/api/bot/stop', { userId: DAEMON_USER_ID }),

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
