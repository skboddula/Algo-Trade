import { EventEmitter } from 'events'
import type {
  UnderlyingSymbol,
  StrategyConfig,
  UserBotState,
  ActivePosition,
  MarketSnapshot,
  AllSignalData,
} from '../types'
import { DEFAULT_STRATEGY_CONFIG } from '../constants'
import { MasterIngestionEngine } from './masterIngestor'
import { OrderGateway } from './orderGateway'
import { pickBestOptionContract } from './syntheticCalculators'
import { runHardStopChecks } from './strategyEngine'
import { getIndiaTime } from '../utils/timeUtils'
import type { StateStore } from './stateStore'
import type { Notifier } from './notifier'

export class TenantManager extends EventEmitter {
  private users: Map<string, UserBotState> = new Map()
  private masterIngestor: MasterIngestionEngine
  private orderGateway: OrderGateway
  private store: StateStore | null
  private notifier?: Notifier
  private lastPersistAt: Map<string, number> = new Map()

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
    this.persistUser(user, true)
    return user
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
        token: user.upstoxToken,
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
      this.fireAlert(`🔵 Algo-Trade: closed ${symbol} position for ${userId} (${reason}) @ ₹${exitPrice}`)
    }
    return user
  }

  private async handleMarketTick(tick: { timestamp: string; snapshots: Record<UnderlyingSymbol, MarketSnapshot> }) {
    const istInfo = getIndiaTime()

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
                this.syncWatchedOptionContracts()
                user.tradesCountToday = (user.tradesCountToday || 0) + 1
                user.tradesCountPerSymbol[symbol] = (user.tradesCountPerSymbol[symbol] || 0) + 1
                user.paperBalance = this.orderGateway.getOrCreatePaperAccount(userId).balance
                user.updatedAt = new Date().toISOString()
                this.emitUserUpdate(user)
                this.persistUser(user, true)
                this.fireAlert(
                  `🟢 Algo-Trade: opened ${symbol} ${direction} for ${userId} ` +
                    `@ ₹${orderRes.filledPrice} × ${orderRes.quantity} (${user.executionMode})`,
                )
              } else {
                user.error = orderRes.error
                this.emitUserUpdate(user)
                this.persistUser(user)
              }
            }
          }
        }
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
}
