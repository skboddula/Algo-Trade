/**
 * Real-data backtesting engine.
 *
 * Runs the strategy's technical indicator layer against real historical
 * 1-minute candles from Upstox and simulates option trades with the same
 * exit conditions as the live bot (profit target, stop loss, trailing
 * stop, EOD squareoff).
 *
 * Read-only: this module never writes to D1, never sends Telegram alerts,
 * never modifies live bot state, and never places orders. It borrows pure
 * functions from the strategy engine (getFinalSignal, computeAllIndicators,
 * shouldExit) without any modification.
 *
 * Limitations (by design for the MVP):
 * - Macro/sentiment layers (FII/DII, global indices, MMI, PCR) are not
 *   historically available, so the signal is driven by the technical
 *   layer only. This tests whether technical entries alone are profitable.
 * - Option premiums are approximated (underlying % move × leverage factor)
 *   rather than using real option contract data. Win/loss direction is
 *   accurate; P&L amounts are estimates.
 */

import { API_MARKET_CANDLES_HISTORICAL } from './constants'
import { computeAllIndicators } from './indicators'
import { getFinalSignal, shouldExit } from './strategyEngine'
import { calculateOptionFees } from './dailyBacktestEngine'
import type {
  AllSignalData,
  Candle,
  FinalSignal,
  ActivePosition,
  StrategyConfig,
  UnderlyingSymbol,
} from './types'

// ─── Types ─────────────────────────────────────────────────────────────────

export interface BacktestConfig {
  symbol: UnderlyingSymbol
  instrumentKey: string
  fromDate: string // YYYY-MM-DD
  toDate: string // YYYY-MM-DD
  token: string
  strategy: Pick<
    StrategyConfig,
    | 'strongThreshold'
    | 'moderateThreshold'
    | 'strongGap'
    | 'moderateGap'
    | 'minConfidence'
    | 'maxProfitPct'
    | 'maxLossPct'
    | 'trailPct'
    | 'otmSkip'
    | 'lastEntryTime'
    | 'executionMode'
    | 'tradeType'
    | 'underlyingMode'
  >
  /** Approximate premium for the OTM option at entry (in ₹). */
  avgOptionPremium: number
  /** How much the option premium moves vs the underlying % (delta leverage). */
  deltaLeverage: number
  /** Lot size for the symbol. */
  lotSize: number
  /** Starting paper balance for capital sizing. */
  startingBalance: number
}

export interface BacktestTrade {
  tradeId: string
  signal: string
  confidence: string
  direction: 'CE' | 'PE'
  entryTime: string
  exitTime: string | null
  entryPrice: number // underlying close at entry
  entryPremium: number // approximated option premium at entry
  exitPremium: number | null
  underlyingAtExit: number | null
  quantity: number
  lots: number
  grossPnl: number
  fees: number
  netPnl: number
  pnlPct: number
  exitReason: string
  status: 'OPEN' | 'WIN' | 'LOSS'
  peakUnderlying: number
}

export interface BacktestResult {
  config: BacktestConfig
  totalBars: number
  totalSignals: number
  totalTrades: number
  completedTrades: number
  winningTrades: number
  losingTrades: number
  winRatePct: number
  grossPnl: number
  totalFees: number
  netPnl: number
  roiPct: number
  profitFactor: number
  maxDrawdownPct: number
  avgHoldTimeMin: number
  trades: BacktestTrade[]
  signalLog: {
    time: string
    signal: string
    confidence: string
    score: number
  }[]
}

// ─── Data Fetching ─────────────────────────────────────────────────────────

interface UpstoxHistoricalResponse {
  status?: string
  data?: {
    candles?: (number | string | null)[][]
  }
}

export async function fetchHistoricalCandles(
  token: string,
  instrumentKey: string,
  fromDate: string,
  toDate: string,
  interval = '1minute',
): Promise<Candle[]> {
  const response = await fetch(API_MARKET_CANDLES_HISTORICAL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, instrumentKey, fromDate, toDate, interval }),
  })
  if (!response.ok) {
    throw new Error(`Historical candle fetch failed: HTTP ${response.status}`)
  }
  const raw: unknown = await response.json()
  const resp = raw as UpstoxHistoricalResponse
  const rows: (string | number | null)[][] = resp.data?.candles ?? []
  return rows.map((row): Candle => {
    const [ts, o, h, l, c, v] = row
    return [
      typeof ts === 'string'
        ? ts
        : new Date(typeof ts === 'number' ? ts : 0).toISOString(),
      Number(o ?? 0),
      Number(h ?? 0),
      Number(l ?? 0),
      Number(c ?? 0),
      Number(v ?? 0),
      undefined,
    ]
  })
}

// ─── Option Premium Approximation ──────────────────────────────────────────

/**
 * Approximates the option premium change from the underlying's percentage
 * move. For slightly OTM options with reasonable time to expiry, the
 * premium moves approximately deltaLeverage × underlying % change.
 * Does not model theta decay or IV changes.
 */
export function approximatePremium(
  entryPremium: number,
  entryUnderlying: number,
  currentUnderlying: number,
  direction: 'CE' | 'PE',
  deltaLeverage: number,
): number {
  const underlyingPctChange =
    entryUnderlying > 0
      ? (currentUnderlying - entryUnderlying) / entryUnderlying
      : 0
  const directionSign = direction === 'CE' ? 1 : -1
  const optionPctChange = underlyingPctChange * directionSign * deltaLeverage
  const newPremium = entryPremium * (1 + optionPctChange)
  // Premium can't go below 0.05 (paise-level floor)
  return Math.max(0.05, Number(newPremium.toFixed(2)))
}

// ─── Backtest Runner ────────────────────────────────────────────────────────

/**
 * Runs the backtest on real historical candles.
 *
 * At each bar (starting from bar 60 to allow indicator warmup):
 * 1. Computes technical indicators on a sliding 200-bar window (no look-ahead)
 * 2. Evaluates the strategy signal (getFinalSignal)
 * 3. If an entry signal fires and no position is open, simulates a trade
 * 4. If a position is open, checks exit conditions (shouldExit)
 * 5. Exits at EOD (lastEntryTime or last bar)
 */
export function runBacktest(
  candles: Candle[],
  config: BacktestConfig,
): BacktestResult {
  const trades: BacktestTrade[] = []
  const signalLog: BacktestResult['signalLog'] = []
  const INDICATOR_WARMUP = 60
  const WINDOW = 200
  const MIN_BARS_FOR_SIGNAL = Math.max(INDICATOR_WARMUP, 40)

  let balance = config.startingBalance
  let peakBalance = balance
  let maxDrawdownPct = 0
  let openTrade: BacktestTrade | null = null
  let position: ActivePosition | null = null
  const lastEntryMinutes = parseTimeToMinutes(config.strategy.lastEntryTime)

  for (let i = MIN_BARS_FOR_SIGNAL; i < candles.length; i++) {
    const bar = candles[i]
    const closePrice = bar[4]
    const barTime = bar[0]

    // ── Check exit for open position ──────────────────────────────────
    if (openTrade && position) {
      const currentPremium = approximatePremium(
        openTrade.entryPremium,
        openTrade.entryPrice,
        closePrice,
        openTrade.direction,
        config.deltaLeverage,
      )
      openTrade.peakUnderlying = Math.max(openTrade.peakUnderlying, closePrice)
      const peakPremium = approximatePremium(
        openTrade.entryPremium,
        openTrade.entryPrice,
        openTrade.peakUnderlying,
        openTrade.direction,
        config.deltaLeverage,
      )
      const updatedPosition: ActivePosition = {
        ...position,
        currentPrice: currentPremium,
        peakFavorablePrice: peakPremium,
      }
      position = updatedPosition

      const barMinutes = timestampToMinutesIST(barTime)
      const isEOD = barMinutes >= lastEntryMinutes || i === candles.length - 1

      if (isEOD) {
        const fees = calculateOptionFees(currentPremium * openTrade.quantity)
        const grossPnl =
          (currentPremium - openTrade.entryPremium) * openTrade.quantity
        const netPnl = grossPnl - fees
        openTrade.exitPremium = currentPremium
        openTrade.exitTime = barTime
        openTrade.underlyingAtExit = closePrice
        openTrade.grossPnl = Number(grossPnl.toFixed(2))
        openTrade.fees = Number(fees.toFixed(2))
        openTrade.netPnl = Number(netPnl.toFixed(2))
        openTrade.pnlPct =
          openTrade.entryPremium > 0
            ? Number(
                (
                  (netPnl / (openTrade.entryPremium * openTrade.quantity)) *
                  100
                ).toFixed(2),
              )
            : 0
        openTrade.exitReason = 'EOD squareoff'
        openTrade.status = netPnl >= 0 ? 'WIN' : 'LOSS'
        balance += netPnl
        trades.push(openTrade)
        openTrade = null
        position = null
        peakBalance = Math.max(peakBalance, balance)
        const dd =
          peakBalance > 0 ? ((peakBalance - balance) / peakBalance) * 100 : 0
        maxDrawdownPct = Math.max(maxDrawdownPct, dd)
        continue
      }

      // Non-EOD exit check
      const exitDecision = shouldExit(
        position,
        buildNeutralSignalData(i, candles, WINDOW),
        currentPremium,
        {
          maxProfitPct: config.strategy.maxProfitPct,
          maxLossPct: config.strategy.maxLossPct,
          trailPct: config.strategy.trailPct,
        },
      )
      if (exitDecision.exit) {
        const fees = calculateOptionFees(currentPremium * openTrade.quantity)
        const grossPnl =
          (currentPremium - openTrade.entryPremium) * openTrade.quantity
        const netPnl = grossPnl - fees
        openTrade.exitPremium = currentPremium
        openTrade.exitTime = barTime
        openTrade.underlyingAtExit = closePrice
        openTrade.grossPnl = Number(grossPnl.toFixed(2))
        openTrade.fees = Number(fees.toFixed(2))
        openTrade.netPnl = Number(netPnl.toFixed(2))
        openTrade.pnlPct =
          openTrade.entryPremium > 0
            ? Number(
                (
                  (netPnl / (openTrade.entryPremium * openTrade.quantity)) *
                  100
                ).toFixed(2),
              )
            : 0
        openTrade.exitReason = exitDecision.reason
        openTrade.status = netPnl >= 0 ? 'WIN' : 'LOSS'
        balance += netPnl
        trades.push(openTrade)
        openTrade = null
        position = null
        peakBalance = Math.max(peakBalance, balance)
        const dd =
          peakBalance > 0 ? ((peakBalance - balance) / peakBalance) * 100 : 0
        maxDrawdownPct = Math.max(maxDrawdownPct, dd)
      }
      continue
    }

    // ── Evaluate entry signal ──────────────────────────────────────────
    const signalData = buildNeutralSignalData(i, candles, WINDOW)
    const signal: FinalSignal = getFinalSignal(signalData, {
      ...config.strategy,
      underlyingMode: config.strategy.underlyingMode ?? config.symbol,
      multiSymbolExecutionMode: 'independent',
      maxTradesPerDay: 99,
      pollingIntervalSec: 60,
      otmSkip: config.strategy.otmSkip,
      executionMode: 'paper',
      tradeType: config.strategy.tradeType ?? 'buying',
      brentCrudeExtremeThreshold: 125,
      brentCrudeOverhangThreshold: 88,
    })

    signalLog.push({
      time: barTime,
      signal: signal.signal,
      confidence: signal.confidence,
      score: Math.max(signal.bullScore, signal.bearScore),
    })

    if (signal.signal !== 'BUY_CE' && signal.signal !== 'BUY_PE') continue

    // Don't enter after lastEntryTime
    const barMinutes = timestampToMinutesIST(barTime)
    if (barMinutes >= lastEntryMinutes) continue

    // Don't enter if balance can't afford 1 lot
    const costPerLot = config.avgOptionPremium * config.lotSize
    if (balance < costPerLot) continue

    // Simulate entry
    const direction: 'CE' | 'PE' = signal.signal === 'BUY_CE' ? 'CE' : 'PE'
    const lots =
      Math.min(
        Math.floor(balance / (costPerLot * 2)), // use at most 50% of balance
        2,
      ) || 1
    const quantity = lots * config.lotSize

    openTrade = {
      tradeId: `bt_${Date.now()}_${i}`,
      signal: signal.signal,
      confidence: signal.confidence,
      direction,
      entryTime: barTime,
      exitTime: null,
      entryPrice: closePrice,
      entryPremium: config.avgOptionPremium,
      exitPremium: null,
      underlyingAtExit: null,
      quantity,
      lots,
      grossPnl: 0,
      fees: 0,
      netPnl: 0,
      pnlPct: 0,
      exitReason: '',
      status: 'OPEN',
      peakUnderlying: closePrice,
    }

    position = {
      instrumentKey: 'BACKTEST',
      direction,
      entryPrice: config.avgOptionPremium,
      quantity,
      lotSize: config.lotSize,
      entryTime: barTime,
      tradeId: Date.now(),
      executionMode: 'paper',
      tradeType: 'buying',
      currentPrice: config.avgOptionPremium,
      unrealizedPnl: 0,
      peakFavorablePrice: config.avgOptionPremium,
      underlyingSymbol: config.symbol,
    }
  }

  // Close any remaining open trade at the last bar
  if (openTrade) {
    const lastBar = candles[candles.length - 1]
    const closePrice = lastBar[4]
    const currentPremium = approximatePremium(
      openTrade.entryPremium,
      openTrade.entryPrice,
      closePrice,
      openTrade.direction,
      config.deltaLeverage,
    )
    const fees = calculateOptionFees(currentPremium * openTrade.quantity)
    const grossPnl =
      (currentPremium - openTrade.entryPremium) * openTrade.quantity
    const netPnl = grossPnl - fees
    openTrade.exitPremium = currentPremium
    openTrade.exitTime = lastBar[0]
    openTrade.underlyingAtExit = closePrice
    openTrade.grossPnl = Number(grossPnl.toFixed(2))
    openTrade.fees = Number(fees.toFixed(2))
    openTrade.netPnl = Number(netPnl.toFixed(2))
    openTrade.exitReason = 'End of data'
    openTrade.status = netPnl >= 0 ? 'WIN' : 'LOSS'
    trades.push(openTrade)
  }

  // ── Aggregate stats ────────────────────────────────────────────────────
  const completed = trades.filter((t) => t.status !== 'OPEN')
  const wins = completed.filter((t) => t.netPnl > 0)
  const losses = completed.filter((t) => t.netPnl <= 0)
  const grossPnl = completed.reduce((s, t) => s + t.grossPnl, 0)
  const totalFees = completed.reduce((s, t) => s + t.fees, 0)
  const netPnl = completed.reduce((s, t) => s + t.netPnl, 0)
  const grossProfit = wins.reduce((s, t) => s + t.grossPnl, 0)
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.grossPnl, 0))

  const holdTimes = completed
    .filter((t) => t.entryTime && t.exitTime)
    .map((t) => {
      const entry = new Date(t.entryTime).getTime()
      const exit = new Date(t.exitTime!).getTime()
      return Number.isFinite(entry) && Number.isFinite(exit)
        ? Math.max(0, Math.round((exit - entry) / 60000))
        : 0
    })
  const avgHoldTimeMin =
    holdTimes.length > 0
      ? Math.round(holdTimes.reduce((s, v) => s + v, 0) / holdTimes.length)
      : 0

  return {
    config,
    totalBars: candles.length,
    totalSignals: signalLog.filter(
      (s) => s.signal === 'BUY_CE' || s.signal === 'BUY_PE',
    ).length,
    totalTrades: trades.length,
    completedTrades: completed.length,
    winningTrades: wins.length,
    losingTrades: losses.length,
    winRatePct:
      completed.length > 0
        ? Number(((wins.length / completed.length) * 100).toFixed(1))
        : 0,
    grossPnl: Number(grossPnl.toFixed(2)),
    totalFees: Number(totalFees.toFixed(2)),
    netPnl: Number(netPnl.toFixed(2)),
    roiPct:
      config.startingBalance > 0
        ? Number(((netPnl / config.startingBalance) * 100).toFixed(2))
        : 0,
    profitFactor:
      grossLoss > 0
        ? Number((grossProfit / grossLoss).toFixed(2))
        : grossProfit > 0
          ? 99
          : 0,
    maxDrawdownPct: Number(maxDrawdownPct.toFixed(2)),
    avgHoldTimeMin,
    trades,
    signalLog: signalLog.slice(-100),
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Builds a minimal AllSignalData with only the technical layer.
 * Macro/sentiment layers are neutral (not historically available).
 */
function buildNeutralSignalData(
  barIndex: number,
  candles: Candle[],
  window: number,
): AllSignalData {
  const start = Math.max(0, barIndex - window + 1)
  const visible = candles.slice(start, barIndex + 1)
  return {
    v3: 'hold',
    indicators: computeAllIndicators(visible, []),
    vrd: null,
    globalIndices: [],
  }
}

function timestampToMinutesIST(timestamp: string): number {
  const d = new Date(timestamp)
  if (Number.isNaN(d.getTime())) return 0
  // IST is UTC+5:30
  const istMinutes = Math.floor(d.getTime() / 60000) + 5.5 * 60
  return Math.floor(istMinutes % (24 * 60))
}

function parseTimeToMinutes(timeStr: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(timeStr)
  if (!match) return 14 * 60 + 30 // default 14:30
  return parseInt(match[1], 10) * 60 + parseInt(match[2], 10)
}

// ─── Convenience ────────────────────────────────────────────────────────────

export const BACKTEST_DEFAULTS = {
  NIFTY: { premium: 120, lotSize: 75, leverage: 2.0 },
  'NIFTY 50': { premium: 120, lotSize: 75, leverage: 2.0 },
  BANKNIFTY: { premium: 500, lotSize: 30, leverage: 2.0 },
  FINNIFTY: { premium: 100, lotSize: 65, leverage: 2.0 },
} as const

export function getBacktestDefaults(symbol: string): {
  premium: number
  lotSize: number
  leverage: number
} {
  return (
    BACKTEST_DEFAULTS[symbol as keyof typeof BACKTEST_DEFAULTS] ?? {
      premium: 120,
      lotSize: 75,
      leverage: 2.0,
    }
  )
}
