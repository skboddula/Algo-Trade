/**
 * Daemon bot controller — a drop-in replacement for useStrategyBot that
 * sources every field of the BotStatus contract from the always-on daemon
 * instead of running bot logic inside the browser tab.
 *
 * Data flow:
 *  - REST  GET /api/bot/status every 3s (works without the WebSocket)
 *  - WS    /ws for live pushes: USER_STATE_UPDATE, MARKET_TICK, BOT_LOG
 *  - REST  GET /api/bot/stream-health every 10s → streamHealth badge
 *
 * Controls (start/stop/config/exit) are forwarded to the daemon; nothing
 * executes locally, so closing the tab never stops the bot.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  ActivePosition,
  AllSignalData,
  Candle,
  FinalSignal,
  IndicatorsResult,
  UnderlyingSymbol,
  VrdData,
} from '@/lib/types'
import { runHardStopChecks } from '@/lib/strategyEngine'
import { getStrategyConfig } from '@/lib/strategyConfig'
import type { BotLog, SourceStatus } from '@/lib/marketService'
import type { BotState, StreamHealth } from '@/hooks/useBotState'
import {
  checkDaemonHealth,
  daemonExitTrade,
  daemonStart,
  daemonStop,
  fetchDaemonLogs,
  fetchDaemonStatus,
  fetchDaemonStreamHealth,
  openDaemonStream,
  type DaemonBotLog,
  type DaemonPaperTrade,
} from '@/lib/daemon'

const PRIMARY: UnderlyingSymbol = 'NIFTY 50'
const SYMBOLS: UnderlyingSymbol[] = ['NIFTY 50', 'BANKNIFTY', 'FINNIFTY']
const MAX_LOGS = 300

/**
 * Formats the daemon's ISO-UTC snapshot timestamps for display — always in
 * IST, regardless of the viewing device's timezone (matches the browser
 * bot's contract where lastUpdated was a pre-formatted display string).
 */
function toIstDisplay(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })
}

interface DaemonUserState {
  userId: string
  state: BotState
  executionMode?: 'paper' | 'live'
  positions?: Partial<Record<UnderlyingSymbol, ActivePosition | null>>
  error?: string | null
  tradesCountToday?: number
  tradesCountPerSymbol?: Partial<Record<UnderlyingSymbol, number>>
  config?: Record<string, unknown>
}

interface DaemonSnapshot {
  timestamp: string
  underlyingSymbol: UnderlyingSymbol
  spotPrice: number
  candles: Candle[]
  optionChain?: unknown[]
  vix?: number
  pcr?: number
  indicators?: IndicatorsResult
  vrdData?: VrdData
  signal?: FinalSignal
  globalIndices?: AllSignalData['globalIndices']
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function useDaemonBot(_token: string | null) {
  const [connected, setConnected] = useState(false)
  const [state, setState] = useState<BotState>('IDLE')
  const [positions, setPositions] = useState<
    Partial<Record<UnderlyingSymbol, ActivePosition | null>>
  >({})
  const [snapshots, setSnapshots] = useState<
    Partial<Record<UnderlyingSymbol, DaemonSnapshot>>
  >({})
  const [logs, setLogs] = useState<BotLog[]>([])
  const [streamHealth, setStreamHealth] = useState<StreamHealth>('connecting')
  const [lastUpdated, setLastUpdated] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tradesCount, setTradesCount] = useState(0)
  const [tradesCountPerSymbol, setTradesCountPerSymbol] = useState<
    Partial<Record<UnderlyingSymbol, number>>
  >({})
  const [daemonPaperTrades, setDaemonPaperTrades] = useState<
    DaemonPaperTrade[]
  >([])
  const [paperBalance, setPaperBalance] = useState<number | null>(null)

  // ── REST polling (authority when WS is unavailable) ──────────────────────
  const refresh = useCallback(async () => {
    try {
      const res = await fetchDaemonStatus()
      const user = (res.userState ?? {}) as unknown as DaemonUserState
      setState(user.state ?? 'IDLE')
      setPositions(user.positions ?? {})
      setError(user.error ?? null)
      setTradesCount(user.tradesCountToday ?? 0)
      setTradesCountPerSymbol(user.tradesCountPerSymbol ?? {})
      setDaemonPaperTrades(res.paperTrades ?? [])
      const snap = res.snapshots ?? {}
      const mapped: Partial<Record<UnderlyingSymbol, DaemonSnapshot>> = {}
      for (const sym of SYMBOLS) {
        if (snap[sym]) mapped[sym] = snap[sym] as unknown as DaemonSnapshot
      }
      setSnapshots(mapped)
      const primaryTs = snap[PRIMARY]?.timestamp
      if (primaryTs) setLastUpdated(toIstDisplay(primaryTs))
      const balance = (user as { paperBalance?: number }).paperBalance
      if (typeof balance === 'number') setPaperBalance(balance / 100)
      setConnected(true)
    } catch (e) {
      setConnected(false)
      setError(e instanceof Error ? e.message : 'Daemon unreachable')
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void checkDaemonHealth().then(setConnected)
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh()
    const interval = setInterval(() => void refresh(), 3000)
    return () => clearInterval(interval)
  }, [refresh])

  // ── Stream health badge ──────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    const poll = async () => {
      try {
        const health = await fetchDaemonStreamHealth()
        if (cancelled) return
        const s = health.status
        setStreamHealth(
          s === 'connected'
            ? 'connected'
            : s === 'connecting' || s === 'reconnecting'
              ? 'connecting'
              : 'disconnected',
        )
      } catch {
        if (!cancelled) setStreamHealth('disconnected')
      }
    }
    void poll()
    const interval = setInterval(() => void poll(), 10_000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [])

  // ── Initial logs + WS live stream ────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    void fetchDaemonLogs()
      .then((res) => {
        if (!cancelled) setLogs(res.logs.slice(-MAX_LOGS))
      })
      .catch(() => {
        /* daemon may be down; polling will surface it */
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(
    () =>
      openDaemonStream({
        onMessage: (msg) => {
          if (msg.type === 'USER_STATE_UPDATE') {
            const user = (msg.data ?? {}) as DaemonUserState
            setState(user.state ?? 'IDLE')
            setPositions(user.positions ?? {})
            setTradesCount(user.tradesCountToday ?? 0)
            setTradesCountPerSymbol(user.tradesCountPerSymbol ?? {})
            if (user.error !== undefined) setError(user.error)
          } else if (msg.type === 'MARKET_TICK') {
            const tick = (msg.data ?? {}) as {
              snapshots?: Record<string, DaemonSnapshot>
            }
            const incoming = tick.snapshots ?? {}
            setSnapshots((prev) => ({ ...prev, ...incoming }))
            const ts = incoming[PRIMARY]?.timestamp
            if (ts) setLastUpdated(toIstDisplay(ts))
          } else if (msg.type === 'BOT_LOG') {
            const line = (msg.data ?? {}) as DaemonBotLog
            setLogs((prev) => [...prev.slice(-(MAX_LOGS - 1)), line])
          }
        },
      }),
    [],
  )

  // ── Controls (forwarded to the daemon) ───────────────────────────────────
  const start = useCallback(() => {
    const config = getStrategyConfig()
    const mode = config.executionMode === 'live' ? 'live' : 'paper'
    if (mode === 'live') {
      const confirmed = window.confirm(
        'Arm LIVE trading on the daemon? New strategy signals can place real Upstox orders until you stop the bot.',
      )
      if (!confirmed) return
    }
    void daemonStart(mode)
      .then(() => refresh())
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [refresh])

  const stop = useCallback(() => {
    const openPositions = Object.values(positions).filter((p) => p !== null)
    if (openPositions.length > 0) {
      const choice = window.confirm(
        `${openPositions.length} open position(s) on the daemon.\n\nOK = exit ALL positions first (sells at current prices), then stop the bot\nCancel = keep this browser view open and stop nothing`,
      )
      if (!choice) return
      const symbols = openPositions.map(
        (p) => p?.underlyingSymbol ?? p?.instrumentKey,
      )
      void Promise.all(
        symbols.map((s) =>
          daemonExitTrade(String(s), 'Stop & Square-off').catch(() => null),
        ),
      ).then(() => daemonStop().then(() => refresh()))
      return
    }
    void daemonStop()
      .then(() => refresh())
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [positions, refresh])

  const clearLogs = useCallback(() => setLogs([]), [])

  const exitTrade = useCallback(
    (symbol: UnderlyingSymbol) => {
      void daemonExitTrade(symbol)
        .then(() => refresh())
        .catch((e) => setError(e instanceof Error ? e.message : String(e)))
    },
    [refresh],
  )

  // ── Derive the BotStatus contract ────────────────────────────────────────
  const primary = snapshots[PRIMARY]
  const indicators = primary?.indicators ?? null
  const vrdData = primary?.vrdData ?? null

  const allSignalData: AllSignalData | null = useMemo(() => {
    if (!primary?.indicators) return null
    const ema = primary.indicators.ema
    return {
      v3: ema === 'Buy' ? 'buy' : ema === 'Sell' ? 'sell' : 'hold',
      indicators: primary.indicators,
      vrd: vrdData,
      globalIndices: primary.globalIndices ?? [],
    }
  }, [primary, vrdData])

  const finalSignal = primary?.signal ?? null

  const symbolIndicators = useMemo(() => {
    const out: Partial<Record<UnderlyingSymbol, IndicatorsResult | null>> = {}
    for (const sym of SYMBOLS) out[sym] = snapshots[sym]?.indicators ?? null
    return out
  }, [snapshots])

  const symbolSignals = useMemo(() => {
    const out: Partial<Record<UnderlyingSymbol, FinalSignal | null>> = {}
    for (const sym of SYMBOLS) out[sym] = snapshots[sym]?.signal ?? null
    return out
  }, [snapshots])

  const hardStop = useMemo(() => runHardStopChecks(vrdData), [vrdData])

  const sourceStatus = useMemo<Record<string, SourceStatus>>(() => {
    const ok = (v: boolean): SourceStatus => (v ? 'ok' : 'error')
    return {
      candles: ok((primary?.candles?.length ?? 0) > 0),
      'option-chain': ok((primary?.optionChain?.length ?? 0) > 0),
      vix: ok(vrdData?.vix != null),
      breadth: vrdData?.advancesDeclines ? ('ok' as const) : ('error' as const),
      'global-sentiment': vrdData?.giftNifty
        ? ('ok' as const)
        : ('stale' as const),
      'upstox/fii': vrdData?.fiiLongShort
        ? ('ok' as const)
        : ('stale' as const),
      'upstox/dii': 'unknown',
      'upstox/pcr': vrdData?.pcr ? ('ok' as const) : ('error' as const),
      'upstox/max-pain':
        vrdData?.maxPain != null ? ('ok' as const) : ('error' as const),
      'synthetic/value': vrdData?.niftyPe
        ? ('ok' as const)
        : ('error' as const),
    }
  }, [primary, vrdData])

  const position =
    positions[PRIMARY] ?? Object.values(positions).find((p) => p) ?? null

  // Full record (all three symbols, null when flat) to satisfy the
  // Record<UnderlyingSymbol, ActivePosition | null> contract.
  const fullPositions: Record<UnderlyingSymbol, ActivePosition | null> = {
    'NIFTY 50': positions['NIFTY 50'] ?? null,
    BANKNIFTY: positions.BANKNIFTY ?? null,
    FINNIFTY: positions.FINNIFTY ?? null,
  }

  const liveArmed = false

  return {
    // BotStatus contract
    state,
    position,
    positions: fullPositions,
    indicators,
    symbolIndicators,
    vrdData,
    allSignalData,
    finalSignal,
    symbolSignals,
    hardStop,
    streamHealth,
    lastUpdated,
    error,
    tradesCount,
    tradesCountPerSymbol,
    logs,
    sourceStatus,
    globalIndices: primary?.globalIndices ?? [],
    candles: primary?.candles ?? [],

    // Controller surface
    liveArmed,
    start,
    stop,
    clearLogs,

    // Daemon-mode extras
    daemonConnected: connected,
    daemonPaperTrades,
    paperBalance,
    daemonSnapshots: snapshots,
    exitTrade,
  }
}

export type DaemonBotController = ReturnType<typeof useDaemonBot>
