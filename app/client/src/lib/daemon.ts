/**
 * Daemon client — connects the dashboard to the always-on Fastify daemon
 * (app/core) instead of running the bot in the browser tab.
 *
 * All bot logic lives in the daemon; these helpers only read state, forward
 * control commands (start/stop/config/exit), stream live updates over the
 * WebSocket, and hand the daily OAuth token to the daemon after the browser
 * login flow completes.
 *
 * REST:  http://localhost:3000/api/bot/*
 * WS:    ws://localhost:3000/ws?userId=<userId>  (MARKET_TICK,
 *        USER_STATE_UPDATE, BOT_LOG message types — see app/core/API.md)
 */

const DAEMON_USER_ID = 'default_user'

export function daemonBaseUrl(): string {
  const env = import.meta.env as Record<string, string | undefined>
  if (env.VITE_DAEMON_URL) return env.VITE_DAEMON_URL
  const host = env.VITE_DAEMON_HOST ?? 'localhost'
  const port = env.VITE_DAEMON_PORT ?? '3000'
  return `http://${host}:${port}`
}

export function daemonWsUrl(userId = DAEMON_USER_ID): string {
  const http = daemonBaseUrl()
  const wsBase = http.replace(/^http/, 'ws')
  return `${wsBase}/ws?userId=${encodeURIComponent(userId)}`
}

// ─── REST helpers ─────────────────────────────────────────────────────────────

async function daemonFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${daemonBaseUrl()}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  })
  if (!res.ok) {
    const err: { error?: string } = (await res.json().catch(() => ({}))) as {
      error?: string
    }
    throw new Error(err.error ?? `Daemon HTTP ${res.status}`)
  }
  const raw: unknown = await res.json()
  return raw as T
}

export async function checkDaemonHealth(timeoutMs = 1500): Promise<boolean> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const res = await fetch(`${daemonBaseUrl()}/health`, {
      signal: controller.signal,
    })
    clearTimeout(timer)
    if (!res.ok) return false
    const data: { status?: string } = await res.json()
    return data.status === 'healthy'
  } catch {
    return false
  }
}

/** GET /api/bot/status — snapshots + user state + paper trades */
export function fetchDaemonStatus(userId = DAEMON_USER_ID) {
  return daemonFetch<{
    serverTime: string
    snapshots: Record<
      string,
      {
        timestamp: string
        underlyingSymbol: string
        spotPrice: number
        candles: [string, number, number, number, number, number][]
        optionChain?: unknown[]
        vix?: number
        pcr?: number
        indicators?: Record<string, unknown>
        vrdData?: Record<string, unknown>
        signal?: Record<string, unknown>
        globalIndices?: {
          symbol: string
          last_price: number | null
          change_per: number
        }[]
      }
    >
    userState: Record<string, unknown>
    paperTrades: DaemonPaperTrade[]
  }>(`/api/bot/status?userId=${encodeURIComponent(userId)}`)
}

export function daemonStart(
  executionMode: 'paper' | 'live' = 'paper',
  userId = DAEMON_USER_ID,
) {
  return daemonFetch<{ success: boolean }>(`/api/bot/start`, {
    method: 'POST',
    body: JSON.stringify({ userId, executionMode }),
  })
}

export function daemonStop(userId = DAEMON_USER_ID) {
  return daemonFetch<{ success: boolean }>(`/api/bot/stop`, {
    method: 'POST',
    body: JSON.stringify({ userId }),
  })
}

export function daemonUpdateConfig(
  config: Record<string, unknown>,
  userId = DAEMON_USER_ID,
) {
  return daemonFetch<{ success: boolean }>(`/api/bot/config`, {
    method: 'POST',
    body: JSON.stringify({ userId, config }),
  })
}

export function daemonExitTrade(
  symbol: string,
  reason = 'Manual Web Exit',
  userId = DAEMON_USER_ID,
) {
  return daemonFetch<{ success: boolean }>(`/api/bot/trade/exit`, {
    method: 'POST',
    body: JSON.stringify({ userId, symbol, reason }),
  })
}

export function fetchDaemonLogs(limit = 200) {
  return daemonFetch<{ logs: DaemonBotLog[] }>(`/api/bot/logs?limit=${limit}`)
}

export function fetchDaemonStreamHealth() {
  return daemonFetch<{
    status: string
    vix?: number | null
    lastTickAt?: string | null
  }>(`/api/bot/stream-health`)
}

export function fetchDaemonEquityCurve(userId = DAEMON_USER_ID) {
  return daemonFetch<{
    points: { time: string; balance: number; pnl: number }[]
    stats: {
      startBalance: number
      currentBalance: number
      totalTrades: number
      wins: number
      losses: number
      winRatePct: number
      realizedPnl: number
      maxDrawdownPct: number
    }
  }>(`/api/bot/equity-curve?userId=${encodeURIComponent(userId)}`)
}

export function daemonBacktest(body: Record<string, unknown>) {
  return daemonFetch<Record<string, unknown>>(`/api/bot/backtest`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

/** Hands a fresh OAuth access token to the daemon (daily morning ritual). */
export function pushTokenToDaemon(token: string, userId = DAEMON_USER_ID) {
  return daemonFetch<{ success: boolean }>(`/api/bot/token`, {
    method: 'POST',
    body: JSON.stringify({ userId, token }),
  })
}

// ─── WebSocket live stream ────────────────────────────────────────────────────

/** The daemon's file-based paper trade record (prices in PAISE). */
export interface DaemonPaperTrade {
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
  metadata?: {
    tradeType?: string
    underlyingSymbol?: string
    strikePrice?: number
    expiry?: string
    exitReason?: string
    entryCharges?: { totalCharges: number }
    exitCharges?: { totalCharges: number }
    totalTradeFees?: number
    grossPnl?: number
  }
}

export interface DaemonBotLog {
  id: string
  ts: string
  level: 'info' | 'warn' | 'error' | 'debug'
  source: string
  msg: string
}

export interface DaemonWsMessage {
  type:
    | 'MARKET_TICK'
    | 'USER_STATE_UPDATE'
    | 'BOT_LOG'
    | 'INITIAL_STATE'
    | (string & {})
  data: unknown
}

interface DaemonStreamOptions {
  userId?: string
  onMessage: (msg: DaemonWsMessage) => void
  onStatusChange?: (status: 'connecting' | 'connected' | 'disconnected') => void
}

/**
 * Manages the daemon WebSocket with auto-reconnect (1s backoff while the
 * dashboard is open). Returns a disposer. Reconnection keeps trying for as
 * long as the dashboard is open — a closed daemon simply means no live
 * push (REST polling still works).
 */
export function openDaemonStream(opts: DaemonStreamOptions): () => void {
  let ws: WebSocket | null = null
  let disposed = false
  let retryTimer: ReturnType<typeof setTimeout> | null = null

  const connect = () => {
    if (disposed) return
    opts.onStatusChange?.('connecting')
    try {
      ws = new WebSocket(daemonWsUrl(opts.userId))
    } catch {
      scheduleRetry()
      return
    }
    ws.onopen = () => {
      if (disposed) {
        ws?.close()
        return
      }
      opts.onStatusChange?.('connected')
    }
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(String(event.data)) as DaemonWsMessage
        opts.onMessage(msg)
      } catch {
        // Ignore malformed frames
      }
    }
    ws.onclose = () => {
      if (disposed) return
      opts.onStatusChange?.('disconnected')
      scheduleRetry()
    }
    ws.onerror = () => {
      // onclose follows; nothing else to do
    }
  }

  const scheduleRetry = () => {
    if (disposed || retryTimer) return
    retryTimer = setTimeout(() => {
      retryTimer = null
      connect()
    }, 1000)
  }

  connect()

  return () => {
    disposed = true
    if (retryTimer) clearTimeout(retryTimer)
    try {
      ws?.close()
    } catch {
      // Ignore
    }
  }
}
