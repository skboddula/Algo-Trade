import type { OptionData, UnderlyingSymbol } from '../../../../packages/shared/src/types'
import type { OptionBar, OptionSeries } from './types'

/** NIFTY F&O lot size for the 2026 replay window. */
export const NIFTY_50_LOT_SIZE = 75

export function lotSizeForSymbol(
  symbol: UnderlyingSymbol,
  date = '2026-01-01',
): number {
  switch (symbol) {
    case 'NIFTY 50':
      // NSE revised NIFTY from 50 to 75 effective Nov 2024. The daemon uses
      // the same current contract lot so paper and replay P&L reconcile.
      return date >= '2024-11-20' ? 75 : 50
    case 'BANKNIFTY':
      return date >= '2024-11-20' ? 30 : 15
    case 'FINNIFTY':
      return date >= '2024-11-20' ? 65 : 25
  }
}

export function optionKey(strike: number, side: 'CE' | 'PE'): string {
  return `${strike}:${side}`
}

export interface SelectedContract {
  strike: number
  side: 'CE' | 'PE'
  instrumentKey: string
  tradingSymbol: string
  price: number
  lotSize: number
}

/**
 * Mirrors `pickBestOptionContract` in the daemon: sort strikes, find the ATM
 * strike, step `otmSkip` strikes up for CE / down for PE, and read that leg.
 *
 * The replay adds a distance guard: if the chain is missing the ATM region
 * (sparse historical option data), it refuses to substitute a far-away strike
 * that production would never have selected.
 */
export function selectOptionContract(
  chain: OptionData[],
  spot: number,
  direction: 'CE' | 'PE',
  otmSkip: number,
  lotSize: number,
  maxStrikeDistancePct = 3,
): SelectedContract | null {
  if (!chain.length || !Number.isFinite(spot) || spot <= 0) return null
  const sorted = [...chain].sort((left, right) => left.strike_price - right.strike_price)
  if (!sorted.length) return null

  let closest = 0
  let minDiff = Number.POSITIVE_INFINITY
  for (let index = 0; index < sorted.length; index += 1) {
    const diff = Math.abs(sorted[index].strike_price - spot)
    if (diff < minDiff) {
      minDiff = diff
      closest = index
    }
  }

  const atmDistancePct = (minDiff / spot) * 100
  if (atmDistancePct > maxStrikeDistancePct) return null

  const target =
    direction === 'CE'
      ? Math.min(sorted.length - 1, closest + Math.max(0, otmSkip))
      : Math.max(0, closest - Math.max(0, otmSkip))
  const row = sorted[target]
  if (!row) return null
  const selectedDistancePct = (Math.abs(row.strike_price - spot) / spot) * 100
  if (selectedDistancePct > maxStrikeDistancePct) return null

  const leg = direction === 'CE' ? row.call_options : row.put_options
  if (!leg || !leg.instrument_key) return null
  const price = leg.market_data?.ltp ?? 0
  if (!Number.isFinite(price) || price <= 0) return null

  return {
    strike: row.strike_price,
    side: direction,
    instrumentKey: leg.instrument_key,
    tradingSymbol:
      leg.trading_symbol ?? `NIFTY_${row.strike_price}_${direction}`,
    price,
    lotSize,
  }
}

/** Nearest strictly future expiry, matching the daemon's CR-12 0-DTE skip. */
export function findNearestExpiry(
  expiries: string[],
  date: string,
): string | null {
  const upcoming = expiries
    .filter((expiry) => /^\d{4}-\d{2}-\d{2}$/.test(expiry) && expiry > date)
    .sort()
  return upcoming[0] ?? null
}

function lowerBoundByMinute(bars: OptionBar[], minute: number): number {
  let low = 0
  let high = bars.length
  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    if (bars[mid].minute < minute) low = mid + 1
    else high = mid
  }
  return low
}

export function seriesAtOrBefore(
  series: OptionSeries,
  minute: number,
): OptionBar | undefined {
  const index = lowerBoundByMinute(series.bars, minute)
  if (index < series.bars.length && series.bars[index].minute === minute) {
    return series.bars[index]
  }
  return index > 0 ? series.bars[index - 1] : undefined
}

export function seriesFirstAtOrAfter(
  series: OptionSeries,
  minute: number,
): OptionBar | undefined {
  const index = lowerBoundByMinute(series.bars, minute)
  return series.bars[index]
}
