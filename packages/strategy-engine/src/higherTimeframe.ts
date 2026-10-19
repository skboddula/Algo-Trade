import {
  SIGNAL_BUY,
  SIGNAL_HOLD,
  SIGNAL_SELL,
} from '../../shared/src/constants'
import type { Candle, SignalType } from '../../shared/src/types'

/**
 * Resamples 1-minute candles into higher-timeframe candles by aggregating
 * every `factor` consecutive bars into one (open=first, high=max, low=min,
 * close=last, volume=sum). The final partial group is included.
 */
export function resampleCandles(candles: Candle[], factor: number): Candle[] {
  if (factor <= 1 || candles.length === 0) return candles
  const out: Candle[] = []
  for (let i = 0; i < candles.length; i += factor) {
    const group = candles.slice(i, i + factor)
    if (group.length === 0) continue
    const open = group[0][1]
    const high = Math.max(...group.map((c) => c[2]))
    const low = Math.min(...group.map((c) => c[3]))
    const close = group[group.length - 1][4]
    const volume = group.reduce((s, c) => s + (c[5] ?? 0), 0)
    out.push([group[0][0], open, high, low, close, volume, undefined])
  }
  return out
}

function updateEMA(prev: number, price: number, k: number): number {
  return price * k + prev * (1 - k)
}

/**
 * Computes the EMA 10/42 trend on 5-minute resampled candles.
 * Returns 'Buy' (bullish), 'Sell' (bearish), or 'Hold' (neutral/insufficient
 * data). Used as a multi-timeframe confluence filter to block counter-trend
 * entries.
 */
export function calcHigherTimeframeTrend(
  candles: Candle[],
  resampleFactor = 5,
  fastPeriod = 10,
  slowPeriod = 42,
): SignalType {
  const resampled = resampleCandles(candles, resampleFactor)
  if (resampled.length < slowPeriod + 1) return SIGNAL_HOLD
  const closes = resampled.map((c) => c[4])
  const fastK = 2 / (fastPeriod + 1)
  const slowK = 2 / (slowPeriod + 1)
  let fastEMA = closes[0]
  let slowEMA = closes[0]
  for (let i = 1; i < closes.length; i++) {
    fastEMA = updateEMA(fastEMA, closes[i], fastK)
    slowEMA = updateEMA(slowEMA, closes[i], slowK)
  }
  if (fastEMA > slowEMA) return SIGNAL_BUY
  if (fastEMA < slowEMA) return SIGNAL_SELL
  return SIGNAL_HOLD
}
