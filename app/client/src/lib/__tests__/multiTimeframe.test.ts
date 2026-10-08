import { describe, it, expect } from 'vitest'

import { resampleCandles, calcHigherTimeframeTrend } from '../indicators'
import type { Candle } from '../types'

function makeCandle(
  time: string,
  open: number,
  high: number,
  low: number,
  close: number,
  volume = 100,
): Candle {
  return [time, open, high, low, close, volume, undefined]
}

// ─── resampleCandles ─────────────────────────────────────────────────────────

describe('resampleCandles', () => {
  it('returns original candles when factor is 1', () => {
    const candles = [
      makeCandle('2026-10-01T09:15:00', 100, 110, 90, 105),
      makeCandle('2026-10-01T09:16:00', 105, 115, 95, 110),
    ]
    expect(resampleCandles(candles, 1)).toEqual(candles)
  })

  it('returns empty array for empty input', () => {
    expect(resampleCandles([], 5)).toEqual([])
  })

  it('correctly aggregates 5 one-min candles into one 5-min candle', () => {
    const candles = [
      makeCandle('2026-10-01T09:15:00', 100, 110, 95, 105, 100),
      makeCandle('2026-10-01T09:16:00', 105, 120, 100, 115, 200),
      makeCandle('2026-10-01T09:17:00', 115, 125, 105, 110, 150),
      makeCandle('2026-10-01T09:18:00', 110, 112, 98, 100, 300),
      makeCandle('2026-10-01T09:19:00', 100, 108, 92, 102, 250),
    ]
    const result = resampleCandles(candles, 5)
    expect(result).toHaveLength(1)
    expect(result[0][0]).toBe('2026-10-01T09:15:00') // first candle's timestamp
    expect(result[0][1]).toBe(100) // first candle's open
    expect(result[0][2]).toBe(125) // max of all highs
    expect(result[0][3]).toBe(92) // min of all lows
    expect(result[0][4]).toBe(102) // last candle's close
    expect(result[0][5]).toBe(1000) // sum of volumes
  })

  it('handles partial final group', () => {
    const candles = [
      makeCandle('09:15', 100, 110, 90, 105),
      makeCandle('09:16', 105, 115, 95, 110),
      makeCandle('09:17', 110, 120, 100, 115),
      // Only 3 candles in the second group
    ]
    const result = resampleCandles(candles, 2)
    expect(result).toHaveLength(2)
    expect(result[0][4]).toBe(110) // close of second candle
    expect(result[1][4]).toBe(115) // close of third candle
  })

  it('produces correct count for 10 candles with factor 3', () => {
    const candles = Array.from({ length: 10 }, (_, i) =>
      makeCandle(
        `09:${String(15 + i).padStart(2, '0')}:00`,
        100 + i,
        110 + i,
        90 + i,
        105 + i,
      ),
    )
    const result = resampleCandles(candles, 3)
    expect(result).toHaveLength(4) // 3+3+3+1
  })
})

// ─── calcHigherTimeframeTrend ────────────────────────────────────────────────

describe('calcHigherTimeframeTrend', () => {
  it('returns hold for insufficient data', () => {
    const candles = Array.from({ length: 10 }, (_, i) =>
      makeCandle(
        `09:${String(15 + i).padStart(2, '0')}:00`,
        100,
        110,
        90,
        100 + i,
      ),
    )
    expect(calcHigherTimeframeTrend(candles)).toBe('Hold')
  })

  it('returns buy for a clear uptrend', () => {
    // Generate 300 candles with a strong uptrend (enough for 5-min resampling + 42-period EMA)
    const candles: Candle[] = []
    const baseTime = new Date('2026-10-01T09:15:00').getTime()
    for (let i = 0; i < 300; i++) {
      const ts = new Date(baseTime + i * 60000).toISOString()
      const price = 24000 + i * 2 // steady uptrend
      candles.push(makeCandle(ts, price, price + 5, price - 5, price + 2))
    }
    const trend = calcHigherTimeframeTrend(candles)
    expect(trend).toBe('Buy')
  })

  it('returns sell for a clear downtrend', () => {
    const candles: Candle[] = []
    const baseTime = new Date('2026-10-01T09:15:00').getTime()
    for (let i = 0; i < 300; i++) {
      const ts = new Date(baseTime + i * 60000).toISOString()
      const price = 24000 - i * 2 // steady downtrend
      candles.push(makeCandle(ts, price, price + 5, price - 5, price - 2))
    }
    const trend = calcHigherTimeframeTrend(candles)
    expect(trend).toBe('Sell')
  })

  it('returns hold for a sideways market', () => {
    const candles: Candle[] = []
    const baseTime = new Date('2026-10-01T09:15:00').getTime()
    for (let i = 0; i < 300; i++) {
      const ts = new Date(baseTime + i * 60000).toISOString()
      const price = 24000 // perfectly flat — EMAs converge
      candles.push(makeCandle(ts, price, price + 1, price - 1, price))
    }
    const trend = calcHigherTimeframeTrend(candles)
    expect(trend).toBe('Hold')
  })

  it('respects custom resample factor', () => {
    // With factor 1, it should behave like the regular EMA crossover
    const candles: Candle[] = []
    const baseTime = new Date('2026-10-01T09:15:00').getTime()
    for (let i = 0; i < 50; i++) {
      const ts = new Date(baseTime + i * 60000).toISOString()
      const price = 24000 + i * 5
      candles.push(makeCandle(ts, price, price + 5, price - 5, price + 3))
    }
    // With factor 1, need only 43 candles for EMA 42
    const trend = calcHigherTimeframeTrend(candles, 1)
    expect(trend).toBe('Buy')
  })
})
