import { EventEmitter } from 'events'
import type {
  UnderlyingSymbol,
  StrategyConfig,
  UserBotState,
  ActivePosition,
  MarketSnapshot,
  AllSignalData,
  PaperTradeRecord,
} from '../types'
import {
  DEFAULT_STRATEGY_CONFIG,
  VIX_CRITICAL_ALERT_COOLDOWN_MS,
  VIX_CRITICAL_THRESHOLD,
  VIX_ELEVATED_THRESHOLD,
  VIX_HARD_STOP_MAX,
} from '../constants'
import { MasterIngestionEngine } from './masterIngestor'
import { OrderGateway } from './orderGateway'
import { pickBestOptionContract } from './syntheticCalculators'
import { runHardStopChecks } from './strategyEngine'
import { getIndiaTime } from '../utils/timeUtils'
import type { StateStore } from './stateStore'
import type { Notifier } from './notifier'
import {
  buildDailySummaryMessage,
  buildEntryAlertMessage,
  buildExitAlertMessage,
  buildVixAlertMessage,
} from '../../../../packages/shared/src/telegram'

export class TenantManager extends EventEmitter {
  /** Env var that arms live trading server-side (client confirms are only UX). */
  static readonly LIVE_ARM_ENV = 'DAEMON_LIVE_ARMED'

  private users: Map<string, UserBotState> = new Map()
  private masterIngestor: MasterIngestionEngine
  private orderGateway: OrderGateway
  private store: StateStore | null
  private notifier?: Notifier
  private lastPersistAt: Map<string, number> = new Map()
  private vixWarningLevel: 'none' | 'elevated' | 'critical' = 'none'
  private lastVixAlertAt = 0
  private dailySummaryDate: string | null = null

  constructor(
    masterIngestor: MasterIngestionEngine,
    orderGateway: OrderGateway,
    opts: { store?: StateStore | null; notifier?: Notifier } = {},
  ) {
    super()
    this.setMaxListeners(100)
    this.masterIngestor = masterIngestor
    this.orderGateway = orderGateway
    this.store = opts.store ?? null
    this.notifier = opts.notifier
    // Persisted so an EOD-summary re-send cannot happen after a restart.
    this.dailySummaryDate = this.store?.getSetting('daily_summary_date') ?? null

    // Rehydrate persisted bot states first (restart / reboot recovery)
    if (this.store) {
      for (const persisted of this.store.loadUserStates()) {
        this.users.set(persisted.userId, persisted)
      }
    }

    // Stream any rehydrated open-position contracts at tick level
    this.syncWatchedOptionContracts()

    // Bind to master market ticks
    this.masterIngestor.on('marketTick', (tick) => {
      this.handleMarketTick(tick).catch((err) => {
        this.emit('error', err)
      })
    })
  }

  public getOrCreateUser(userId: string): UserBotState {
    const istInfo = getIndiaTime()
    let user = this.users.get(userId)
    if (!user) {
      const paperAccount = this.orderGateway.getOrCreatePaperAccount(userId)
      user = {
        userId,
        state: 'IDLE',
        executionMode: 'paper',
        config: { ...DEFAULT_STRATEGY_CONFIG },
        positions: {
          'NIFTY 50': null,
          BANKNIFTY: null,
          FINNIFTY: null,
        },
        tradesCountToday: 0,
        tradesCountPerSymbol: {},
        lastTradeDate: istInfo.dateString,
        lastExitTimes: {},
        totalRealizedPnl: 0,
        paperBalance: paperAccount.balance,
        updatedAt: istInfo.date.toISOString(),
      }
      this.users.set(userId, user)
      this.persistUser(user, true)
    } else {
      // Date rollover check: reset daily counts if new IST trading day
      if (user.lastTradeDate !== istInfo.dateString) {
        user.lastTradeDate = istInfo.dateString
        user.tradesCountToday = 0
        user.tradesCountPerSymbol = {}
        this.persistUser(user, true)
      }
      const paperAccount = this.orderGateway.getOrCreatePaperAccount(userId)
      user.paperBalance = paperAccount.balance
    }
    return user
  }

  public updateConfig(userId: string, config: Partial<StrategyConfig>): UserBotState {
    const user = this.getOrCreateUser(userId)
    const requestedMode = config.executionMode ?? user.executionMode
    if (requestedMode === 'live') {
      this.requireLiveArmed()
    }
    // A running paper bot must not flip live mid-session — that would bypass
    // the arming check Start performs. Require an explicit stop first.
    if (
      requestedMode !== user.executionMode &&
      (user.state === 'RUNNING' || user.state === 'ORDERED')
    ) {
      throw new Error(
        'Stop the bot before switching between paper and live execution',
      )
    }
    user.config = { ...user.config, ...config }
    user.executionMode = user.config.executionMode
    user.updatedAt = new Date().toISOString()
    this.emitUserUpdate(user)
    this.persistUser(user, true)
    return user
  }

  public setToken(userId: string, token: string): UserBotState {
    const user = this.getOrCreateUser(userId)
    user.upstoxToken = token
    user.updatedAt = new Date().toISOString()
    this.emitUserUpdate(user)
    this.persistUser(user, true)
    return user
  }

  /** Remove the per-user order-token override (falls back to the master token). */
  public clearToken(userId: string): UserBotState {
    const user = this.getOrCreateUser(userId)
    user.upstoxToken = undefined
    user.updatedAt = new Date().toISOString()
    this.emitUserUpdate(user)
    this.persistUser(user, true)
    return user
  }

  /** Effective token used for this user's orders / REST calls (override → master). */
  public getEffectiveOrderToken(userId: string): string | undefined {
    return this.resolveOrderToken(this.getOrCreateUser(userId))
  }

  /**
   * Re-read the paper ledger balance into user state. Called after manual
   * credit adjustments so `/api/bot/status` reflects them immediately
   * (otherwise the cached value only moves on the next market tick).
   */
  public syncPaperBalance(userId: string): UserBotState {
    const user = this.getOrCreateUser(userId)
    user.paperBalance = this.orderGateway.getOrCreatePaperAccount(userId).balance
    user.updatedAt = new Date().toISOString()
    this.emitUserUpdate(user)
    this.persistUser(user, true)
    return user
  }

  public startBot(userId: string, executionMode?: 'paper' | 'live'): UserBotState {
    const user = this.getOrCreateUser(userId)

    // Server-side arming gate: a client flipping executionMode:"live" can
    // never place real orders unless the operator set DAEMON_LIVE_ARMED=true
    // in the daemon's environment.
    const requestedMode = executionMode ?? user.executionMode
    if (requestedMode === 'live') {
      this.requireLiveArmed()
    }

    // Every user shares ONE broker token: two active users would place
    // competing orders on the same account. Never double-trade silently.
    const activeOther = Array.from(this.users.values()).find(
      (u) =>
        u.userId !== userId &&
        (u.state === 'RUNNING' || u.state === 'ORDERED'),
    )
    if (activeOther) {
      throw new Error(
        `Cannot start ${userId}: user ${activeOther.userId} is already active (${activeOther.state}). ` +
          `Stop it first — the daemon enforces a single active trader.`,
      )
    }

    if (executionMode) {
      user.executionMode = executionMode
      user.config.executionMode = executionMode
    }
    const hasOpenPosition = Object.values(user.positions).some((p) => p !== null)
    user.state = hasOpenPosition ? 'ORDERED' : 'RUNNING'
    user.error = undefined
    user.updatedAt = new Date().toISOString()
    this.emitUserUpdate(user)
    this.persistUser(user, true)
    return user
  }

  /** Throws unless live trading is explicitly armed on the daemon. */
  private requireLiveArmed(): void {
    if (process.env[TenantManager.LIVE_ARM_ENV] !== 'true') {
      throw new Error(
        `Live trading is not armed: set ${TenantManager.LIVE_ARM_ENV}=true in the daemon environment to enable live orders`,
      )
    }
  }

  public stopBot(userId: string): UserBotState {
    const user = this.getOrCreateUser(userId)
    user.state = 'STOPPED'
    user.updatedAt = new Date().toISOString()
    this.emitUserUpdate(user)
    this.persistUser(user, true)
    return user
  }

  public async manualExit(userId: string, symbol: UnderlyingSymbol, reason = 'Manual exit'): Promise<UserBotState> {
    const user = this.getOrCreateUser(userId)
    const position = user.positions[symbol]
    if (position) {
      const exitPrice = position.currentPrice || position.entryPrice
      await this.orderGateway.exitOrder({
        userId,
        executionMode: user.executionMode,
        token: this.resolveOrderToken(user),
        position,
        exitPrice,
        reason,
      })

      user.positions[symbol] = null
      user.lastExitTimes[symbol] = Date.now()
      this.syncWatchedOptionContracts()
      const hasOtherPositions = Object.values(user.positions).some((p) => p !== null)
      user.state = hasOtherPositions ? 'ORDERED' : (user.state === 'ORDERED' ? 'RUNNING' : user.state)
      user.paperBalance = this.orderGateway.getOrCreatePaperAccount(userId).balance
      user.updatedAt = new Date().toISOString()
      this.emitUserUpdate(user)
      this.persistUser(user, true)
      this.sendExitAlert(user, position, symbol, exitPrice, reason)
    }
    return user
  }

  /**
   * Per-user Upstox token when one was set via POST /api/bot/token.
   * In daemon-only single-account mode (no per-user token) live orders fall
   * back to the master ingestion token refreshed through the OAuth flow.
   */
  private resolveOrderToken(user: UserBotState): string | undefined {
    return user.upstoxToken || this.masterIngestor.getMasterToken()
  }

  private async handleMarketTick(tick: { timestamp: string; snapshots: Record<UnderlyingSymbol, MarketSnapshot> }) {
    const istInfo = getIndiaTime()

    // VIX early warning — once per tick, from the primary symbol's VRD data
    const primarySnapshot = tick.snapshots['NIFTY 50'] ?? Object.values(tick.snapshots)[0]
    if (primarySnapshot?.vrdData) {
      this.checkVixWarning(primarySnapshot.vrdData.vix)
    }

    for (const [userId, user] of this.users.entries()) {
      if (user.state === 'IDLE' || user.state === 'STOPPED') continue

      // Daily rollover check
      if (user.lastTradeDate !== istInfo.dateString) {
        user.lastTradeDate = istInfo.dateString
        user.tradesCountToday = 0
        user.tradesCountPerSymbol = {}
        this.persistUser(user, true)
      }

      const afterCutoff = istInfo.isAfterCutoff(user.config.lastEntryTime || '15:15')

      const targetSymbols: UnderlyingSymbol[] =
        user.config.underlyingMode === 'ALL_PARALLEL'
          ? ['NIFTY 50', 'BANKNIFTY', 'FINNIFTY']
          : [user.config.underlyingMode as UnderlyingSymbol]

      let supervisedAny = false

      for (const symbol of targetSymbols) {
        const snapshot = tick.snapshots[symbol]
        if (!snapshot) continue

        const position = user.positions[symbol]

        // ── 1. Supervise Active Position ─────────────────────────────────────
        if (position) {
          // Update option pricing
          const optionChain = snapshot.optionChain || []
          const optRow = optionChain.find(
            (r) =>
              r.call_options.instrument_key === position.instrumentKey ||
              r.put_options.instrument_key === position.instrumentKey,
          )

          const currentPrice =
            position.direction === 'CE'
              ? optRow?.call_options?.market_data?.ltp || position.currentPrice || position.entryPrice
              : optRow?.put_options?.market_data?.ltp || position.currentPrice || position.entryPrice

          position.currentPrice = currentPrice

          // Track peak favorable price for trailing SL
          if (!position.peakFavorablePrice) {
            position.peakFavorablePrice = currentPrice
          } else {
            position.peakFavorablePrice = position.tradeType === 'selling'
              ? Math.min(position.peakFavorablePrice, currentPrice)
              : Math.max(position.peakFavorablePrice, currentPrice)
          }

          // Calculate unrealized PnL
          const pnlPerUnit =
            position.tradeType === 'selling'
              ? position.entryPrice - currentPrice
              : currentPrice - position.entryPrice
          position.unrealizedPnl = Math.round(pnlPerUnit * position.quantity * 100) / 100
          supervisedAny = true

          // Check EOD auto square-off
          if (afterCutoff) {
            await this.manualExit(userId, symbol, '15:15 EOD Cutoff Square-off')
            continue
          }

          // Check Hard Stop & Trailing Stop Loss triggers
          if (!snapshot.indicators) continue

          const signalData: AllSignalData = {
            v3: snapshot.indicators.ema === 'Buy' ? 'buy' : snapshot.indicators.ema === 'Sell' ? 'sell' : 'hold',
            indicators: snapshot.indicators,
            vrd: snapshot.vrdData || null,
          }

          const hardStop = runHardStopChecks(position, signalData, user.config)
          if (hardStop.triggered) {
            await this.manualExit(userId, symbol, hardStop.reason || 'Hard Stop / Trailing SL')
            continue
          }
        }

        // ── 2. Evaluate New Entry (If no position and before cutoff) ──────────
        if (!position && user.state === 'RUNNING' && !afterCutoff) {
          // CR-11 (candles arm): never enter while the candle buffer is still
          // the boot-time synthetic seeds (or stale) — require a recent
          // successful real-candle backfill. No-op in mock mode.
          if (this.masterIngestor.getEntryBlockers(symbol).length > 0) continue
          const tradesCount = user.tradesCountPerSymbol[symbol] || 0
          if (tradesCount >= user.config.maxTradesPerDay) continue

          const lastExit = user.lastExitTimes[symbol] || 0
          const cooldownMs = (user.config.exitCooldownSec || 60) * 1000
          if (Date.now() - lastExit < cooldownMs) continue

          const signal = snapshot.signal
          if (signal && (signal.signal === 'BUY_CE' || signal.signal === 'BUY_PE')) {
            const direction = signal.signal === 'BUY_CE' ? 'CE' : 'PE'
            const optionChain = snapshot.optionChain || []
            const selectedContract = pickBestOptionContract(optionChain, direction, user.config.otmSkip)

            if (selectedContract && selectedContract.price > 0) {
              const orderRes = await this.orderGateway.placeOrder({
                userId,
                executionMode: user.executionMode,
                token: this.resolveOrderToken(user),
                instrumentKey: selectedContract.instrumentKey,
                direction,
                quantity: selectedContract.lotSize,
                price: selectedContract.price,
                tradeType: user.config.tradeType === 'selling' ? 'selling' : 'buying',
                underlyingSymbol: symbol,
              })

              if (orderRes.success) {
                const chainRow = optionChain.find(
                  (row) =>
                    row.call_options.instrument_key === selectedContract.instrumentKey ||
                    row.put_options.instrument_key === selectedContract.instrumentKey,
                )
                const expiry = chainRow?.expiry
                const newPos: ActivePosition = {
                  instrumentKey: selectedContract.instrumentKey,
                  direction,
                  entryPrice: orderRes.filledPrice,
                  quantity: orderRes.quantity,
                  lotSize: selectedContract.lotSize,
                  entryTime: new Date().toISOString(),
                  tradeId: Date.now(),
                  executionMode: user.executionMode,
                  paperTradeId: orderRes.tradeId,
                  tradeType: user.config.tradeType,
                  currentPrice: orderRes.filledPrice,
                  unrealizedPnl: 0,
                  peakFavorablePrice: orderRes.filledPrice,
                  underlyingSymbol: symbol,
                  strikePrice: selectedContract.strike,
                  expiry,
                }

                user.positions[symbol] = newPos
                user.state = 'ORDERED'
                this.syncWatchedOptionContracts()
                user.tradesCountToday = (user.tradesCountToday || 0) + 1
                user.tradesCountPerSymbol[symbol] = (user.tradesCountPerSymbol[symbol] || 0) + 1
                user.paperBalance = this.orderGateway.getOrCreatePaperAccount(userId).balance
                user.updatedAt = new Date().toISOString()
                this.emitUserUpdate(user)
                this.persistUser(user, true)
                this.sendEntryAlert(user, newPos, symbol, {
                  signal: signal.signal,
                  confidence: signal.confidence,
                  strikePrice: selectedContract.strike,
                  expiry,
                })
              } else {
                user.error = orderRes.error
                this.emitUserUpdate(user)
                this.persistUser(user)
              }
            }
          }
        }
      }

      // Post-cutoff daily summary (skipped while any position is still open)
      if (afterCutoff) {
        this.checkDailySummary(user, istInfo)
      }

      // Persist supervised position updates (peak price, unrealized PnL) — throttled
      if (supervisedAny) {
        this.persistUser(user)
      }
    }
  }

  private emitUserUpdate(user: UserBotState) {
    this.emit('userStateUpdate', { userId: user.userId, state: user })
  }

  /**
   * Keep the live feed subscribed to every open position's option contract so
   * supervision prices update tick-by-tick instead of waiting for the next
   * option-chain refresh. Declarative: recomputed from all users' positions.
   */
  private syncWatchedOptionContracts(): void {
    const keys = new Set<string>()
    for (const user of this.users.values()) {
      for (const position of Object.values(user.positions)) {
        if (position?.instrumentKey) keys.add(position.instrumentKey)
      }
    }
    this.masterIngestor.setWatchedOptionContracts([...keys])
  }

  /**
   * Persist a user's bot state to the durable store.
   * Throttled by default (tick-driven updates); pass immediate=true for
   * critical transitions (start/stop/config/token/entry/exit).
   */
  private persistUser(user: UserBotState, immediate = false): void {
    if (!this.store) return
    const now = Date.now()
    const last = this.lastPersistAt.get(user.userId) ?? 0
    if (!immediate && now - last < 2000) return
    this.lastPersistAt.set(user.userId, now)
    this.store.saveUserState(user)
  }

  private fireAlert(text: string): void {
    if (!this.notifier) return
    void this.notifier(text)
  }

  /**
   * Telegram entry alert — full contract/levels detail so the trade can be
   * mirrored manually in another app. Wording lives in the shared builders.
   */
  private sendEntryAlert(
    user: UserBotState,
    position: ActivePosition,
    symbol: UnderlyingSymbol,
    params: { signal: string; confidence?: string; strikePrice?: number; expiry?: string },
  ): void {
    this.fireAlert(
      buildEntryAlertMessage({
        symbol,
        signal: params.signal,
        confidence: params.confidence,
        executionMode: user.executionMode === 'live' ? 'live' : 'paper',
        strikePrice: params.strikePrice,
        expiry: params.expiry,
        legs: [
          {
            direction: position.direction,
            entryPrice: position.entryPrice,
            quantity: position.quantity,
            lotSize: position.lotSize || 1,
            tradeType: position.tradeType === 'selling' ? 'selling' : 'buying',
          },
        ],
        maxProfitPct: user.config.maxProfitPct,
        maxLossPct: user.config.maxLossPct,
      }),
    )
  }

  /** Telegram exit alert with realized PnL, duration and the exit reason. */
  private sendExitAlert(
    user: UserBotState,
    position: ActivePosition,
    symbol: UnderlyingSymbol,
    exitPrice: number,
    reason: string,
  ): void {
    this.fireAlert(
      buildExitAlertMessage({
        symbol,
        direction: position.direction,
        executionMode: user.executionMode === 'live' ? 'live' : 'paper',
        entryPrice: position.entryPrice,
        exitPrice,
        quantity: position.quantity,
        lotSize: position.lotSize || 1,
        tradeType: position.tradeType === 'selling' ? 'selling' : 'buying',
        reason,
        entryTime: position.entryTime,
        exitTime: new Date().toISOString(),
        strikePrice: position.strikePrice,
        expiry: position.expiry,
      }),
    )
  }

  /**
   * VIX early warning — fires when India VIX crosses the critical threshold,
   * with a 5-minute cooldown on repeats (ported from always-on-daemon).
   */
  private checkVixWarning(vix: number | null | undefined): void {
    if (typeof vix !== 'number' || !Number.isFinite(vix)) return
    const level =
      vix >= VIX_CRITICAL_THRESHOLD ? 'critical' : vix >= VIX_ELEVATED_THRESHOLD ? 'elevated' : 'none'
    if (level === this.vixWarningLevel) return
    this.vixWarningLevel = level
    if (level !== 'critical') return
    const now = Date.now()
    if (now - this.lastVixAlertAt < VIX_CRITICAL_ALERT_COOLDOWN_MS) return
    this.lastVixAlertAt = now
    this.fireAlert(buildVixAlertMessage({ vix, threshold: VIX_HARD_STOP_MAX }))
  }

  /**
   * End-of-day Telegram summary — fires once per date, after the square-off
   * cutoff with no open positions. Ledger values are stored in paise; the
   * summary builder's contract is rupees.
   */
  private checkDailySummary(user: UserBotState, istInfo: { dateString: string }): void {
    if (this.dailySummaryDate === istInfo.dateString) return
    const hasActivePositions = Object.values(user.positions).some((p) => p !== null)
    if (hasActivePositions) return

    this.dailySummaryDate = istInfo.dateString
    try {
      this.store?.setSetting('daily_summary_date', istInfo.dateString)
    } catch {
      // Best effort — a settings write failure must never break the loop.
    }

    const closedTrades = this.orderGateway
      .getPaperTrades(user.userId)
      .filter((t) => t.status === 'CLOSED' && t.closedAt?.startsWith(istInfo.dateString))
    if (closedTrades.length === 0) return

    const wins = closedTrades.filter((t) => (t.realizedPnl ?? 0) > 0)
    const losses = closedTrades.filter((t) => (t.realizedPnl ?? 0) <= 0)
    const realizedPnlPaise = closedTrades.reduce((sum, t) => sum + (t.realizedPnl ?? 0), 0)
    const symbolOf = (t: PaperTradeRecord): string =>
      (t.metadata as { underlyingSymbol?: string } | undefined)?.underlyingSymbol ?? '—'
    const best = wins.length
      ? wins.reduce((a, b) => ((a.realizedPnl ?? 0) >= (b.realizedPnl ?? 0) ? a : b))
      : undefined
    const worst = losses.length
      ? losses.reduce((a, b) => ((a.realizedPnl ?? 0) <= (b.realizedPnl ?? 0) ? a : b))
      : undefined

    this.fireAlert(
      buildDailySummaryMessage({
        date: istInfo.dateString,
        totalTrades: closedTrades.length,
        wins: wins.length,
        losses: losses.length,
        realizedPnl: realizedPnlPaise / 100,
        paperBalance: (user.paperBalance ?? 0) / 100,
        bestTrade: best
          ? { symbol: symbolOf(best), direction: best.direction, pnl: (best.realizedPnl ?? 0) / 100 }
          : undefined,
        worstTrade: worst
          ? { symbol: symbolOf(worst), direction: worst.direction, pnl: (worst.realizedPnl ?? 0) / 100 }
          : undefined,
      }),
    )
  }
}
