import { useEffect, useRef, useCallback, useState } from 'react'
import type {
  AllSignalData,
  ActivePosition,
  VrdData,
  IndicatorsResult,
  FinalSignal,
  UnderlyingSymbol,
} from '@/lib/types'
import { UNDERLYING_INSTRUMENT_KEYS } from '@/lib/types'
import { computeAllIndicators } from '@/lib/indicators'
import { runHardStopChecks, getFinalSignal } from '@/lib/strategyEngine'
import { getStrategyConfig } from '@/lib/strategyConfig'
import { appendTick } from '@/lib/tickLog'
import type { SourceStatus, BotLog } from '@/lib/marketService'
import {
  mkLog,
  fetchMarketForSymbols,
  fetchGlobalMarketData,
  fetchSymbolSentiment,
} from '@/lib/marketService'
import {
  useBotState,
  saveSnapshot,
  saveVrdCache,
  saveExitTimes,
  DEFAULT_POSITIONS,
  loadExitTimes,
} from './useBotState'
import { useTradeExecution, type ExecutionContext } from './useTradeExecution'
import { createUpstoxMarketStream } from '@/lib/upstoxMarketStream'
import {
  requestWakeLock,
  releaseWakeLock,
  setupVisibilityWarning,
} from '@/lib/pwa'
import {
  INDIA_VIX_INSTRUMENT_KEY,
  VIX_ELEVATED_THRESHOLD,
  VIX_CRITICAL_THRESHOLD,
} from '@/lib/constants'
import { sendTelegramAlert } from '@/lib/telegram'
import {
  fetchPaperHistory,
  getIndiaDateString,
  paperTradeToActivePosition,
} from '@/lib/paperTrading'

export type { SourceStatus, BotLog, GlobalIndexItem } from '@/lib/marketService'
export type { BotState, BotStatus } from './useBotState'

export function useStrategyBot(token: string | null) {
  const { status, statusRef, updateStatus, addLog, addLogs, clearLogs } =
    useBotState()
  const { evaluateAndEnter, evaluateAndExit } = useTradeExecution()

  const isTickingRef = useRef(false)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastExitTimesRef = useRef<Record<string, number>>(loadExitTimes())
  const abortRef = useRef<AbortController | null>(null)
  const mountedRef = useRef(true)
  const stopRequestedRef = useRef(false)
  const liveArmedRef = useRef(false)
  const resumedTokenRef = useRef<string | null>(null)
  const [liveArmed, setLiveArmed] = useState(false)
  const streamRef = useRef<ReturnType<typeof createUpstoxMarketStream> | null>(
    null,
  )
  const streamDisplayTimerRef = useRef<ReturnType<typeof setInterval> | null>(
    null,
  )
  const visibilityCleanupRef = useRef<(() => void) | null>(null)
  const streamedVixRef = useRef<number | null>(null)
  const vixWarningLevelRef = useRef<'none' | 'elevated' | 'critical'>('none')

  // ─── Upstox Market Data Feed V3 stream helpers ───────────────────────────
  const getStreamedPrice = useCallback(
    (instrumentKey: string): number | null => {
      return streamRef.current?.getLatestPrice(instrumentKey) ?? null
    },
    [],
  )

  const getStreamedVix = useCallback((): number | null => {
    return streamedVixRef.current
  }, [])

  /**
   * Applies tick-level streamed prices to open positions between polling
   * ticks for live PnL display. Guarded by isTickingRef so it never races
   * with an in-flight tick; ticks still own exit decisions.
   */
  const refreshDisplayedStreamPrices = useCallback(() => {
    const stream = streamRef.current
    if (!stream || isTickingRef.current) return
    const cur = statusRef.current
    if (cur.state !== 'RUNNING' && cur.state !== 'ORDERED') return

    let changed = false
    const nextPositions: Record<UnderlyingSymbol, ActivePosition | null> = {
      ...cur.positions,
    }

    for (const [sym, pos] of Object.entries(cur.positions)) {
      if (!pos) continue
      const key = sym as UnderlyingSymbol

      if (pos.legs && pos.legs.length > 0) {
        let legChanged = false
        const updatedLegs = pos.legs.map((leg) => {
          if (leg.status === 'CLOSED') return leg
          const streamed = stream.getLatestPrice(leg.instrumentKey)
          if (streamed == null || streamed === leg.currentPrice) return leg
          legChanged = true
          const unrealizedPnl =
            leg.tradeType === 'selling'
              ? (leg.entryPrice - streamed) * leg.quantity
              : (streamed - leg.entryPrice) * leg.quantity
          return { ...leg, currentPrice: streamed, unrealizedPnl }
        })
        if (legChanged) {
          const totalUnrealizedPnl = updatedLegs.reduce(
            (sum, leg) => sum + (leg.unrealizedPnl ?? 0),
            0,
          )
          const primaryLeg =
            updatedLegs.find(
              (leg) => leg.instrumentKey === pos.instrumentKey,
            ) ?? updatedLegs[0]
          nextPositions[key] = {
            ...pos,
            legs: updatedLegs,
            currentPrice: primaryLeg?.currentPrice ?? pos.currentPrice,
            unrealizedPnl: totalUnrealizedPnl,
          }
          changed = true
        }
      } else {
        const streamed = stream.getLatestPrice(pos.instrumentKey)
        if (streamed != null && streamed !== pos.currentPrice) {
          const isSelling = pos.tradeType === 'selling'
          const unrealizedPnl = isSelling
            ? (pos.entryPrice - streamed) * pos.quantity
            : (streamed - pos.entryPrice) * pos.quantity
          nextPositions[key] = { ...pos, currentPrice: streamed, unrealizedPnl }
          changed = true
        }
      }
    }

    if (!changed) return
    const primary =
      nextPositions['NIFTY 50'] ??
      Object.values(nextPositions).find((p) => p !== null) ??
      null
    updateStatus({ positions: nextPositions, position: primary })
  }, [statusRef, updateStatus])

  /** Keeps the stream subscribed to held position leg keys + India VIX. */
  const syncStreamSubscriptions = useCallback(
    (positions: Record<UnderlyingSymbol, ActivePosition | null>) => {
      const stream = streamRef.current
      if (!stream) return
      const keys = new Set<string>([INDIA_VIX_INSTRUMENT_KEY])
      for (const pos of Object.values(positions)) {
        if (!pos) continue
        if (pos.instrumentKey) keys.add(pos.instrumentKey)
        for (const leg of pos.legs ?? []) {
          if (leg.status === 'CLOSED') continue
          keys.add(leg.instrumentKey)
        }
      }
      stream.setSubscriptions(Array.from(keys))
    },
    [],
  )

  const stopStream = useCallback(() => {
    if (streamDisplayTimerRef.current) {
      clearInterval(streamDisplayTimerRef.current)
      streamDisplayTimerRef.current = null
    }
    const stream = streamRef.current
    if (stream) {
      stream.stop()
      streamRef.current = null
    }
    streamedVixRef.current = null
    vixWarningLevelRef.current = 'none'
  }, [])

  /**
   * Sends a throttled Telegram early warning when streamed India VIX crosses
   * the elevated (≥18) or critical (≥24) threshold. Hard stop itself still
   * happens in the tick via runHardStopChecks; this is purely informational
   * so the user has lead time to manage mirrored positions.
   */
  const checkVixEarlyWarning = useCallback(
    (vix: number) => {
      const level =
        vix >= VIX_CRITICAL_THRESHOLD
          ? ('critical' as const)
          : vix >= VIX_ELEVATED_THRESHOLD
            ? ('elevated' as const)
            : ('none' as const)
      if (level === vixWarningLevelRef.current) return
      const prevLevel = vixWarningLevelRef.current
      vixWarningLevelRef.current = level

      if (level === 'critical') {
        addLog(
          mkLog(
            'warn',
            'stream',
            `India VIX ${vix.toFixed(1)} ≥ ${VIX_CRITICAL_THRESHOLD} — hard stop at 25 imminent`,
          ),
        )
        void sendTelegramAlert(
          `⚠️ VIX ALERT — India VIX at ${vix.toFixed(1)}\nHard stop threshold is 25 — entries will be blocked soon.\nManage your open positions accordingly.`,
        ).catch(() => {
          // Best-effort; hard stop evaluation still runs in the tick.
        })
      } else if (level === 'elevated' && prevLevel === 'none') {
        addLog(
          mkLog(
            'info',
            'stream',
            `India VIX ${vix.toFixed(1)} elevated (≥${VIX_ELEVATED_THRESHOLD}) — sell bias scoring active`,
          ),
        )
      }
    },
    [addLog],
  )

  const startStream = useCallback(() => {
    if (streamRef.current) return
    const config = getStrategyConfig()
    if (config.useMarketStream === false) return
    if (!token) return
    const stream = createUpstoxMarketStream({
      getToken: () => (stopRequestedRef.current ? null : token),
      onTick: (tick) => {
        if (tick.instrumentKey !== INDIA_VIX_INSTRUMENT_KEY) return
        if (typeof tick.ltp !== 'number' || !Number.isFinite(tick.ltp)) return
        streamedVixRef.current = tick.ltp
        checkVixEarlyWarning(tick.ltp)
      },
      onStatus: (status, detail) => {
        if (status === 'open') {
          addLog(
            mkLog(
              'info',
              'stream',
              'Upstox market stream connected — tick-level prices active',
            ),
          )
        } else if (status === 'reconnecting') {
          addLog(
            mkLog(
              'warn',
              'stream',
              `market stream ${detail ?? 'reconnecting'}`,
            ),
          )
        } else if (status === 'closed') {
          addLog(
            mkLog(
              'warn',
              'stream',
              detail
                ? `market stream closed — ${detail} (falling back to REST prices)`
                : 'market stream closed (falling back to REST prices)',
            ),
          )
        }
      },
    })
    streamRef.current = stream
    stream.start()
    streamDisplayTimerRef.current = setInterval(
      () => refreshDisplayedStreamPrices(),
      5000,
    )
  }, [token, addLog, refreshDisplayedStreamPrices, checkVixEarlyWarning])

  /** Requests a screen wake lock and visibility warnings for always-on operation. */
  const startAlwaysOn = useCallback(() => {
    void requestWakeLock().then((acquired) => {
      if (!acquired) {
        addLog(
          mkLog(
            'info',
            'bot',
            'Wake Lock not supported on this device — screen may sleep and pause the bot',
          ),
        )
      }
    })
    visibilityCleanupRef.current?.()
    visibilityCleanupRef.current = setupVisibilityWarning({
      onHidden: (message) => {
        addLog(mkLog('warn', 'bot', message))
      },
    })
  }, [addLog])

  const stopAlwaysOn = useCallback(() => {
    void releaseWakeLock()
    visibilityCleanupRef.current?.()
    visibilityCleanupRef.current = null
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      abortRef.current?.abort()
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
      stopStream()
      stopAlwaysOn()
    }
  }, [stopStream, stopAlwaysOn])

  const tick = useCallback(async () => {
    if (!token || stopRequestedRef.current) return
    if (isTickingRef.current) return
    isTickingRef.current = true

    abortRef.current?.abort()
    const abort = new AbortController()
    abortRef.current = abort

    const cur = statusRef.current
    if (cur.state === 'STOPPED' || cur.state === 'IDLE') {
      isTickingRef.current = false
      return
    }

    const tickLogs: BotLog[] = []
    const log = (level: BotLog['level'], source: string, msg: string) => {
      const entry = mkLog(level, source, msg)
      tickLogs.push(entry)
      return entry
    }

    const srcUpdates: Record<string, SourceStatus> = {}
    const srcUpd = (k: string, s: SourceStatus) => {
      srcUpdates[k] = s
    }

    log('info', 'tick', `state=${cur.state} trades=${cur.tradesCount}`)

    try {
      const config = getStrategyConfig()
      const allowEntries =
        config.executionMode === 'paper' || liveArmedRef.current
      const allowedSymbols: UnderlyingSymbol[] =
        (config.underlyingMode ?? 'ALL_PARALLEL') === 'ALL_PARALLEL'
          ? ['NIFTY 50', 'BANKNIFTY', 'FINNIFTY']
          : [config.underlyingMode as UnderlyingSymbol]

      const curPositions: Record<UnderlyingSymbol, ActivePosition | null> = {
        ...DEFAULT_POSITIONS,
        ...(cur.positions ?? {}),
      }
      if (
        cur.position &&
        !curPositions[cur.position.underlyingSymbol ?? 'NIFTY 50']
      ) {
        curPositions[cur.position.underlyingSymbol ?? 'NIFTY 50'] = cur.position
      }
      const curTradesPerSym: Partial<Record<UnderlyingSymbol, number>> = {
        ...(cur.tradesCountPerSymbol ?? {}),
      }

      try {
        const history = await fetchPaperHistory()
        const hasAuthoritativeOpenTrades = history.openTrades !== undefined
        const openTrades =
          history.openTrades ??
          (history.trades ?? []).filter((trade) => trade.status === 'OPEN')
        const persistedPositions = openTrades
          .map((trade) =>
            paperTradeToActivePosition(trade, getIndiaDateString()),
          )
          .filter(
            (
              value,
            ): value is {
              symbol: UnderlyingSymbol
              position: ActivePosition
            } => value !== null,
          )
        const persistedTradeIds = new Set(
          persistedPositions.map(({ position }) => position.paperTradeId),
        )

        if (hasAuthoritativeOpenTrades) {
          for (const symbol of Object.keys(
            curPositions,
          ) as UnderlyingSymbol[]) {
            const localPosition = curPositions[symbol]
            if (
              localPosition?.executionMode === 'paper' &&
              localPosition.paperTradeId &&
              !persistedTradeIds.has(localPosition.paperTradeId)
            ) {
              curPositions[symbol] = null
              log(
                'warn',
                'paper',
                `[${symbol}] removed stale local paper position; D1 is authoritative`,
              )
            }
          }
        }

        for (const { symbol, position } of persistedPositions) {
          if (!curPositions[symbol]) {
            curPositions[symbol] = position
            log(
              'warn',
              'paper',
              `[${symbol}] restored open paper position from D1`,
            )
          }
        }
      } catch (error) {
        log(
          'warn',
          'paper',
          `Unable to reconcile open paper positions: ${(error as Error).message}`,
        )
      }

      const targetSymbolsSet = new Set<UnderlyingSymbol>(allowedSymbols)
      Object.entries(curPositions).forEach(([sym, pos]) => {
        if (pos !== null) {
          targetSymbolsSet.add(sym as UnderlyingSymbol)
        }
      })
      const targetSymbols = Array.from(targetSymbolsSet)
      const now = new Date()
      const currentHour = now.getHours()
      const currentMinute = now.getMinutes()
      const [lh, lm] = (config.lastEntryTime ?? '15:15').split(':').map(Number)
      const afterCutoff =
        Number.isFinite(lh) && Number.isFinite(lm)
          ? currentHour > lh || (currentHour === lh && currentMinute >= lm)
          : false

      const marketMap = await fetchMarketForSymbols(
        token,
        (e) => tickLogs.push(e),
        srcUpd,
        targetSymbols,
        abort.signal,
      )
      if (abort.signal.aborted || stopRequestedRef.current) return

      const primaryMarket =
        marketMap['NIFTY 50'] ??
        marketMap[targetSymbols[0]] ??
        Object.values(marketMap)[0]

      if (!primaryMarket?.candles.length) {
        const canUseSnapshot = Boolean(
          cur.indicators && cur.allSignalData && cur.finalSignal,
        )
        const hasOpenPosition = Object.values(curPositions).some(
          (position) => position !== null,
        )
        if (primaryMarket && hasOpenPosition) {
          log(
            'warn',
            'exit',
            'no candle data — running degraded position supervision',
          )
          const degradedCtx: ExecutionContext = {
            token,
            config,
            targetSymbols,
            allowedSymbols,
            marketMap,
            symbolSignals: cur.symbolSignals,
            symbolIndicators: cur.symbolIndicators,
            symbolVrds: cur.vrdData
              ? { [primaryMarket.underlyingSymbol]: cur.vrdData }
              : {},
            symbolHardStops: {},
            primaryMarket,
            primaryVrdData: cur.vrdData,
            indicators: cur.indicators,
            hardStop: cur.hardStop,
            afterCutoff,
            allowEntries: false,
            curPositions,
            curTradesPerSym,
            lastExitTimes: lastExitTimesRef.current,
            addLog,
            onStaticIpError: () => {
              updateStatus({
                error:
                  'Order placement blocked by Upstox static IP restriction while supervising an active position.',
              })
            },
            abortSignal: abort.signal,
          }
          await evaluateAndExit(degradedCtx, new Set())
          saveExitTimes(lastExitTimesRef.current)
        }

        const interrupted = abort.signal.aborted || stopRequestedRef.current
        const remainingPosition =
          curPositions['NIFTY 50'] ??
          Object.values(curPositions).find(
            (position): position is ActivePosition => position !== null,
          ) ??
          null
        const nextState = interrupted
          ? 'STOPPED'
          : remainingPosition
            ? 'ORDERED'
            : afterCutoff || !allowEntries
              ? 'STOPPED'
              : 'RUNNING'
        if (canUseSnapshot) {
          const normalizedStatuses = Object.fromEntries(
            Object.entries({ ...cur.sourceStatus, ...srcUpdates }).map(
              ([key, value]) => [
                key,
                value === 'error' || value === 'pending' ? 'stale' : value,
              ],
            ),
          ) as Record<string, SourceStatus>
          log('warn', 'tick', 'no candle data — using cached snapshot')
          addLogs(tickLogs)
          updateStatus({
            state: nextState,
            position: remainingPosition,
            positions: curPositions,
            sourceStatus: normalizedStatuses,
            lastUpdated: new Date().toLocaleTimeString('en-IN'),
            error: null,
          })
          return
        }
        log('error', 'tick', 'no candle data — skipping tick')
        addLogs(tickLogs)
        updateStatus({
          state: nextState,
          position: remainingPosition,
          positions: curPositions,
          sourceStatus: { ...cur.sourceStatus, ...srcUpdates },
          lastUpdated: new Date().toLocaleTimeString('en-IN'),
          error: 'No candle data',
        })
        return
      }

      const globalData = await fetchGlobalMarketData(
        token,
        (e) => tickLogs.push(e),
        srcUpd,
        primaryMarket.optionChain,
        targetSymbols,
        abort.signal,
      )
      if (abort.signal.aborted || stopRequestedRef.current) return

      const symbolSignals: Partial<
        Record<UnderlyingSymbol, FinalSignal | null>
      > = {}
      const symbolIndicators: Partial<
        Record<UnderlyingSymbol, IndicatorsResult | null>
      > = {}
      const symbolVrds: Partial<Record<UnderlyingSymbol, VrdData>> = {}
      const symbolHardStops: Partial<
        Record<
          UnderlyingSymbol,
          {
            blocked: boolean
            blockedDirection: 'CE' | 'PE' | 'BOTH' | 'NONE'
            reasons: string[]
          }
        >
      > = {}

      await Promise.all(
        targetSymbols.map(async (sym) => {
          const symMarket = marketMap[sym]
          if (!symMarket?.candles.length) return
          const symIndicators = computeAllIndicators(
            symMarket.candles,
            symMarket.optionChain,
          )
          const targetInstrumentKey =
            UNDERLYING_INSTRUMENT_KEYS[sym] ?? 'NSE_INDEX|Nifty 50'

          const symVrdData = await fetchSymbolSentiment(
            token,
            (e) => tickLogs.push(e),
            srcUpd,
            sym,
            targetInstrumentKey,
            symMarket.optionChain,
            symIndicators,
            primaryMarket.breadth,
            primaryMarket.giftNifty,
            globalData,
            abort.signal,
          )

          const symSignalData: AllSignalData = {
            v3: symMarket.v3,
            indicators: symIndicators,
            vrd: symVrdData,
            globalIndices: symMarket.globalIndices,
          }
          // Prefer tick-level India VIX from the WebSocket stream over the
          // REST-polled value; falls back automatically when the stream is
          // disconnected (getStreamedVix returns null).
          const streamedVix = getStreamedVix()
          const mergedVrd: VrdData =
            streamedVix !== null && Number.isFinite(streamedVix)
              ? { ...symVrdData, vix: streamedVix }
              : symVrdData
          const symSignal = getFinalSignal(
            { ...symSignalData, vrd: mergedVrd },
            config,
          )
          symbolSignals[sym] = symSignal
          symbolIndicators[sym] = symIndicators
          symbolVrds[sym] = mergedVrd
          symbolHardStops[sym] = runHardStopChecks(mergedVrd)

          log(
            'info',
            'engine',
            `[${sym}] bull=${symSignal.bullScore} bear=${symSignal.bearScore} → ${symSignal.signal} (${symSignal.confidence})`,
          )
        }),
      )
      if (abort.signal.aborted || stopRequestedRef.current) return

      const primaryVrdData = symbolVrds[primaryMarket.underlyingSymbol] ?? null
      if (primaryVrdData) {
        saveVrdCache(primaryVrdData)
        log(
          'info',
          'sentiment',
          `mmi=${primaryVrdData.mmi?.score} vix=${primaryVrdData.vix} pe=${primaryVrdData.niftyPe?.pe} A/D=${primaryVrdData.advancesDeclines?.advances}↑${primaryVrdData.advancesDeclines?.declines}↓`,
        )
      }

      // Primary hard stop comes from the primary market symbol's own VRD;
      // each symbol's individual hard stop is tracked in symbolHardStops.
      const hardStop =
        symbolHardStops[primaryMarket.underlyingSymbol] ??
        (primaryVrdData
          ? runHardStopChecks(primaryVrdData)
          : { blocked: false, blockedDirection: 'NONE' as const, reasons: [] })

      const indicators =
        symbolIndicators[primaryMarket.underlyingSymbol] ??
        computeAllIndicators(primaryMarket.candles, primaryMarket.optionChain)

      const allSignalData: AllSignalData = {
        v3: primaryMarket.v3,
        indicators,
        vrd: primaryVrdData ?? null,
        globalIndices: primaryMarket.globalIndices,
      }

      const finalSignal =
        symbolSignals['NIFTY 50'] ??
        symbolSignals[primaryMarket.underlyingSymbol] ??
        Object.values(symbolSignals).find(
          (s): s is FinalSignal => s !== null,
        ) ??
        getFinalSignal(allSignalData, config)

      appendTick({
        ts: Date.now(),
        bullScore: finalSignal.bullScore,
        bearScore: finalSignal.bearScore,
        scoreMax: finalSignal.scoreMax,
        confidence: finalSignal.confidence,
        signal: finalSignal.signal,
        vix: primaryVrdData?.vix ?? null,
        strongThreshold: config.strongThreshold,
        moderateThreshold: config.moderateThreshold,
        strongGap: config.strongGap,
        moderateGap: config.moderateGap,
      })

      if (hardStop.blocked)
        log('warn', 'engine', `HARD STOP: ${hardStop.reasons.join(', ')}`)

      addLogs(tickLogs)
      tickLogs.length = 0

      saveSnapshot({
        indicators,
        vrdData: primaryVrdData ?? null,
        allSignalData,
        finalSignal,
        hardStop,
        globalIndices: primaryMarket.globalIndices,
        lastUpdated: new Date().toLocaleTimeString('en-IN'),
        sourceStatus: { ...cur.sourceStatus, ...srcUpdates },
      })

      if (hardStop.blocked && hardStop.blockedDirection === 'BOTH') {
        const hasOpenPos = Object.values(cur.positions ?? {}).some(
          (p) => p !== null,
        )
        if (!hasOpenPos && !cur.position) {
          updateStatus({
            state: 'STOPPED',
            indicators,
            allSignalData,
            finalSignal,
            hardStop,
            sourceStatus: { ...cur.sourceStatus, ...srcUpdates },
            lastUpdated: new Date().toLocaleTimeString('en-IN'),
          })
          return
        }
      }

      if (afterCutoff) {
        addLog(
          mkLog(
            'warn',
            'bot',
            `after last entry time ${config.lastEntryTime} — skipping new entries`,
          ),
        )
      }

      const ctx: ExecutionContext = {
        token,
        config,
        targetSymbols,
        allowedSymbols,
        marketMap,
        symbolSignals,
        symbolIndicators,
        symbolVrds,
        symbolHardStops,
        primaryMarket,
        primaryVrdData,
        indicators,
        hardStop,
        afterCutoff,
        allowEntries,
        curPositions,
        curTradesPerSym,
        lastExitTimes: lastExitTimesRef.current,
        getStreamedPrice,
        addLog: (l) => addLog(l),
        onStaticIpError: () => {
          const hasActivePos = Object.values(curPositions).some(
            (p) => p !== null,
          )
          if (!hasActivePos) {
            if (timeoutRef.current) clearTimeout(timeoutRef.current)
            timeoutRef.current = null
            updateStatus({
              state: 'STOPPED',
              error:
                'Order placement blocked by Upstox static IP restriction. Configure a static IP in Upstox or use a whitelisted execution environment.',
            })
          } else {
            updateStatus({
              error:
                'Order placement blocked by Upstox static IP restriction. Maintaining active position ticker.',
            })
          }
          addLog(
            mkLog(
              'warn',
              'bot',
              'Upstox order API is blocked by static IP restriction',
            ),
          )
        },
        abortSignal: abort.signal,
      }

      const persistExecutionState = (forceStopped: boolean) => {
        saveExitTimes(lastExitTimesRef.current)
        const hasActivePosition = Object.values(curPositions).some(
          (position) => position !== null,
        )
        const totalTrades = Object.values(curTradesPerSym).reduce(
          (acc, count) => acc + (count ?? 0),
          0,
        )
        const nextState = forceStopped
          ? ('STOPPED' as const)
          : hasActivePosition
            ? ('ORDERED' as const)
            : afterCutoff || !allowEntries
              ? ('STOPPED' as const)
              : ('RUNNING' as const)
        const primaryPos =
          curPositions['NIFTY 50'] ??
          Object.values(curPositions).find(
            (position): position is ActivePosition => position !== null,
          ) ??
          null

        updateStatus({
          state: nextState,
          position: primaryPos,
          positions: curPositions,
          tradesCount: totalTrades,
          tradesCountPerSymbol: curTradesPerSym,
          indicators,
          symbolIndicators,
          vrdData: primaryVrdData ?? null,
          allSignalData,
          finalSignal,
          symbolSignals,
          hardStop,
          sourceStatus: { ...cur.sourceStatus, ...srcUpdates },
          lastUpdated: new Date().toLocaleTimeString('en-IN'),
          error: undefined,
        })
        syncStreamSubscriptions(curPositions)
      }

      const newlyEnteredPositions = await evaluateAndEnter(ctx)
      if (abort.signal.aborted || stopRequestedRef.current) {
        if (newlyEnteredPositions.size > 0) {
          addLog(
            mkLog(
              'warn',
              'bot',
              'stop was requested while an order was in flight; accepted positions were retained',
            ),
          )
        }
        persistExecutionState(true)
        return
      }
      await evaluateAndExit(ctx, newlyEnteredPositions)
      persistExecutionState(abort.signal.aborted || stopRequestedRef.current)
    } catch (err) {
      if (abort.signal.aborted || stopRequestedRef.current) return
      const msg = err instanceof Error ? err.message : String(err)
      addLogs([...tickLogs, mkLog('error', 'tick', `unhandled: ${msg}`)])
      updateStatus({ error: msg })
    } finally {
      isTickingRef.current = false
    }
  }, [
    token,
    updateStatus,
    addLogs,
    addLog,
    evaluateAndEnter,
    evaluateAndExit,
    statusRef,
    getStreamedPrice,
    getStreamedVix,
    syncStreamSubscriptions,
  ])

  const scheduleNext = useCallback(() => {
    function loop() {
      if (stopRequestedRef.current) return
      const config = getStrategyConfig()
      timeoutRef.current = setTimeout(() => {
        void tick().finally(() => {
          const state = statusRef.current.state
          if (
            !stopRequestedRef.current &&
            (state === 'RUNNING' || state === 'ORDERED')
          ) {
            loop()
          }
        })
      }, config.pollingIntervalSec * 1000)
    }
    loop()
  }, [tick, statusRef])

  const start = useCallback(() => {
    if (!token) {
      addLog(mkLog('error', 'bot', 'cannot start — no broker token'))
      return
    }
    const config = getStrategyConfig()
    if (config.executionMode === 'live') {
      const confirmed = window.confirm(
        'Arm LIVE trading for this session? New strategy signals can place real Upstox orders until you stop the bot or close the app.',
      )
      if (!confirmed) {
        liveArmedRef.current = false
        setLiveArmed(false)
        addLog(mkLog('warn', 'bot', 'live start cancelled — not armed'))
        return
      }
      liveArmedRef.current = true
      setLiveArmed(true)
    } else {
      liveArmedRef.current = false
      setLiveArmed(false)
    }
    stopRequestedRef.current = false
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
    addLog(
      mkLog(
        'info',
        'bot',
        `starting — interval=${config.pollingIntervalSec}s threshold=${config.strongThreshold}/${config.moderateThreshold}`,
      ),
    )
    updateStatus({ state: 'RUNNING', error: null })
    startStream()
    startAlwaysOn()
    void Promise.resolve()
      .then(tick)
      .finally(() => {
        const state = statusRef.current.state
        if (
          !stopRequestedRef.current &&
          (state === 'RUNNING' || state === 'ORDERED')
        ) {
          scheduleNext()
        }
      })
  }, [
    token,
    tick,
    updateStatus,
    addLog,
    scheduleNext,
    statusRef,
    startStream,
    startAlwaysOn,
  ])

  const stop = useCallback(() => {
    stopRequestedRef.current = true
    abortRef.current?.abort()
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
    timeoutRef.current = null
    liveArmedRef.current = false
    setLiveArmed(false)
    stopStream()
    stopAlwaysOn()
    const current = statusRef.current
    const hasOpenPosition = Object.values(current.positions).some(
      (position) => position !== null,
    )
    addLog(mkLog('info', 'bot', 'stopped by user'))
    updateStatus({
      state: hasOpenPosition ? 'STOPPED' : 'IDLE',
      error: null,
    })
  }, [updateStatus, addLog, statusRef, stopStream, stopAlwaysOn])

  useEffect(() => {
    if (!token) {
      resumedTokenRef.current = null
      return
    }
    if (resumedTokenRef.current === token) return
    resumedTokenRef.current = token

    const persisted = statusRef.current
    if (persisted.state !== 'RUNNING' && persisted.state !== 'ORDERED') return

    const config = getStrategyConfig()
    const hasOpenPosition = Object.values(persisted.positions).some(
      (position) => position !== null,
    )
    if (config.executionMode === 'live' && !hasOpenPosition) {
      addLog(
        mkLog(
          'warn',
          'bot',
          'persisted live run was not resumed — press Start to arm live trading for this session',
        ),
      )
      updateStatus({ state: 'IDLE' })
      return
    }

    stopRequestedRef.current = false
    if (config.executionMode === 'live') {
      updateStatus({ state: 'ORDERED' })
      addLog(
        mkLog(
          'warn',
          'bot',
          'resumed live position supervision without arming new entries',
        ),
      )
    } else {
      addLog(
        mkLog('info', 'bot', `resumed from persisted state=${persisted.state}`),
      )
    }
    startStream()
    startAlwaysOn()

    const resumeTimer = setTimeout(() => {
      void tick().finally(() => {
        const state = statusRef.current.state
        if (
          !stopRequestedRef.current &&
          (state === 'RUNNING' || state === 'ORDERED')
        ) {
          scheduleNext()
        }
      })
    }, 0)

    return () => {
      clearTimeout(resumeTimer)
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
      abortRef.current?.abort()
    }
  }, [
    token,
    tick,
    addLog,
    scheduleNext,
    statusRef,
    updateStatus,
    startStream,
    startAlwaysOn,
  ])

  return { ...status, liveArmed, start, stop, clearLogs }
}

export type StrategyBotController = ReturnType<typeof useStrategyBot>
