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
import { DEFAULT_STRATEGY_CONFIG } from '../constants'
import { MasterIngestionEngine } from './masterIngestor'
import { OrderGateway } from './orderGateway'
import { pickBestOptionContract } from './syntheticCalculators'
import { runHardStopChecks } from './strategyEngine'
import { getIndiaTime } from '../utils/timeUtils'
import {
  getTelegramConfig,
  sendTelegramMessage,
  formatEntryAlert,
  formatExitAlert,
  formatVixAlert,
  formatDailySummary,
  type TelegramConfig,
} from './telegramAlerts'
import { UpstoxMarketStream, type StreamTick } from './marketStream'
import { loadState, saveState } from '../utils/store'

export class TenantManager extends EventEmitter {
  private users: Map<string, UserBotState> = new Map()
  private masterIngestor: MasterIngestionEngine
  private orderGateway: OrderGateway
  private telegramConfig: TelegramConfig | null
  private vixWarningLevel: 'none' | 'elevated' | 'critical' = 'none'
  private lastVixAlertAt: number = 0
  private dailySummaryDate: string | null = null
  private marketStream: UpstoxMarketStream

  constructor(masterIngestor: MasterIngestionEngine, orderGateway: OrderGateway) {
    super()
    this.setMaxListeners(100)
    this.masterIngestor = masterIngestor
    this.orderGateway = orderGateway
    this.telegramConfig = getTelegramConfig()

    // Initialize the WebSocket market stream for tick-level prices + VIX
    this.marketStream = new UpstoxMarketStream({
      getToken: () => masterIngestor.getPrimaryToken(),
    })
    this.marketStream.on('tick', (tick: StreamTick) => {
      this.handleStreamTick(tick)
    })
    this.marketStream.on('status', (status, detail) => {
      if (status === 'open') {
        console.log('[stream] Upstox market stream connected — tick-level prices active')
      } else if (status === 'closed' && detail) {
        console.warn(`[stream] ${detail}`)
      }
    })
    this.marketStream.start()

    // Restore user states from disk
    this.restoreUserStates()

    // Bind to master market ticks (REST polling — fallback/supplement to the stream)
    this.masterIngestor.on('marketTick', (tick) => {
      this.handleMarketTick(tick).catch((err) => {
        this.emit('error', err)
      })
    })
  }

  /** Applies streamed tick-level prices to open positions in real time. */
  private handleStreamTick(tick: StreamTick): void {
    // Skip VIX ticks (handled by getStreamedVix)
    if (tick.instrumentKey === 'NSE_INDEX|India VIX') return

    for (const user of this.users.values()) {
      if (user.state !== 'RUNNING' && user.state !== 'ORDERED') continue
      for (const position of Object.values(user.positions)) {
        if (!position || position.instrumentKey !== tick.instrumentKey) continue

        // Update current price and peak from the streamed tick
        const prevPrice = position.currentPrice ?? position.entryPrice
        position.currentPrice = tick.ltp

        // Track peak favorable price (buying: max, selling: min)
        if (position.tradeType === 'selling') {
          position.peakFavorablePrice = position.peakFavorablePrice === undefined
            ? tick.ltp
            : Math.min(position.peakFavorablePrice, tick.ltp)
        } else {
          position.peakFavorablePrice = position.peakFavorablePrice === undefined
            ? tick.ltp
            : Math.max(position.peakFavorablePrice, tick.ltp)
        }

        // Recalculate unrealized PnL
        const pnlPerUnit = position.tradeType === 'selling'
          ? position.entryPrice - tick.ltp
          : tick.ltp - position.entryPrice
        position.unrealizedPnl = Math.round(pnlPerUnit * position.quantity * 100) / 100

        // Only emit an update if the price changed meaningfully (>0.1%)
        if (Math.abs(tick.ltp - prevPrice) / (prevPrice || 1) > 0.001) {
          user.updatedAt = new Date().toISOString()
          this.emitUserUpdate(user)
        }
      }
    }
  }

  /** Syncs the stream subscriptions to all held position keys + India VIX. */
  private syncStreamSubscriptions(): void {
    const keys = new Set<string>(['NSE_INDEX|India VIX'])
    for (const user of this.users.values()) {
      for (const position of Object.values(user.positions)) {
        if (position?.instrumentKey) keys.add(position.instrumentKey)
      }
    }
    this.marketStream.setSubscriptions(Array.from(keys))
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
    } else {
      // Date rollover check: reset daily counts if new IST trading day
      if (user.lastTradeDate !== istInfo.dateString) {
        user.lastTradeDate = istInfo.dateString
        user.tradesCountToday = 0
        user.tradesCountPerSymbol = {}
      }
      const paperAccount = this.orderGateway.getOrCreatePaperAccount(userId)
      user.paperBalance = paperAccount.balance
    }
    return user
  }

  public updateConfig(userId: string, config: Partial<StrategyConfig>): UserBotState {
    const user = this.getOrCreateUser(userId)
    user.config = { ...user.config, ...config }
    user.executionMode = user.config.executionMode
    user.updatedAt = new Date().toISOString()
    this.emitUserUpdate(user)
    return user
  }

  public setToken(userId: string, token: string): UserBotState {
    const user = this.getOrCreateUser(userId)
    user.upstoxToken = token
    user.updatedAt = new Date().toISOString()
    this.emitUserUpdate(user)
    return user
  }

  public startBot(userId: string, executionMode?: 'paper' | 'live'): UserBotState {
    const user = this.getOrCreateUser(userId)
    if (executionMode) {
      user.executionMode = executionMode
      user.config.executionMode = executionMode
    }
    const hasOpenPosition = Object.values(user.positions).some((p) => p !== null)
    user.state = hasOpenPosition ? 'ORDERED' : 'RUNNING'
    user.error = undefined
    user.updatedAt = new Date().toISOString()
    this.emitUserUpdate(user)
    this.persistUserStates()
    return user
  }

  public stopBot(userId: string): UserBotState {
    const user = this.getOrCreateUser(userId)
    user.state = 'STOPPED'
    user.updatedAt = new Date().toISOString()
    this.emitUserUpdate(user)
    this.persistUserStates()
    return user
  }

  /** Stops the WebSocket market stream — called on server shutdown. */
  public shutdown(): void {
    this.marketStream.stop()
    this.persistUserStates()
  }

  /** Restores user bot states from disk on startup. */
  private restoreUserStates(): void {
    const saved = loadState<Record<string, UserBotState>>('user_states')
    if (!saved) return
    for (const [userId, state] of Object.entries(saved)) {
      this.users.set(userId, state)
      console.log(
        `[tenantManager] Restored user ${userId}: state=${state.state}, positions=${Object.values(state.positions).filter(Boolean).length}`,
      )
    }
  }

  /** Persists all user bot states to disk (call after significant changes). */
  private persistUserStates(): void {
    const states: Record<string, UserBotState> = {}
    for (const [userId, state] of this.users.entries()) {
      states[userId] = state
    }
    saveState('user_states', states)
  }

  public async manualExit(userId: string, symbol: UnderlyingSymbol, reason = 'Manual exit'): Promise<UserBotState> {
    const user = this.getOrCreateUser(userId)
    const position = user.positions[symbol]
    if (position) {
      const exitPrice = position.currentPrice || position.entryPrice
      await this.orderGateway.exitOrder({
        userId,
        executionMode: user.executionMode,
        token: user.upstoxToken,
        position,
        exitPrice,
        reason,
      })

      // Send Telegram exit alert
      this.sendExitAlert(user, position, symbol, exitPrice, reason)

      user.positions[symbol] = null
      user.lastExitTimes[symbol] = Date.now()
      const hasOtherPositions = Object.values(user.positions).some((p) => p !== null)
      user.state = hasOtherPositions ? 'ORDERED' : (user.state === 'ORDERED' ? 'RUNNING' : user.state)
      user.paperBalance = this.orderGateway.getOrCreatePaperAccount(userId).balance
      user.updatedAt = new Date().toISOString()
      this.emitUserUpdate(user)
      this.syncStreamSubscriptions()
      this.persistUserStates()
    }
    return user
  }

  /** Sends a Telegram entry alert after a successful order placement. */
  private sendEntryAlert(
    user: UserBotState,
    position: ActivePosition,
    symbol: UnderlyingSymbol,
    selectedContract: { strikePrice?: number; expiry?: string },
  ): void {
    if (!this.telegramConfig) return
    const message = formatEntryAlert({
      symbol,
      signal: position.direction === 'CE' ? 'BUY_CE' : 'BUY_PE',
      confidence: 'moderate',
      executionMode: user.executionMode === 'live' ? 'live' : 'paper',
      strikePrice: selectedContract.strikePrice,
      expiry: selectedContract.expiry,
      entryPrice: position.entryPrice,
      quantity: position.quantity,
      lotSize: position.lotSize || 1,
      tradeType: position.tradeType === 'selling' ? 'selling' : 'buying',
      maxProfitPct: user.config.maxProfitPct,
      maxLossPct: user.config.maxLossPct,
      trailPct: user.config.trailPct,
    })
    sendTelegramMessage(this.telegramConfig, message).catch(() => {})
  }

  /** Sends a Telegram exit alert with PnL details. */
  private sendExitAlert(
    user: UserBotState,
    position: ActivePosition,
    symbol: UnderlyingSymbol,
    exitPrice: number,
    reason: string,
  ): void {
    if (!this.telegramConfig) return
    const message = formatExitAlert({
      symbol,
      direction: position.direction === 'CE' ? 'CE' : 'PE',
      executionMode: user.executionMode === 'live' ? 'live' : 'paper',
      entryPrice: position.entryPrice,
      exitPrice,
      quantity: position.quantity,
      lotSize: position.lotSize || 1,
      tradeType: position.tradeType === 'selling' ? 'selling' : 'buying',
      reason,
      entryTime: position.entryTime,
      exitTime: new Date().toISOString(),
    })
    sendTelegramMessage(this.telegramConfig, message).catch(() => {})
  }

  /** Sends a VIX early warning when thresholds are crossed (with 5-min cooldown). */
  private checkVixWarning(vrdData: { vix?: number | null } | null | undefined): void {
    if (!this.telegramConfig) return
    // Prefer tick-level streamed VIX over the REST-polled value
    const streamedVix = this.marketStream.getStreamedVix()
    const vix = streamedVix ?? vrdData?.vix
    if (!vix || !Number.isFinite(vix)) return
    const level = vix >= 24 ? 'critical' : vix >= 18 ? 'elevated' : 'none'
    if (level === this.vixWarningLevel) return

    this.vixWarningLevel = level
    if (level === 'critical') {
      const now = Date.now()
      if (now - this.lastVixAlertAt < 5 * 60000) return // 5-min cooldown
      this.lastVixAlertAt = now
      sendTelegramMessage(
        this.telegramConfig,
        formatVixAlert({ vix, threshold: 25 }),
      ).catch(() => {})
    }
  }

  /** Sends a daily summary after EOD when all positions are closed. */
  private checkDailySummary(user: UserBotState, istInfo: { dateString: string }): void {
    if (!this.telegramConfig) return
    if (this.dailySummaryDate === istInfo.dateString) return

    const hasActivePositions = Object.values(user.positions).some((p) => p !== null)
    if (hasActivePositions) return

    // Only send after cutoff
    this.dailySummaryDate = istInfo.dateString

    const allTrades = this.orderGateway.getPaperTrades(user.userId)
    const closedTrades = allTrades.filter(
      (t) => t.status === 'CLOSED' && t.closedAt?.startsWith(istInfo.dateString),
    )
    if (closedTrades.length === 0) return

    const wins = closedTrades.filter((t) => (t.realizedPnl ?? 0) > 0)
    const losses = closedTrades.filter((t) => (t.realizedPnl ?? 0) <= 0)
    const realizedPnl = closedTrades.reduce((s, t) => s + (t.realizedPnl ?? 0), 0)
    const best = wins.length ? wins.reduce((a, b) => ((a.realizedPnl ?? 0) >= (b.realizedPnl ?? 0) ? a : b)) : undefined
    const worst = losses.length ? losses.reduce((a, b) => ((a.realizedPnl ?? 0) <= (b.realizedPnl ?? 0) ? a : b)) : undefined

    const getSymbol = (t: PaperTradeRecord): string => {
      const meta = t.metadata as { underlyingSymbol?: string } | undefined
      return meta?.underlyingSymbol ?? '—'
    }

    const message = formatDailySummary({
      date: istInfo.dateString,
      totalTrades: closedTrades.length,
      wins: wins.length,
      losses: losses.length,
      realizedPnl,
      paperBalance: user.paperBalance,
      bestTrade: best ? { symbol: getSymbol(best), direction: best.direction, pnl: best.realizedPnl ?? 0 } : undefined,
      worstTrade: worst ? { symbol: getSymbol(worst), direction: worst.direction, pnl: worst.realizedPnl ?? 0 } : undefined,
    })
    sendTelegramMessage(this.telegramConfig, message).catch(() => {})
  }

  private async handleMarketTick(tick: { timestamp: string; snapshots: Record<UnderlyingSymbol, MarketSnapshot> }) {
    const istInfo = getIndiaTime()

    // Check VIX early warning once per tick (uses primary symbol's VRD data)
    const primarySnapshot = tick.snapshots['NIFTY 50'] ?? Object.values(tick.snapshots)[0]
    if (primarySnapshot?.vrdData) {
      this.checkVixWarning(primarySnapshot.vrdData)
    }

    for (const [userId, user] of this.users.entries()) {
      if (user.state === 'IDLE' || user.state === 'STOPPED') continue

      // Daily rollover check
      if (user.lastTradeDate !== istInfo.dateString) {
        user.lastTradeDate = istInfo.dateString
        user.tradesCountToday = 0
        user.tradesCountPerSymbol = {}
      }

      const afterCutoff = istInfo.isAfterCutoff(user.config.lastEntryTime || '15:15')

      const targetSymbols: UnderlyingSymbol[] =
        user.config.underlyingMode === 'ALL_PARALLEL'
          ? ['NIFTY 50', 'BANKNIFTY', 'FINNIFTY']
          : [user.config.underlyingMode as UnderlyingSymbol]

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
                token: user.upstoxToken,
                instrumentKey: selectedContract.instrumentKey,
                direction,
                quantity: selectedContract.lotSize,
                price: selectedContract.price,
                tradeType: user.config.tradeType === 'selling' ? 'selling' : 'buying',
                underlyingSymbol: symbol,
              })

              if (orderRes.success) {
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
                }

                user.positions[symbol] = newPos
                user.state = 'ORDERED'
                user.tradesCountToday = (user.tradesCountToday || 0) + 1
                user.tradesCountPerSymbol[symbol] = (user.tradesCountPerSymbol[symbol] || 0) + 1
                user.paperBalance = this.orderGateway.getOrCreatePaperAccount(userId).balance
                user.updatedAt = new Date().toISOString()
                this.emitUserUpdate(user)
                this.syncStreamSubscriptions()
                this.persistUserStates()

                // Send Telegram entry alert
                this.sendEntryAlert(user, newPos, symbol, {
                  strikePrice: selectedContract.strike,
                })
              } else {
                user.error = orderRes.error
                this.emitUserUpdate(user)
              }
            }
          }
        }
      }

      // After all symbols processed: check daily summary (after EOD, no positions)
      if (afterCutoff) {
        this.checkDailySummary(user, istInfo)
      }
    }
  }

  private emitUserUpdate(user: UserBotState) {
    this.emit('userStateUpdate', { userId: user.userId, state: user })
  }
}
