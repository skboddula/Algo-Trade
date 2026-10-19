import type { Candle } from './types'

const candleTimeMs = (candle: Candle): number => Date.parse(candle[0])

/**
 * Builds the input series for the multi-timeframe trend (`calcHigherTimeframeTrend`):
 * the previous trading session's 1-minute candles followed by the current
 * session's candles, deduplicated (current wins) and in chronological order.
 *
 * The previous session is trimmed to a whole number of `resampleFactor` bars.
 * `resampleCandles` groups the array by index, so trimming keeps the current
 * session's 5-minute groups aligned exactly as if the series had started at
 * today's open — the pre-seed only lengthens the EMA warm-up, it never shifts
 * today's group boundaries.
 *
 * The daemon and the browser bot must compose this series identically
 * (same helper, same inputs from the same Upstox endpoints) so their
 * multi-timeframe verdicts stay in parity.
 */
export function buildHtfCandleHistory(
  previous: Candle[],
  current: Candle[],
  resampleFactor = 5,
): Candle[] {
  if (!previous.length) return current

  // Ignore a previous session shorter than one resample group (it would only
  // shift the current session's grouping).
  const usable =
    resampleFactor <= 1
      ? previous
      : previous.length >= resampleFactor
        ? previous.slice(0, previous.length - (previous.length % resampleFactor))
        : []
  if (!usable.length) return current

  const byTimestamp = new Map<number, Candle>()
  for (const candle of usable) {
    const ts = candleTimeMs(candle)
    if (Number.isFinite(ts)) byTimestamp.set(ts, candle)
  }
  for (const candle of current) {
    const ts = candleTimeMs(candle)
    if (Number.isFinite(ts)) byTimestamp.set(ts, candle)
  }

  return [...byTimestamp.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, candle]) => candle)
}
