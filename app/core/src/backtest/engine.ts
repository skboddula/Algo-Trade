import type {
  ActivePosition,
  AllSignalData,
  FinalSignal,
  SignalType,
  StrategyConfig,
  UnderlyingSymbol,
  V3OrderType,
} from '../../../../packages/shared/src/types'
import { DEFAULT_CONFIG } from '../../../../packages/shared/src/types'
import {
  ORDER_TYPE_BUY,
  ORDER_TYPE_SELL,
  SIGNAL_BUY,
  SIGNAL_BUY_CE,
  SIGNAL_BUY_PE,
  SIGNAL_SELL,
} from '../../../../packages/shared/src/constants'
import { buildHtfCandleHistory } from '../../../../packages/shared/src/candleHistory'
import {
  applySlippage,
  calculateOptionCharges,
  costRatesFor,
} from './costs'
import {
  optionKey,
  selectOptionContract,
  seriesAtOrBefore,
  seriesFirstAtOrAfter,
} from './contracts'
import { getFinalSignal, runHardStopChecks, shouldExit } from '../services/strategyEngine'
import type { MacroSeries } from './data/macro'
import { ReconstructedSignalSource } from './signal'
import {
  MARKET_CLOSE_MINUTE,
  isTradingDate,
  parseHm,
  round2,
  istMinute,
} from './time'
import type {
  CostRates,
  MacroDay,
  OptionBar,
  OptionCharges,
  OptionSeries,
  ReplayCoverage,
  ReplayDataset,
  ReplayDayResult,
  ReplayMetrics,
  ReplayResult,
  ReplayRunOptions,
  ReplaySignalSource,
  ReplayTrade,
  SignalCounters,
} from './types'

interface OpenPosition {
  id: string
  date: string
  symbol: UnderlyingSymbol
  expiry: string
  strike: number
  direction: 'CE' | 'PE'
  instrumentKey: string
  lots: number
  lotSize: number
  quantity: number
  series: OptionSeries
  entryTime: string
  entryMinute: number
  entrySignalMinute: number
  entryRawPrice: number
  entryPrice: number
  entrySpot: number
  entrySignal: FinalSignal
  entryV3: V3OrderType
  entryV4: SignalType
  entryHtf: SignalType | undefined
  entryPcr: number
  entryVix: number | null
  entryCharges: OptionCharges
  peak: number
  lastPrice: number
  mfePct: number
  maePct: number
}

export interface ReplayRunInput {
  dataset: ReplayDataset
  macro: MacroSeries
  options: ReplayRunOptions
  signalSource?: ReplaySignalSource
  label?: string
  dataSource?: string
  dataLicense?: string
}

export function emptySignalCounters(): SignalCounters {
  return {
    evaluations: 0,
    actionable: 0,
    filterVetoed: 0,
    hardStopBlocked: 0,
    dailyLossBlocked: 0,
    capBlocked: 0,
    cooldownBlocked: 0,
    entryCutoff: 0,
    noExpiry: 0,
    noContract: 0,
    noOptionBar: 0,
    insufficientCash: 0,
    entries: 0,
    ceSignals: 0,
    peSignals: 0,
    htfBuy: 0,
    htfSell: 0,
    htfHold: 0,
    v3Buy: 0,
    v3Sell: 0,
    v3Hold: 0,
    pcrSum: 0,
    pcrCount: 0,
  }
}

function addCounters(target: SignalCounters, source: SignalCounters): void {
  const keys = Object.keys(source) as Array<keyof SignalCounters>
  for (const key of keys) target[key] += source[key]
}

function countChainMinutes(day: import('./types').ReplayDay, spot: number): number {
  let minutes = 0
  for (let minute = 555; minute <= MARKET_CLOSE_MINUTE; minute += 1) {
    if (day.chainAt(minute, spot).length > 0) minutes += 1
  }
  return minutes
}

function positionView(position: OpenPosition, currentPrice: number): ActivePosition {
  return {
    instrumentKey: position.instrumentKey,
    direction: position.direction,
    entryPrice: position.entryPrice,
    quantity: position.quantity,
    entryTime: position.entryTime,
    tradeId: 0,
    tradeType: 'buying',
    peakFavorablePrice: position.peak,
    currentPrice,
  }
}

interface IntrabarExit {
  rawPrice: number
  reason: string
}

function intrabarExit(
  position: OpenPosition,
  bar: OptionBar,
  strategy: StrategyConfig,
): IntrabarExit | null {
  const stopPrice = position.entryPrice * (1 - strategy.maxLossPct / 100)
  const targetPrice = position.entryPrice * (1 + strategy.maxProfitPct / 100)
  const trailing =
    strategy.trailPct !== undefined && strategy.trailPct > 0
      ? position.peak * (1 - strategy.trailPct / 100)
      : null

  // Conservative convention: when both the stop and target are inside the
  // same 1-minute bar, assume the stop was hit first.
  if (bar.low <= stopPrice) {
    const raw = bar.open <= stopPrice ? bar.open : stopPrice
    return { rawPrice: raw, reason: 'stop-loss' }
  }
  if (bar.high >= targetPrice) {
    const raw = bar.open >= targetPrice ? bar.open : targetPrice
    return { rawPrice: raw, reason: 'target' }
  }
  if (trailing !== null && position.peak > position.entryPrice && bar.low <= trailing) {
    const raw = bar.open <= trailing ? bar.open : trailing
    return { rawPrice: raw, reason: 'trailing-stop' }
  }
  return null
}

function metricsFrom(
  trades: ReplayTrade[],
  days: ReplayDayResult[],
  initialCapital: number,
): ReplayMetrics {
  const wins = trades.filter((trade) => trade.netPnl > 0)
  const losses = trades.filter((trade) => trade.netPnl < 0)
  const flats = trades.length - wins.length - losses.length
  const netPnl = round2(trades.reduce((sum, trade) => sum + trade.netPnl, 0))
  const grossPnl = round2(trades.reduce((sum, trade) => sum + trade.grossPnl, 0))
  const totalCharges = round2(
    trades.reduce((sum, trade) => sum + trade.totalCharges, 0),
  )
  const slippageCost = round2(
    trades.reduce((sum, trade) => sum + trade.slippageCost, 0),
  )
  const winNet = wins.reduce((sum, trade) => sum + trade.netPnl, 0)
  const lossNet = Math.abs(losses.reduce((sum, trade) => sum + trade.netPnl, 0))
  const finalEquity = days.length
    ? days[days.length - 1].equity
    : initialCapital

  let peak = initialCapital
  let maxDrawdown = 0
  let maxDrawdownPct = 0
  let previousEquity = initialCapital
  const dailyReturns: number[] = []
  for (const day of days) {
    dailyReturns.push(
      previousEquity > 0 ? (day.equity - previousEquity) / previousEquity : 0,
    )
    previousEquity = day.equity
    peak = Math.max(peak, day.equity)
    const drawdown = peak - day.equity
    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown
      maxDrawdownPct = peak > 0 ? (drawdown / peak) * 100 : 0
    }
  }

  let sharpeDaily: number | null = null
  if (dailyReturns.length > 1) {
    const mean =
      dailyReturns.reduce((sum, value) => sum + value, 0) / dailyReturns.length
    const variance =
      dailyReturns.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
      dailyReturns.length
    const std = Math.sqrt(variance)
    sharpeDaily = std > 0 ? (mean / std) * Math.sqrt(252) : null
  }

  const tradedSessions = days.filter((day) => day.trades > 0).length
  return {
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    flats,
    winRatePct: trades.length ? (wins.length / trades.length) * 100 : 0,
    grossPnl,
    netPnl,
    totalCharges,
    slippageCost,
    profitFactor: lossNet > 0 ? winNet / lossNet : null,
    expectancy: trades.length ? netPnl / trades.length : 0,
    avgWin: wins.length ? winNet / wins.length : 0,
    avgLoss: losses.length ? losses.reduce((sum, trade) => sum + trade.netPnl, 0) / losses.length : 0,
    largestWin: wins.length ? Math.max(...wins.map((trade) => trade.netPnl)) : 0,
    largestLoss: losses.length ? Math.min(...losses.map((trade) => trade.netPnl)) : 0,
    avgHoldMinutes: trades.length
      ? trades.reduce((sum, trade) => sum + trade.holdMinutes, 0) / trades.length
      : 0,
    avgMfePct: trades.length
      ? trades.reduce((sum, trade) => sum + trade.mfePct, 0) / trades.length
      : 0,
    avgMaePct: trades.length
      ? trades.reduce((sum, trade) => sum + trade.maePct, 0) / trades.length
      : 0,
    returnPct:
      initialCapital > 0 ? ((finalEquity - initialCapital) / initialCapital) * 100 : 0,
    maxDrawdown: round2(maxDrawdown),
    maxDrawdownPct,
    sharpeDaily,
    tradedSessions,
    totalSessions: days.length,
    positiveDays: days.filter((day) => day.netPnl > 0).length,
    negativeDays: days.filter((day) => day.netPnl < 0).length,
    flatDays: days.filter((day) => day.netPnl === 0).length,
    avgTradesPerSession: days.length ? trades.length / days.length : 0,
  }
}

export async function runReplay(input: ReplayRunInput): Promise<ReplayResult> {
  const { dataset, macro, options } = input
  const signalSource: ReplaySignalSource =
    input.signalSource ?? new ReconstructedSignalSource()
  const strategy: StrategyConfig = { ...DEFAULT_CONFIG, ...options.strategy }
  const rates: CostRates = costRatesFor(options.costModel)
  const dates = dataset.dates.filter(
    (date) =>
      date >= options.from &&
      date <= options.to &&
      isTradingDate(date),
  )
  if (!dates.length) {
    throw new Error(
      `No spot sessions between ${options.from} and ${options.to} in ${dataset.symbol}`,
    )
  }

  let cash = options.initialCapital
  const allTrades: ReplayTrade[] = []
  const dayResults: ReplayDayResult[] = []
  const totalCounters = emptySignalCounters()
  const lastEntryMinute = parseHm(strategy.lastEntryTime, 14 * 60 + 30)
  const effectiveSquareOff = Math.min(
    parseHm(strategy.squareOffTime, MARKET_CLOSE_MINUTE),
    MARKET_CLOSE_MINUTE,
  )
  const maxDailyLossPct = strategy.maxDailyLossPct
  const exitCooldownMinutes =
    strategy.exitCooldownSec && strategy.exitCooldownSec > 0
      ? Math.ceil(strategy.exitCooldownSec / 60)
      : 0

  let tradeSequence = 0
  for (const date of dates) {
    const day = await dataset.getDay(date)
    if (!day) continue
    const counters = emptySignalCounters()
    const dayStartCash = cash
    const dayStartEquity = cash
    let position: OpenPosition | null = null
    let tradesToday = 0
    let lastExitMinute: number | null = null
    let dailyLossTripped = false
    let dayPeakEquity = dayStartEquity
    let dayMaxDrawdownPct = 0
    let lastSpot = day.spotCandles[0]?.[4] ?? 0
    const dayTrades: ReplayTrade[] = []
    const notes: string[] = []
    const macroDay: MacroDay | null = macro ? macro.getDay(date) : null
    const spotClose = day.spotCandles[day.spotCandles.length - 1]?.[4] ?? null
    const optionBars = [...day.optionSeries.values()].reduce(
      (sum, series) => sum + series.bars.length,
      0,
    )
    const chainMinutes = countChainMinutes(day, spotClose ?? 0)

    if (!day.expiry) notes.push('no strictly-future expiry in dataset')
    if (day.expiry && !day.optionSeries.size) notes.push('expiry file has no bars for this date')
    if (!macroDay?.items.length) notes.push('no global macro data')
    if (macroDay?.vix == null) notes.push('India VIX unavailable')
    if (day.spotCandles.length < options.minBarsPerSession) {
      notes.push(`spot bars ${day.spotCandles.length} < minimum ${options.minBarsPerSession}`)
    }

    const equityNow = (): number =>
      round2(
        cash +
          (position ? position.quantity * position.lastPrice : 0),
      )

    const markEquity = (): void => {
      const equity = equityNow()
      dayPeakEquity = Math.max(dayPeakEquity, equity)
      const drawdown =
        dayPeakEquity > 0 ? ((dayPeakEquity - equity) / dayPeakEquity) * 100 : 0
      dayMaxDrawdownPct = Math.max(dayMaxDrawdownPct, drawdown)
      if (
        maxDailyLossPct !== undefined &&
        maxDailyLossPct > 0 &&
        dayStartEquity > 0 &&
        equity <= dayStartEquity * (1 - maxDailyLossPct / 100)
      ) {
        dailyLossTripped = true
      }
    }

    const closePosition = (
      open: OpenPosition,
      exitRawPrice: number,
      exitMinute: number,
      exitTime: string,
      exitSpot: number | null,
      reason: string,
    ): ReplayTrade => {
      const exitPrice = applySlippage(
        exitRawPrice,
        options.slippageBps,
        'sell',
      )
      const exitValue = round2(exitPrice * open.quantity)
      const exitCharges = calculateOptionCharges(exitValue, 'sell', rates)
      const grossPnl = round2((exitPrice - open.entryPrice) * open.quantity)
      const rawPnl = round2((exitRawPrice - open.entryRawPrice) * open.quantity)
      const slippageCost = round2(
        ((open.entryRawPrice + exitRawPrice) * options.slippageBps * open.quantity) /
          10_000,
      )
      const totalCharges = round2(open.entryCharges.total + exitCharges.total)
      const netPnl = round2(grossPnl - totalCharges)
      cash = round2(cash + exitValue - exitCharges.total)
      const trade: ReplayTrade = {
        id: open.id,
        date,
        symbol: open.symbol,
        expiry: open.expiry,
        strike: open.strike,
        direction: open.direction,
        instrumentKey: open.instrumentKey,
        lots: open.lots,
        lotSize: open.lotSize,
        quantity: open.quantity,
        entryTime: open.entryTime,
        entryMinute: open.entryMinute,
        entrySignalMinute: open.entrySignalMinute,
        entryRawPrice: open.entryRawPrice,
        entryPrice: open.entryPrice,
        entrySpot: open.entrySpot,
        entrySignal: open.entrySignal.signal,
        entryConfidence: open.entrySignal.confidence,
        entryBullScore: open.entrySignal.bullScore,
        entryBearScore: open.entrySignal.bearScore,
        entryV3: open.entryV3,
        entryV4: open.entryV4,
        entryHtf: open.entryHtf,
        entryPcr: open.entryPcr,
        entryVix: open.entryVix,
        exitTime,
        exitMinute,
        exitRawPrice,
        exitPrice,
        exitSpot,
        exitReason: reason,
        holdMinutes: Math.max(0, exitMinute - open.entryMinute),
        mfePct: open.mfePct,
        maePct: open.maePct,
        grossPnl,
        rawPnl,
        slippageCost,
        entryCharges: open.entryCharges.total,
        exitCharges: exitCharges.total,
        totalCharges,
        netPnl,
        netPnlPerUnit: round2(netPnl / open.quantity),
        returnPct:
          open.entryPrice * open.quantity > 0
            ? (netPnl / (open.entryPrice * open.quantity)) * 100
            : 0,
        capitalAfter: round2(cash),
      }
      return trade
    }

    const recordExit = (
      open: OpenPosition,
      rawPrice: number,
      minute: number,
      timestamp: string,
      spot: number,
      reason: string,
    ): void => {
      const trade = closePosition(open, rawPrice, minute, timestamp, spot, reason)
      dayTrades.push(trade)
      allTrades.push(trade)
      lastExitMinute = minute
      position = null
      markEquity()
    }

    const maxTrades = Math.max(0, Math.trunc(strategy.maxTradesPerDay))
    const totalCap =
      strategy.maxTotalTradesPerDay === undefined
        ? undefined
        : Math.max(0, Math.trunc(strategy.maxTotalTradesPerDay))

    for (let index = 0; index < day.spotCandles.length; index += 1) {
      const candle = day.spotCandles[index]
      const timestamp = candle[0]
      const minute = istMinute(timestamp)
      const spot = candle[4]
      lastSpot = spot
      if (minute > MARKET_CLOSE_MINUTE) break

      const todayCandles = day.spotCandles.slice(0, index + 1)
      const htfCandles = buildHtfCandleHistory(day.previousCandles, todayCandles)
      const chain = day.chainAt(minute, spot)
      const context = {
        timestamp,
        date,
        minute,
        spot,
        candles: todayCandles,
        htfCandles,
        chain,
        macro: macroDay,
      }

      if (position && minute < position.entryMinute) continue

      if (position) {
        const exactBar = position.series.byMinute.get(minute)
        const knownBar = exactBar ?? seriesAtOrBefore(position.series, minute)
        if (knownBar) {
          position.lastPrice = knownBar.close
          position.mfePct = Math.max(
            position.mfePct,
            ((knownBar.high - position.entryPrice) / position.entryPrice) * 100,
          )
          position.maePct = Math.min(
            position.maePct,
            ((knownBar.low - position.entryPrice) / position.entryPrice) * 100,
          )
        }

        let exited = false
        if (exactBar) {
          // The peak used for the intrabar trailing stop must come from
          // bars that had already completed before this bar. Updating it
          // with this bar's close/high first would let a low earlier in the
          // bar "see" a peak that only happened later in the same bar.
          const intrabar = intrabarExit(position, exactBar, strategy)
          if (intrabar) {
            recordExit(
              position,
              intrabar.rawPrice,
              minute,
              exactBar.timestamp,
              spot,
              intrabar.reason,
            )
            exited = true
          } else if (minute >= effectiveSquareOff) {
            recordExit(
              position,
              exactBar.close,
              minute,
              exactBar.timestamp,
              spot,
              'square-off',
            )
            exited = true
          } else {
            // Current bar is now complete for signal/peak purposes. This is
            // valid for the next bar, not for the intrabar check above.
            position.peak = Math.max(
              position.peak,
              options.peakSource === 'high' ? exactBar.high : exactBar.close,
            )
            const data = signalSource.buildData(context)
            const exitCheck = shouldExit(
              positionView(position, exactBar.close),
              data,
              exactBar.close,
              strategy,
            )
            if (exitCheck.exit) {
              const nextBar = seriesFirstAtOrAfter(position.series, minute + 1)
              const nextSpot = day.spotCandles[index + 1]?.[4] ?? spot
              if (nextBar && nextBar.minute <= effectiveSquareOff) {
                recordExit(
                  position,
                  nextBar.open,
                  nextBar.minute,
                  nextBar.timestamp,
                  nextSpot,
                  `signal-exit: ${exitCheck.reason}`,
                )
              } else {
                recordExit(
                  position,
                  exactBar.close,
                  minute,
                  exactBar.timestamp,
                  spot,
                  `signal-exit: ${exitCheck.reason}`,
                )
              }
              exited = true
            }
          }
        } else if (minute >= effectiveSquareOff) {
          recordExit(
            position,
            position.lastPrice,
            minute,
            timestamp,
            spot,
            'square-off (stale quote)',
          )
          exited = true
        } else if (knownBar) {
          // No new bar at this minute: carry the last completed bar's peak
          // forward. It was already known before this minute.
          position.peak = Math.max(
            position.peak,
            options.peakSource === 'high' ? knownBar.high : knownBar.close,
          )
        }

        if (exited) continue
        markEquity()
        continue
      }

      // Flat: no new entries at/after square-off.
      if (minute >= effectiveSquareOff) continue

      const data: AllSignalData = signalSource.buildData(context)
      const resolveSignal = (config: StrategyConfig): FinalSignal =>
        signalSource.signalFor?.(context, data, config) ??
        getFinalSignal(data, config)
      const filtered = resolveSignal(strategy)
      const unfiltered =
        strategy.useMultiTimeframe === false
          ? filtered
          : resolveSignal({ ...strategy, useMultiTimeframe: false })

      counters.evaluations += 1
      if (data.v3 === ORDER_TYPE_BUY) counters.v3Buy += 1
      else if (data.v3 === ORDER_TYPE_SELL) counters.v3Sell += 1
      else counters.v3Hold += 1
      const htf = data.indicators.higherTimeframeTrend
      if (htf === SIGNAL_BUY) counters.htfBuy += 1
      else if (htf === SIGNAL_SELL) counters.htfSell += 1
      else counters.htfHold += 1
      counters.pcrSum += data.indicators.pcrValue
      counters.pcrCount += 1

      const filteredActionable =
        filtered.signal === SIGNAL_BUY_CE || filtered.signal === SIGNAL_BUY_PE
      const unfilteredActionable =
        unfiltered.signal === SIGNAL_BUY_CE || unfiltered.signal === SIGNAL_BUY_PE
      if (filteredActionable) {
        counters.actionable += 1
        if (filtered.signal === SIGNAL_BUY_CE) counters.ceSignals += 1
        else counters.peSignals += 1
      } else if (unfilteredActionable) {
        counters.filterVetoed += 1
      }

      if (!filteredActionable) continue
      if (!day.expiry) {
        counters.noExpiry += 1
        continue
      }
      if (minute >= lastEntryMinute) {
        counters.entryCutoff += 1
        continue
      }
      if (dailyLossTripped) {
        counters.dailyLossBlocked += 1
        continue
      }
      if (tradesToday >= maxTrades || (totalCap !== undefined && tradesToday >= totalCap)) {
        counters.capBlocked += 1
        continue
      }
      if (
        lastExitMinute !== null &&
        exitCooldownMinutes > 0 &&
        minute - lastExitMinute < exitCooldownMinutes
      ) {
        counters.cooldownBlocked += 1
        continue
      }
      const hardStop = runHardStopChecks(data.vrd)
      if (hardStop.blocked) {
        counters.hardStopBlocked += 1
        continue
      }

      const direction = filtered.signal === SIGNAL_BUY_CE ? 'CE' : 'PE'
      const contract = selectOptionContract(
        chain,
        spot,
        direction,
        strategy.otmSkip,
        options.lotSize,
        options.maxStrikeDistancePct,
      )
      if (!contract) {
        counters.noContract += 1
        continue
      }
      const series = day.optionSeries.get(optionKey(contract.strike, direction))
      if (!series) {
        counters.noOptionBar += 1
        continue
      }
      let entryBar = series.byMinute.get(minute + 1)
      if (!entryBar) {
        const candidate = seriesFirstAtOrAfter(series, minute + 1)
        if (
          candidate &&
          candidate.minute <= minute + Math.max(1, options.maxEntryDelayBars)
        ) {
          entryBar = candidate
        }
      }
      if (!entryBar || entryBar.minute >= effectiveSquareOff) {
        counters.noOptionBar += 1
        continue
      }

      const quantity = options.lots * contract.lotSize
      if (quantity <= 0) {
        counters.noContract += 1
        continue
      }
      const entryPrice = applySlippage(entryBar.open, options.slippageBps, 'buy')
      const entryValue = round2(entryPrice * quantity)
      const entryCharges = calculateOptionCharges(entryValue, 'buy', rates)
      if (cash + 1e-9 < entryValue + entryCharges.total) {
        counters.insufficientCash += 1
        continue
      }

      cash = round2(cash - entryValue - entryCharges.total)
      tradesToday += 1
      counters.entries += 1
      tradeSequence += 1
      position = {
        id: `${date}-${String(tradeSequence).padStart(4, '0')}`,
        date,
        symbol: options.symbol,
        expiry: day.expiry ?? 'unknown',
        strike: contract.strike,
        direction,
        instrumentKey: contract.instrumentKey,
        lots: options.lots,
        lotSize: contract.lotSize,
        quantity,
        series,
        entryTime: entryBar.timestamp,
        entryMinute: entryBar.minute,
        entrySignalMinute: minute,
        entryRawPrice: entryBar.open,
        entryPrice,
        entrySpot: spot,
        entrySignal: filtered,
        entryV3: data.v3,
        entryV4: filtered.v4,
        entryHtf: data.indicators.higherTimeframeTrend,
        entryPcr: data.indicators.pcrValue,
        entryVix: data.vrd?.vix ?? null,
        entryCharges,
        peak: entryPrice,
        lastPrice: entryPrice,
        mfePct: 0,
        maePct: 0,
      }
      markEquity()
    }

    if (position) {
      const lastBar = seriesAtOrBefore(position.series, effectiveSquareOff)
      const raw = lastBar?.close ?? position.lastPrice
      const exitMinute = lastBar?.minute ?? effectiveSquareOff
      const exitTime = lastBar?.timestamp ?? day.spotCandles[day.spotCandles.length - 1]?.[0] ?? new Date().toISOString()
      const trade = closePosition(
        position,
        raw,
        exitMinute,
        exitTime,
        lastSpot,
        'eod',
      )
      dayTrades.push(trade)
      allTrades.push(trade)
      position = null
      markEquity()
    }

    const dayNet = round2(dayTrades.reduce((sum, trade) => sum + trade.netPnl, 0))
    const dayGross = round2(dayTrades.reduce((sum, trade) => sum + trade.grossPnl, 0))
    const dayCharges = round2(
      dayTrades.reduce((sum, trade) => sum + trade.totalCharges, 0),
    )
    const equity = round2(cash)
    const dayReturn =
      dayStartCash > 0 ? ((equity - dayStartCash) / dayStartCash) * 100 : 0
    const dayResult: ReplayDayResult = {
      date,
      expiry: day.expiry,
      spotOpen: day.spotCandles[0]?.[1] ?? null,
      spotClose,
      spotBars: day.spotCandles.length,
      optionBars,
      optionStrikes: day.strikes.length,
      chainMinutes,
      macroItems: macroDay?.items.length ?? 0,
      vix: macroDay?.vix ?? null,
      vixSource: macroDay?.vixSource ?? 'no-macro',
      signals: counters,
      entries: counters.entries,
      trades: dayTrades.length,
      grossPnl: dayGross,
      totalCharges: dayCharges,
      netPnl: dayNet,
      equity,
      dailyReturnPct: dayReturn,
      maxDrawdownPct: dayMaxDrawdownPct,
      notes,
    }
    dayResults.push(dayResult)
    addCounters(totalCounters, counters)
  }

  const metrics = metricsFrom(allTrades, dayResults, options.initialCapital)
  const coverage: ReplayCoverage = {
    totalSessions: dayResults.length,
    sessionsWithSpot: dayResults.filter((day) => day.spotBars > 0).length,
    sessionsWithOptionData: dayResults.filter((day) => day.optionBars > 0).length,
    sessionsWithMacro: dayResults.filter((day) => day.macroItems > 0).length,
    sessionsWithVix: dayResults.filter((day) => day.vix !== null).length,
    sessionsWithSignals: dayResults.filter((day) => day.signals.actionable > 0).length,
    optionBars: dayResults.reduce((sum, day) => sum + day.optionBars, 0),
    chainMinutes: dayResults.reduce((sum, day) => sum + day.chainMinutes, 0),
    macroSymbolDays: dayResults.reduce((sum, day) => sum + day.macroItems, 0),
    disabledVrdLayers: [
      'advancesDeclines (breadth)',
      'fiiLongShort',
      'fiiPositioning',
      'mmi',
      'niftyPe',
      'straddleIv',
      'giftNifty',
      'newsAlerts',
    ],
    notes: [
      'Option fills use the next 1-minute bar open plus slippage; intrabar stops/targets use OHLC with stop-first ordering.',
      'PCR is reconstructed from option-chain OI, carrying the last positive OI forward when a minute reports zero.',
      'Global sentiment uses the previous completed daily close; India VIX uses the daily open or previous close.',
      'No historical bid/ask data: slippage is a configurable proxy, not a measured spread.',
    ],
  }

  const exitReasons: Record<string, number> = {}
  for (const trade of allTrades) {
    exitReasons[trade.exitReason] = (exitReasons[trade.exitReason] ?? 0) + 1
  }

  const warnings: string[] = []
  if (!allTrades.length) warnings.push('No trades were produced; inspect signal and data-coverage counters.')
  if (allTrades.length > 0 && allTrades.length < 30) {
    warnings.push(`Small sample (${allTrades.length} trades) — do not treat this as statistically decisive.`)
  }
  if (coverage.sessionsWithOptionData < coverage.totalSessions) {
    warnings.push(
      `${coverage.totalSessions - coverage.sessionsWithOptionData} session(s) had no usable option bars.`,
    )
  }
  if (coverage.sessionsWithMacro < coverage.totalSessions) {
    warnings.push(
      `Global macro data missing on ${coverage.totalSessions - coverage.sessionsWithMacro} session(s); V3 is degraded there.`,
    )
  }
  if (coverage.sessionsWithVix < coverage.totalSessions) {
    warnings.push(
      `India VIX missing on ${coverage.totalSessions - coverage.sessionsWithVix} session(s); VIX hard stop cannot fire there.`,
    )
  }
  warnings.push(
    'Reconstructed replay, not live-VRD parity: breadth, FII, MMI, Nifty PE, straddle IV, GIFT Nifty and news layers were unavailable and are neutral/null.',
  )
  if (options.lotSize !== 75) {
    warnings.push(
      `Replay uses NIFTY lot size ${options.lotSize}; the daemon uses 75. Normalize per-unit before comparing to the paper ledger.`,
    )
  }

  return {
    label: input.label ?? `${options.symbol} ${options.from}..${options.to}`,
    from: options.from,
    to: options.to,
    symbol: options.symbol,
    dataSource:
      input.dataSource ??
      'thetrademarkk/india-index-options-1m (1-minute NIFTY spot + option contracts)',
    dataLicense:
      input.dataLicense ??
      'CC-BY-NC-4.0 (third-party dataset; research/non-commercial use)',
    generatedAt: new Date().toISOString(),
    options,
    metrics,
    coverage,
    signals: totalCounters,
    exitReasons,
    trades: allTrades,
    days: dayResults,
    warnings,
  }
}
