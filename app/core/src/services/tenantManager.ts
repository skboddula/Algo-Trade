import { EventEmitter } from 'events'
import type {
  UnderlyingSymbol,
  StrategyConfig,
  UserBotState,
  ActivePosition,
  MarketSnapshot,
  AllSignalData,
  FinalSignal,
  PaperTradeRecord,
  SignalSnapshotRecord,
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
import {
  applyMultiTimeframeFilter,
  getFinalSignal,
  runHardStopChecks,
  shouldExit,
} from './strategyEngine'
import { getIndiaTime } from '../utils/timeUtils'
import type { StateStore } from './stateStore'
import type { Notifier } from './notifier'
import {
  buildDailyLossAlertMessage,
  buildDailySummaryMessage,
  buildEntryAlertMessage,
  buildExitAlertMessage,
  buildVixAlertMessage,
} from '../../../../packages/shared/src/telegram'
import { fetchUpstoxFunds } from '../../../../packages/shared/src/upstoxRest'

/**
 * Best-effort equity (₹) from an Upstox v3 `get-funds-and-margin` payload.
 * Prefers `available_to_trade.total`, falling back to cash + pledge totals.
 */
function extractUpstoxEquity(payload: unknown): number | null {
  const body = (payload as { data?: unknown } | null)?.data ?? payload
  const available = (
    body as {
      available_to_trade?: {
        total?: number
        cash_available_to_trade?: { total?: number }
        pledge_available_to_trade?: { total?: number }
      }
    } | null
  )?.available_to_trade
  if (!available) return null
  if (typeof available.total === 'number' && Number.isFinite(available.total)) {
    return available.total
  }
  const cash = available.cash_available_to_trade?.total
  const pledge = available.pledge_available_to_trade?.total
  if (typeof cash === 'number' || typeof pledge === 'number') {
    return (typeof cash === 'number' ? cash : 0) +
      (typeof pledge === 'number' ? pledge : 0)
  }
  return null
}

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
  // CR-15: a failed critical state write is an operational fault. Live
  // entries are blocked until persistence is healthy again; paper continues
  // in-memory (the fault stays surfaced via getPersistenceFault()).
  private persistenceFault: string | null = null
  /** Throttle fail-closed entry warnings to once/30s per symbol+gate. */
  private lastGateWarnAtMs = new Map<string, number>()
  /**
   * Signal-snapshot dedupe: one row per signal episode/minute, but keep the
   * latest row id so the resulting order can be attached to it.
   */
  private signalSnapshotThrottle = new Map<
    string,
    { fingerprint: string; lastAt: number; id: number }
  >()
  private lastSignalSnapshotWarnAt = 0

  /** Rate-limited operational warning for a fail-closed entry gate. */
  private warnGate(key: string, message: string): void {
    const last = this.lastGateWarnAtMs.get(key) ?? 0
    if (Date.now() - last < 30_000) return
    this.lastGateWarnAtMs.set(key, Date.now())
    console.warn(message)
  }

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
      // CR-15: unreadable rows are skipped rather than failing startup, but
      // they must never pass silently — a skipped row can mean an open
      // position the daemon no longer knows about.
      for (const error of this.store.getLoadErrors()) {
        console.error(`[persistence] skipped unreadable bot_state row — ${error}`)
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

  /** CR-15: current persistence fault, or null when writes are healthy. */
  public getPersistenceFault(): string | null {
    return this.persistenceFault
  }

  /** Newest-first replayable signal snapshots for the analysis/A-B window. */
  public getSignalSnapshots(
    userId: string,
    istDate?: string,
    limit = 200,
  ): SignalSnapshotRecord[] {
    return this.store?.loadSignalSnapshots(userId, istDate, limit) ?? []
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
        realizedPnlToday: 0,
        dayStartEquity: null,
        dayStartEquitySource: null,
        dailyLossTripped: false,
        dailyLossTrippedAt: null,
        updatedAt: istInfo.date.toISOString(),
      }
      this.users.set(userId, user)
      this.persistUser(user, true)
    } else {
      // Rows persisted before the daily-loss switch lack these fields.
      this.normalizeDailyRisk(user)
      // Date rollover check: reset daily counts if new IST trading day
      if (user.lastTradeDate !== istInfo.dateString) {
        user.lastTradeDate = istInfo.dateString
        this.resetDailyState(user)
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
    // A manual paper ledger set/adjust/reset restarts the daily-risk baseline;
    // otherwise a reset would carry a stale day-start equity or tripped flag.
    if (user.executionMode !== 'live') {
      user.realizedPnlToday = 0
      user.dayStartEquity = null
      user.dayStartEquitySource = null
      user.dailyLossTripped = false
      user.dailyLossTrippedAt = null
    }
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
      // CR-15: never start live on top of a broken state store — a restart
      // would not see the positions this session opens.
      if (this.persistenceFault !== null) {
        throw new Error(
          `Live trading blocked: persistence fault (${this.persistenceFault})`,
        )
      }
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
      const exitRes = await this.orderGateway.exitOrder({
        userId,
        executionMode: user.executionMode,
        token: this.resolveOrderToken(user),
        position,
        exitPrice,
        reason,
      })

      // Book the day's realized P&L for the daily loss kill switch. The fill
      // returned by the gateway includes simulated paper slippage.
      if (exitRes.success) {
        const fillPrice = exitRes.filledPrice > 0 ? exitRes.filledPrice : exitPrice
        const pnlPerUnit =
          position.tradeType === 'selling'
            ? position.entryPrice - fillPrice
            : fillPrice - position.entryPrice
        user.realizedPnlToday =
          (user.realizedPnlToday || 0) + Math.round(pnlPerUnit * position.quantity * 100)
      }

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

  /** Backfill daily-risk fields on rows persisted before the kill switch. */
  private normalizeDailyRisk(user: UserBotState): void {
    if (user.realizedPnlToday === undefined) user.realizedPnlToday = 0
    if (user.dayStartEquity === undefined) user.dayStartEquity = null
    if (user.dayStartEquitySource === undefined) user.dayStartEquitySource = null
    if (user.dailyLossTripped === undefined) user.dailyLossTripped = false
    if (user.dailyLossTrippedAt === undefined) user.dailyLossTrippedAt = null
  }

  /** Reset IST-day counters and the daily-risk baseline (date rollover). */
  private resetDailyState(user: UserBotState): void {
    user.tradesCountToday = 0
    user.tradesCountPerSymbol = {}
    user.realizedPnlToday = 0
    user.dayStartEquity = null
    user.dayStartEquitySource = null
    user.dailyLossTripped = false
    user.dailyLossTrippedAt = null
  }

  /**
   * Daily loss kill switch (mark-to-market, IST day). Runs once per market
   * tick per user:
   *  1. Captures the day-start equity base on the first tick of the day.
   *  2. Trips when realized-today + open-position unrealized falls to
   *     −maxDailyLossPct% of that base. Sticky until the next IST day.
   *
   * Open positions keep running their own stops — only new entries are
   * blocked, so a bad day cannot compound through fresh trades.
   */
  private async updateDailyRisk(user: UserBotState): Promise<void> {
    if (user.dailyLossTripped) return
    const pct = user.config.maxDailyLossPct
    if (pct === undefined || pct <= 0) return

    if (user.dayStartEquity == null) {
      await this.captureDayStartEquity(user)
      if (user.dayStartEquity == null) return
    }

    const unrealizedPaise = Object.values(user.positions).reduce(
      (sum, position) => sum + (position?.unrealizedPnl || 0),
      0,
    )
    const dayPnlPaise = (user.realizedPnlToday || 0) + unrealizedPaise
    const limitPaise = -(pct / 100) * user.dayStartEquity
    if (dayPnlPaise > limitPaise) return

    user.dailyLossTripped = true
    user.dailyLossTrippedAt = new Date().toISOString()
    this.persistUser(user, true)
    console.warn(
      `[daily-loss] ${user.userId}: MTM day P&L ₹${(dayPnlPaise / 100).toFixed(2)} hit the ` +
        `−${pct}% limit (base ₹${(user.dayStartEquity / 100).toFixed(2)}, ` +
        `source ${user.dayStartEquitySource}) — entries blocked for the day`,
    )
    this.sendDailyLossAlert(user, dayPnlPaise)
  }

  /**
   * Snapshot today's equity base for the daily loss kill switch.
   * Paper: the local ledger. Live: Upstox funds (available-to-trade total).
   * If live equity is unavailable the paper ledger is used as a visibly
   * tagged fallback (`paper-fallback`) rather than leaving the day ungated.
   */
  private async captureDayStartEquity(user: UserBotState): Promise<void> {
    if (user.executionMode !== 'live') {
      user.dayStartEquity = user.paperBalance
      user.dayStartEquitySource = 'paper-ledger'
      this.persistUser(user, true)
      return
    }

    const token = this.resolveOrderToken(user)
    if (token) {
      try {
        const { status, data } = await fetchUpstoxFunds(token, 10_000)
        const equityRupees =
          status >= 200 && status < 300 ? extractUpstoxEquity(data) : null
        if (equityRupees !== null && equityRupees > 0) {
          user.dayStartEquity = Math.round(equityRupees * 100)
          user.dayStartEquitySource = 'upstox-funds'
          this.persistUser(user, true)
          return
        }
      } catch (err) {
        console.warn(
          `[daily-loss] ${user.userId}: funds fetch failed — ${(err as Error).message}`,
        )
      }
    }

    user.dayStartEquity = user.paperBalance
    user.dayStartEquitySource = 'paper-fallback'
    console.warn(
      `[daily-loss] ${user.userId}: live equity unavailable — using the paper ledger as the daily-loss base`,
    )
    this.persistUser(user, true)
  }

  private sendDailyLossAlert(user: UserBotState, dayPnlPaise: number): void {
    this.fireAlert(
      buildDailyLossAlertMessage({
        dayPnl: dayPnlPaise / 100,
        dayStartEquity: (user.dayStartEquity ?? 0) / 100,
        limitPct: user.config.maxDailyLossPct ?? 0,
        source: user.dayStartEquitySource ?? 'unknown',
      }),
    )
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
        this.resetDailyState(user)
        this.persistUser(user, true)
      }

      // Two independent cutoffs: entries close at lastEntryTime; open
      // positions are squared off at squareOffTime (later — aligned with
      // the NSE 15:40 derivatives close).
      const afterEntryCutoff = istInfo.isAfterCutoff(user.config.lastEntryTime || '15:15')
      const afterSquareOff = istInfo.isAfterCutoff(user.config.squareOffTime || '15:35')

      // ── Market-hours guard (NSE: Mon–Fri, 09:15–15:40 IST, minus holidays) ─
      // Weekend/off-hours/holiday snapshots are the previous session's frozen
      // data: signals computed on them are meaningless, and a position held
      // while the market is closed cannot be managed — square it off
      // immediately and never evaluate new entries.
      if (!istInfo.isMarketHours) {
        for (const symbol of Object.keys(user.positions) as UnderlyingSymbol[]) {
          if (user.positions[symbol]) {
            await this.manualExit(
              userId,
              symbol,
              'Market closed — position held outside trading hours',
            )
          }
        }
        continue
      }

      // Daily loss kill switch: capture the day-start equity base and trip
      // when MTM day P&L crosses the configured limit (sticky for the day).
      await this.updateDailyRisk(user)

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

          // Check EOD auto square-off (at squareOffTime — independent of
          // the entry cutoff)
          if (afterSquareOff) {
            const squareOffLabel = user.config.squareOffTime || '15:35'
            await this.manualExit(userId, symbol, `EOD Square-off (${squareOffLabel})`)
            continue
          }

          // Check Hard Stop & Trailing Stop Loss triggers
          if (!snapshot.indicators) continue

          const signalData: AllSignalData = {
            v3: snapshot.indicators.ema === 'Buy' ? 'buy' : snapshot.indicators.ema === 'Sell' ? 'sell' : 'hold',
            indicators: snapshot.indicators,
            vrd: snapshot.vrdData || null,
          }

          const exitDecision = shouldExit(position, signalData, currentPrice, user.config)
          if (exitDecision.exit) {
            await this.manualExit(userId, symbol, exitDecision.reason || 'Hard Stop / Trailing SL')
            continue
          }
        }

        // ── 2. Evaluate New Entry (If no position and before cutoff) ──────────
        // CR-03: STOPPED bots never enter. CR-14: ORDERED bots CAN enter on
        // their remaining symbols (ALL_PARALLEL semantics — the per-symbol
        // `position` check above is the duplicate guard).
        const entriesEnabled = user.state === 'RUNNING' || user.state === 'ORDERED'
        if (!position && entriesEnabled && !afterEntryCutoff) {
          // Resolve the entry signal with THIS user's config. The master
          // snapshot's `signal` is the default-config reference; the
          // unfiltered twin lets us honour `useMultiTimeframe:false` without
          // rerunning V3/VRD assembly.
          const entryIndicators = snapshot.indicators
          const higherTimeframeTrend = entryIndicators?.higherTimeframeTrend
          const baseSignal = snapshot.unfilteredSignal ?? snapshot.signal
          if (!baseSignal) continue
          const canRecompute = Boolean(entryIndicators && snapshot.unfilteredSignal)
          const entrySignalData: AllSignalData | null = entryIndicators
            ? {
                v3: snapshot.v3 ?? snapshot.signal?.v3 ?? 'hold',
                indicators: entryIndicators,
                vrd: snapshot.vrdData ?? null,
                globalIndices: snapshot.globalIndices,
              }
            : null

          const userSignal: FinalSignal =
            canRecompute && entrySignalData
              ? getFinalSignal(entrySignalData, user.config)
              : applyMultiTimeframeFilter(
                  baseSignal,
                  higherTimeframeTrend,
                  user.config.useMultiTimeframe !== false,
                )
          const unfilteredSignal: FinalSignal =
            canRecompute && entrySignalData
              ? getFinalSignal(entrySignalData, {
                  ...user.config,
                  useMultiTimeframe: false,
                })
              : baseSignal

          const userFilterEnabled = user.config.useMultiTimeframe !== false
          const htfVetoed =
            userFilterEnabled &&
            Boolean(higherTimeframeTrend) &&
            ((unfilteredSignal.signal === 'BUY_CE' &&
              higherTimeframeTrend === 'Sell') ||
              (unfilteredSignal.signal === 'BUY_PE' &&
                higherTimeframeTrend === 'Buy'))
          const filterVerdict: SignalSnapshotRecord['filterVerdict'] =
            !higherTimeframeTrend
              ? 'not-applicable'
              : !userFilterEnabled
                ? 'off'
                : htfVetoed
                  ? 'vetoed'
                  : userSignal.signal === 'BUY_CE' ||
                      userSignal.signal === 'BUY_PE'
                    ? 'allowed'
                    : 'not-applicable'
          const entryEligible =
            userSignal.signal === 'BUY_CE' || userSignal.signal === 'BUY_PE'
          const candidate =
            entryEligible ||
            unfilteredSignal.signal === 'BUY_CE' ||
            unfilteredSignal.signal === 'BUY_PE' ||
            userSignal.confidence !== 'none' ||
            unfilteredSignal.confidence !== 'none'

          const lastExit = user.lastExitTimes[symbol] || 0
          const cooldownMs = (user.config.exitCooldownSec || 60) * 1000
          const context: SignalSnapshotRecord['context'] = {
            tradesCountToday: user.tradesCountToday || 0,
            tradesCountPerSymbol: user.tradesCountPerSymbol[symbol] || 0,
            dailyLossTripped: user.dailyLossTripped === true,
            cooldownRemainingMs: Math.max(
              0,
              cooldownMs - (Date.now() - lastExit),
            ),
            entryBlockedReasons:
              snapshot.sources?.entryBlockedReasons ?? [],
            sentimentFault: snapshot.sources?.sentimentFault ?? null,
            persistenceFault: this.persistenceFault,
          }
          const blockedReason = this.describeEntryBlock(
            user,
            snapshot,
            entryEligible,
            htfVetoed,
          )
          let signalSnapshotId: number | null = null
          if (candidate && entrySignalData) {
            signalSnapshotId = this.logSignalSnapshot({
              userId,
              symbol,
              capturedAt: snapshot.timestamp,
              istDate: getIndiaTime(new Date(snapshot.timestamp)).dateString,
              executionMode: user.executionMode,
              botState: user.state,
              spotPrice: snapshot.spotPrice,
              config: { ...user.config },
              data: entrySignalData,
              defaultSignal: snapshot.signal,
              userSignal,
              unfilteredSignal,
              higherTimeframeTrend,
              entryEligible,
              filterVerdict,
              blockedReason,
              context,
              sources: snapshot.sources,
            })
          }

          // Daily loss kill switch: sticky for the rest of the IST day.
          if (user.dailyLossTripped) {
            this.warnGate(
              `${symbol}:daily-loss`,
              `[daily-loss] [${symbol}] Entry blocked — ${user.config.maxDailyLossPct}% daily loss limit reached`,
            )
            continue
          }

          // CR-15 (entry path): a failed state write means the persisted state
          // no longer matches reality. Block new LIVE entries until writes
          // recover; paper entries continue in-memory (the fault is surfaced).
          if (user.executionMode === 'live' && this.persistenceFault !== null) continue

          // Fail-closed sentiment gate: LIVE entries require fresh live VRD +
          // India VIX. Paper staging continues on the deterministic fallback.
          if (user.executionMode === 'live') {
            const sentimentFault = snapshot.sources?.sentimentFault
            if (sentimentFault) {
              this.warnGate(
                `${symbol}:sentiment`,
                `[sentiment] [${symbol}] LIVE entry blocked — ${sentimentFault}`,
              )
              continue
            }
          }

          // CR-14: optional GLOBAL cap across all symbols for the day
          // (unset = off; per-symbol maxTradesPerDay still applies below).
          const totalCap = user.config.maxTotalTradesPerDay
          if (totalCap !== undefined && (user.tradesCountToday || 0) >= totalCap) continue

          // CR-11: never enter on stale data — the ingestor stamps
          // snapshot.sources each tick (quote / candles / chain freshness)
          // and the blocker list is empty in mock mode.
          const blockers = snapshot.sources?.entryBlockedReasons
          if (blockers && blockers.length > 0) continue
          const tradesCount = user.tradesCountPerSymbol[symbol] || 0
          if (tradesCount >= user.config.maxTradesPerDay) continue

          if (Date.now() - lastExit < cooldownMs) continue

          if (entryEligible) {
            // Entry hard-stop gate (reference parity): the VIX tradeability
            // band + high-severity macro news block new entries entirely.
            const hardStop = runHardStopChecks(snapshot.vrdData ?? null)
            if (hardStop.blocked) {
              this.warnGate(
                `${symbol}:hard-stop`,
                `[hard-stop] [${symbol}] Entry blocked: ${hardStop.reasons.join('; ')}`,
              )
              continue
            }
            const direction = userSignal.signal === 'BUY_CE' ? 'CE' : 'PE'
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
                this.updateSignalSnapshotOutcome(signalSnapshotId, {
                  orderPlaced: true,
                  tradeId: orderRes.tradeId,
                  instrumentKey: selectedContract.instrumentKey,
                  entryPrice: orderRes.filledPrice,
                  blockedReason: null,
                })
                this.sendEntryAlert(user, newPos, symbol, {
                  signal: userSignal.signal,
                  confidence: userSignal.confidence,
                  strikePrice: selectedContract.strike,
                  expiry,
                })
              } else {
                this.updateSignalSnapshotOutcome(signalSnapshotId, {
                  orderPlaced: false,
                  blockedReason: `order-failed: ${orderRes.error ?? 'unknown'}`,
                })
                user.error = orderRes.error
                this.emitUserUpdate(user)
                this.persistUser(user)
              }
            } else {
              this.updateSignalSnapshotOutcome(signalSnapshotId, {
                orderPlaced: false,
                blockedReason: 'no-contract',
              })
            }
          }
        }
      }

      // Daily summary after the square-off cutoff (skipped while any position is still open)
      if (afterSquareOff) {
        this.checkDailySummary(user, istInfo)
      }

      // Persist supervised position updates (peak price, unrealized PnL) — throttled
      if (supervisedAny) {
        this.persistUser(user)
      }
    }
  }

  /**
   * First gate that would stop an actionable signal, for the snapshot row.
   * Telemetry only — the real gates below remain authoritative.
   */
  private describeEntryBlock(
    user: UserBotState,
    snapshot: MarketSnapshot,
    entryEligible: boolean,
    htfVetoed: boolean,
  ): string | undefined {
    if (user.dailyLossTripped) return 'daily-loss'
    if (user.executionMode === 'live' && this.persistenceFault !== null) {
      return 'persistence-fault'
    }
    if (user.executionMode === 'live' && snapshot.sources?.sentimentFault) {
      return 'sentiment-fault'
    }
    const totalCap = user.config.maxTotalTradesPerDay
    if (totalCap !== undefined && (user.tradesCountToday || 0) >= totalCap) {
      return 'total-cap'
    }
    const blockers = snapshot.sources?.entryBlockedReasons
    if (blockers && blockers.length > 0) {
      return `stale-data: ${blockers.join('; ')}`
    }
    const symbol = snapshot.underlyingSymbol
    const tradesCount = user.tradesCountPerSymbol[symbol] || 0
    if (tradesCount >= user.config.maxTradesPerDay) return 'symbol-cap'
    const lastExit = user.lastExitTimes[symbol] || 0
    const cooldownMs = (user.config.exitCooldownSec || 60) * 1000
    if (Date.now() - lastExit < cooldownMs) return 'cooldown'
    if (!entryEligible) return htfVetoed ? 'htf-veto' : 'no-entry-signal'
    const hardStop = runHardStopChecks(snapshot.vrdData ?? null)
    if (hardStop.blocked) {
      return `hard-stop: ${hardStop.reasons.join('; ')}`
    }
    return undefined
  }

  /**
   * Persist a signal snapshot at most once per minute per user+symbol for an
   * unchanged decision fingerprint. Returns the row id so a placed order can
   * be attached to the same episode. Never throws into the trading path.
   */
  private logSignalSnapshot(record: SignalSnapshotRecord): number | null {
    if (!this.store) return null
    const key = `${record.userId}:${record.symbol}`
    const fingerprint = JSON.stringify({
      signal: record.userSignal.signal,
      confidence: record.userSignal.confidence,
      bull: record.userSignal.bullScore,
      bear: record.userSignal.bearScore,
      unfiltered: record.unfilteredSignal.signal,
      unfilteredConfidence: record.unfilteredSignal.confidence,
      ht: record.higherTimeframeTrend,
      filter: record.config.useMultiTimeframe !== false,
      blocked: record.blockedReason,
      spot: Math.round(record.spotPrice),
    })
    const now = Date.now()
    const previous = this.signalSnapshotThrottle.get(key)
    if (
      previous &&
      previous.fingerprint === fingerprint &&
      now - previous.lastAt < 60_000
    ) {
      return previous.id
    }
    try {
      const id = this.store.saveSignalSnapshot(record)
      this.signalSnapshotThrottle.set(key, {
        fingerprint,
        lastAt: now,
        id,
      })
      return id
    } catch (err) {
      if (now - this.lastSignalSnapshotWarnAt > 60_000) {
        this.lastSignalSnapshotWarnAt = now
        console.warn(
          `[signal-snapshot] write failed (entry path unaffected): ${(err as Error).message}`,
        )
      }
      return null
    }
  }

  /** Best-effort attach of the order outcome to a snapshot row. */
  private updateSignalSnapshotOutcome(
    id: number | null,
    patch: {
      orderPlaced?: boolean
      tradeId?: string | null
      instrumentKey?: string | null
      entryPrice?: number | null
      blockedReason?: string | null
    },
  ): void {
    if (id === null || !this.store) return
    try {
      this.store.updateSignalSnapshot(id, patch)
    } catch (err) {
      const now = Date.now()
      if (now - this.lastSignalSnapshotWarnAt > 60_000) {
        this.lastSignalSnapshotWarnAt = now
        console.warn(
          `[signal-snapshot] outcome update failed (entry path unaffected): ${(err as Error).message}`,
        )
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
    try {
      this.store.saveUserState(user)
      if (this.persistenceFault !== null) {
        this.persistenceFault = null
        console.info('[persistence] user-state writes healthy again')
      }
    } catch (err) {
      const message = (err as Error).message
      // Log once per fault episode (the gate blocks on every tick silently).
      if (this.persistenceFault === null) {
        console.error(
          `[persistence] CRITICAL: user-state save FAILED — live entries blocked until resolved: ${message}`,
        )
      }
      this.persistenceFault = `user-state save failed: ${message}`
    }
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
