import { useCallback, useEffect, useRef, useState } from 'react'
import { daemonApi, type DaemonHealth, type DaemonStatus } from '@/lib/daemon'
import type { BotLog } from '@/lib/marketService'
import type {
  StrategyConfig,
  UnderlyingSymbol,
  UserBotState,
} from '@/lib/types'
import { DEFAULT_CONFIG } from '@/lib/types'
import { MAX_LOGS } from '@/lib/constants'
import { appendTick } from '@/lib/tickLog'

const STATUS_POLL_MS = 5000
const HEALTH_POLL_MS = 5000
const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000]

export interface DaemonController {
  /** WebSocket link to the daemon is up. */
  connected: boolean
  status: DaemonStatus | null
  health: DaemonHealth | null
  /** Client-side activity log (connections, actions, errors). */
  logs: BotLog[]
  busy: boolean
  lastTickAt: string | null
  clearLogs: () => void
  /** Force an immediate status + health refresh (header refresh button). */
  refresh: () => void
  start: (mode: 'paper' | 'live') => Promise<void>
  stop: () => Promise<void>
  exitPosition: (symbol: UnderlyingSymbol, reason?: string) => Promise<void>
  resetPaper: () => Promise<void>
  saveConfig: (config: StrategyConfig) => Promise<void>
}

/**
 * Live window over the daemon: subscribes to `/ws` for ticks and bot-state
 * updates, and polls `/api/bot/status` + `/health` on a slow cadence as the
 * fallback (and for paper-ledger data the socket does not push).
 */
export function useDaemon(): DaemonController {
  const [connected, setConnected] = useState(false)
  const [status, setStatus] = useState<DaemonStatus | null>(null)
  const [health, setHealth] = useState<DaemonHealth | null>(null)
  const [logs, setLogs] = useState<BotLog[]>([])
  const [busy, setBusy] = useState(false)
  const [lastTickAt, setLastTickAt] = useState<string | null>(null)

  const mountedRef = useRef(true)
  const logSeqRef = useRef(0)
  /** Epoch ms of the last socket frame — REST polls that started earlier are stale. */
  const lastSocketFrameRef = useRef(0)
  /** Latest status snapshot, for handlers that must not close over stale state. */
  const statusRef = useRef<DaemonStatus | null>(null)

  useEffect(() => {
    statusRef.current = status
  }, [status])

  const addLog = useCallback(
    (level: BotLog['level'], msg: string, source = 'window') => {
      logSeqRef.current += 1
      const entry: BotLog = {
        id: `${Date.now()}-${logSeqRef.current}`,
        ts: new Date().toISOString(),
        level,
        source,
        msg,
      }
      setLogs((prev) => [...prev.slice(-(MAX_LOGS - 1)), entry])
    },
    [],
  )

  const clearLogs = useCallback(() => setLogs([]), [])

  const refreshStatus = useCallback(async () => {
    const startedAt = Date.now()
    try {
      const next = await daemonApi.status()
      // Socket frames that landed mid-fetch are fresher than this snapshot.
      if (mountedRef.current && lastSocketFrameRef.current < startedAt) {
        setStatus(next)
      }
    } catch {
      // Transient failure — connection state is owned by the socket effect.
    }
  }, [])

  const refreshHealth = useCallback(async () => {
    try {
      const next = await daemonApi.health()
      if (mountedRef.current) setHealth(next)
    } catch {
      // Transient failure — the next poll retries.
    }
  }, [])

  const refresh = useCallback(() => {
    void refreshStatus()
    void refreshHealth()
  }, [refreshStatus, refreshHealth])

  /**
   * Mirror the daemon's tick signal into the rolling tick log so the
   * Threshold Optimizer can replay ticks from this window (same behavior as
   * the cloud dashboard's browser engine).
   */
  const feedTickLog = useCallback(
    (timestamp: string, snapshots: DaemonStatus['snapshots']) => {
      try {
        const preferred =
          snapshots['NIFTY 50'] ?? Object.values(snapshots).find(Boolean)
        const signal = preferred?.signal
        if (!signal) return
        const config = statusRef.current?.userState?.config ?? DEFAULT_CONFIG
        const parsed = Date.parse(timestamp)
        appendTick({
          ts: Number.isFinite(parsed) ? parsed : Date.now(),
          bullScore: signal.bullScore,
          bearScore: signal.bearScore,
          scoreMax: signal.scoreMax,
          confidence: signal.confidence,
          signal: signal.signal,
          vix: preferred?.vix ?? preferred?.vrdData?.vix ?? null,
          strongThreshold: config.strongThreshold,
          moderateThreshold: config.moderateThreshold,
          strongGap: config.strongGap,
          moderateGap: config.moderateGap,
        })
      } catch {
        // Storage full/unavailable — the optimizer just sees fewer ticks.
      }
    },
    [],
  )

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // ── Socket + polling lifecycle ────────────────────────────────────────────
  useEffect(() => {
    let disposed = false
    let reconnectTimer: number | null = null
    let attempts = 0
    let socket: WebSocket | null = null

    const connect = () => {
      if (disposed) return
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      socket = new WebSocket(`${proto}//${window.location.host}/ws`)

      socket.onopen = () => {
        if (disposed) return
        attempts = 0
        setConnected(true)
      }

      socket.onmessage = (evt) => {
        if (disposed) return
        try {
          const msg = JSON.parse(evt.data as string) as {
            type: string
            data: unknown
          }
          lastSocketFrameRef.current = Date.now()
          if (msg.type === 'INITIAL_STATE') {
            const data = msg.data as Pick<
              DaemonStatus,
              'snapshots' | 'userState'
            >
            setStatus((prev) => ({
              serverTime: prev?.serverTime ?? new Date().toISOString(),
              paperTrades: prev?.paperTrades ?? [],
              snapshots: data.snapshots,
              userState: data.userState,
            }))
          } else if (msg.type === 'MARKET_TICK') {
            const data = msg.data as {
              timestamp: string
              snapshots: DaemonStatus['snapshots']
            }
            setLastTickAt(data.timestamp)
            feedTickLog(data.timestamp, data.snapshots)
            setStatus((prev) =>
              prev ? { ...prev, snapshots: data.snapshots } : prev,
            )
          } else if (msg.type === 'USER_STATE_UPDATE') {
            const userState = msg.data as UserBotState
            setStatus((prev) => (prev ? { ...prev, userState } : prev))
          }
        } catch {
          // Ignore malformed frames.
        }
      }

      socket.onclose = () => {
        if (disposed) return
        setConnected(false)
        const delay =
          RECONNECT_DELAYS_MS[
            Math.min(attempts, RECONNECT_DELAYS_MS.length - 1)
          ]
        attempts += 1
        reconnectTimer = window.setTimeout(connect, delay)
      }
    }

    // Initial external sync: state lands when these promises resolve.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshStatus()
    void refreshHealth()
    connect()

    const statusTimer = window.setInterval(() => {
      void refreshStatus()
    }, STATUS_POLL_MS)
    const healthTimer = window.setInterval(() => {
      void refreshHealth()
    }, HEALTH_POLL_MS)

    return () => {
      disposed = true
      window.clearInterval(statusTimer)
      window.clearInterval(healthTimer)
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer)
      socket?.close()
    }
  }, [addLog, refreshStatus, refreshHealth, feedTickLog])

  // ── Actions ───────────────────────────────────────────────────────────────
  const runAction = useCallback(
    async (label: string, fn: () => Promise<unknown>) => {
      setBusy(true)
      try {
        await fn()
        addLog('info', `${label} — ok`)
      } catch (err) {
        addLog(
          'error',
          `${label} failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      } finally {
        setBusy(false)
        await refreshStatus()
      }
    },
    [addLog, refreshStatus],
  )

  const start = useCallback(
    (mode: 'paper' | 'live') =>
      runAction(`Start (${mode})`, () => daemonApi.start(mode)),
    [runAction],
  )

  const stop = useCallback(
    () => runAction('Stop', () => daemonApi.stop()),
    [runAction],
  )

  const exitPosition = useCallback(
    (symbol: UnderlyingSymbol, reason?: string) =>
      runAction(`Exit ${symbol}`, () => daemonApi.exitPosition(symbol, reason)),
    [runAction],
  )

  const resetPaper = useCallback(
    () => runAction('Paper reset', () => daemonApi.resetPaper()),
    [runAction],
  )

  const saveConfig = useCallback(
    (config: StrategyConfig) =>
      runAction('Save config', () => daemonApi.saveConfig(config)),
    [runAction],
  )

  return {
    connected,
    status,
    health,
    logs,
    busy,
    lastTickAt,
    clearLogs,
    refresh,
    start,
    stop,
    exitPosition,
    resetPaper,
    saveConfig,
  }
}
