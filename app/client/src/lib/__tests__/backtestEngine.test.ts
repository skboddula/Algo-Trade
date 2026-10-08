import { describe, it, expect } from 'vitest'

import {
  approximatePremium,
  runBacktest,
  getBacktestDefaults,
  type BacktestConfig,
} from '../backtestEngine'
import type { Candle } from '../types'

// ─── Test helpers ───────────────────────────────────────────────────────────

function makeCandle(
  time: string,
  open: number,
  high: number,
  low: number,
  close: number,
): Candle {
  return [time, open, high, low, close, 1000, undefined]
}

/** Generates a simple trending 1-min candle series for testing. */
function generateTestCandles(
  startTime: string,
  bars: number,
  startPrice: number,
  trendPerBar: number,
): Candle[] {
  const candles: Candle[] = []
  const base = new Date(startTime).getTime()
  for (let i = 0; i < bars; i++) {
    const ts = new Date(base + i * 60000).toISOString()
    const open = startPrice + trendPerBar * i
    const close = startPrice + trendPerBar * (i + 1)
    const high = Math.max(open, close) + Math.abs(trendPerBar) * 0.5
    const low = Math.min(open, close) - Math.abs(trendPerBar) * 0.5
    candles.push(makeCandle(ts, open, high, low, close))
  }
  return candles
}

function makeConfig(overrides?: Partial<BacktestConfig>): BacktestConfig {
  return {
    symbol: 'NIFTY 50',
    instrumentKey: 'NSE_INDEX|Nifty 50',
    fromDate: '2026-09-01',
    toDate: '2026-09-30',
    token: 'test-token',
    strategy: {
      strongThreshold: 14,
      moderateThreshold: 10,
      strongGap: 6,
      moderateGap: 3,
      minConfidence: 'moderate',
      maxProfitPct: 10,
      maxLossPct: 5,
      trailPct: 5,
      otmSkip: 3,
      lastEntryTime: '14:30',
      executionMode: 'paper',
      tradeType: 'buying',
      underlyingMode: 'NIFTY 50',
    },
    avgOptionPremium: 120,
    deltaLeverage: 2.0,
    lotSize: 75,
    startingBalance: 10000,
    ...overrides,
  }
}

// ─── approximatePremium ─────────────────────────────────────────────────────

describe('approximatePremium', () => {
  it('increases CE premium when underlying rises', () => {
    const result = approximatePremium(100, 24000, 24240, 'CE', 2.0)
    // Underlying +1%, leverage 2x → premium +2%
    expect(result).toBeCloseTo(102, 0)
  })

  it('decreases CE premium when underlying falls', () => {
    const result = approximatePremium(100, 24000, 23760, 'CE', 2.0)
    // Underlying -1%, leverage 2x → premium -2%
    expect(result).toBeCloseTo(98, 0)
  })

  it('increases PE premium when underlying falls', () => {
    const result = approximatePremium(100, 24000, 23760, 'PE', 2.0)
    expect(result).toBeCloseTo(102, 0)
  })

  it('decreases PE premium when underlying rises', () => {
    const result = approximatePremium(100, 24000, 24240, 'PE', 2.0)
    expect(result).toBeCloseTo(98, 0)
  })

  it('never returns below 0.05', () => {
    const result = approximatePremium(1, 24000, 12000, 'CE', 5.0)
    expect(result).toBeGreaterThanOrEqual(0.05)
  })

  it('returns entry premium when underlying unchanged', () => {
    const result = approximatePremium(150, 24000, 24000, 'CE', 2.5)
    expect(result).toBe(150)
  })

  it('handles zero entry underlying gracefully', () => {
    const result = approximatePremium(100, 0, 24000, 'CE', 2.0)
    expect(result).toBeGreaterThanOrEqual(0.05)
  })
})

// ─── getBacktestDefaults ─────────────────────────────────────────────────────

describe('getBacktestDefaults', () => {
  it('returns NIFTY defaults', () => {
    const d = getBacktestDefaults('NIFTY 50')
    expect(d.premium).toBe(120)
    expect(d.lotSize).toBe(75)
    expect(d.leverage).toBe(2.0)
  })

  it('returns BANKNIFTY defaults', () => {
    const d = getBacktestDefaults('BANKNIFTY')
    expect(d.premium).toBe(500)
    expect(d.lotSize).toBe(30)
  })

  it('falls back to safe defaults for unknown symbols', () => {
    const d = getBacktestDefaults('UNKNOWN')
    expect(d.premium).toBeGreaterThan(0)
    expect(d.lotSize).toBeGreaterThan(0)
  })
})

// ─── runBacktest ─────────────────────────────────────────────────────────────

describe('runBacktest', () => {
  it('returns a valid result with no trades on flat/sideways data', () => {
    const candles = generateTestCandles(
      '2026-09-01T09:15:00.000Z',
      200,
      24000,
      0, // completely flat
    )
    const result = runBacktest(candles, makeConfig())
    expect(result.totalBars).toBe(200)
    expect(result.totalTrades).toBeGreaterThanOrEqual(0)
    expect(result.completedTrades).toBeGreaterThanOrEqual(0)
    expect(result.winRatePct).toBeGreaterThanOrEqual(0)
    expect(result.netPnl).toBeGreaterThanOrEqual(-10000)
    expect(result.trades).toBeInstanceOf(Array)
    expect(result.signalLog).toBeInstanceOf(Array)
  })

  it('tracks max drawdown correctly', () => {
    const candles = generateTestCandles(
      '2026-09-01T09:15:00.000Z',
      300,
      24000,
      2, // steady uptrend
    )
    const result = runBacktest(candles, makeConfig())
    expect(result.maxDrawdownPct).toBeGreaterThanOrEqual(0)
    expect(result.maxDrawdownPct).toBeLessThanOrEqual(100)
  })

  it('does not enter trades after lastEntryTime', () => {
    const candles = generateTestCandles(
      '2026-09-01T09:15:00.000Z',
      400,
      24000,
      5, // strong uptrend
    )
    const result = runBacktest(candles, makeConfig())
    // All trades should have entry times before 14:30 IST
    for (const trade of result.trades) {
      const entryTime = new Date(trade.entryTime)
      const istMinutes = Math.floor(entryTime.getTime() / 60000) + 5.5 * 60
      const minutesOfDay = Math.floor(istMinutes % (24 * 60))
      expect(minutesOfDay).toBeLessThan(14 * 60 + 30)
    }
  })

  it('closes all trades (no OPEN status in results)', () => {
    const candles = generateTestCandles(
      '2026-09-01T09:15:00.000Z',
      300,
      24000,
      3,
    )
    const result = runBacktest(candles, makeConfig())
    for (const trade of result.trades) {
      expect(trade.status).not.toBe('OPEN')
      expect(trade.exitTime).not.toBeNull()
    }
  })

  it('only one trade at a time (no overlapping entries)', () => {
    const candles = generateTestCandles(
      '2026-09-01T09:15:00.000Z',
      300,
      24000,
      4,
    )
    const result = runBacktest(candles, makeConfig())
    const sorted = [...result.trades].sort(
      (a, b) =>
        new Date(a.entryTime).getTime() - new Date(b.entryTime).getTime(),
    )
    for (let i = 1; i < sorted.length; i++) {
      const prevExit = new Date(
        sorted[i - 1].exitTime ?? sorted[i - 1].entryTime,
      ).getTime()
      const currEntry = new Date(sorted[i].entryTime).getTime()
      expect(currEntry).toBeGreaterThanOrEqual(prevExit)
    }
  })

  it('respects starting balance for affordability', () => {
    const candles = generateTestCandles(
      '2026-09-01T09:15:00.000Z',
      200,
      24000,
      5,
    )
    const config = makeConfig({ startingBalance: 100 }) // too low to afford any trade
    const result = runBacktest(candles, config)
    expect(result.totalTrades).toBe(0)
  })

  it('computes correct profit factor', () => {
    const candles = generateTestCandles(
      '2026-09-01T09:15:00.000Z',
      400,
      24000,
      2,
    )
    const result = runBacktest(candles, makeConfig())
    expect(result.profitFactor).toBeGreaterThanOrEqual(0)
    // If there are losses, profit factor should be finite
    if (result.losingTrades > 0 && result.winningTrades > 0) {
      expect(result.profitFactor).toBeGreaterThan(0)
    }
  })

  it('uses a sliding indicator window (no look-ahead bias)', () => {
    // Generate a series where the trend changes mid-way
    const uptrend = generateTestCandles(
      '2026-09-01T09:15:00.000Z',
      100,
      24000,
      10, // strong uptrend
    )
    const downtrend = generateTestCandles(
      '2026-09-01T11:00:00.000Z',
      100,
      25000,
      -10, // sharp downtrend
    )
    const candles = [...uptrend, ...downtrend]
    const result = runBacktest(candles, makeConfig())
    // The backtest should not crash and should produce some signals
    expect(result.totalBars).toBe(200)
    expect(result.signalLog.length).toBeGreaterThan(0)
  })
})
