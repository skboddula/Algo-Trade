import type { Candle } from '../../../../packages/shared/src/types'
import {
  IST_OFFSET_MS,
  NSE_TRADING_HOLIDAYS,
} from '../../../../packages/shared/src/timeUtils'

/** NSE cash/derivatives session bounds used by the dataset. */
export const MARKET_OPEN_MINUTE = 9 * 60 + 15 // 09:15 IST
export const MARKET_CLOSE_MINUTE = 15 * 60 + 30 // 15:30 IST (last 1-min bar)
export const SIGNAL_LAST_MINUTE = MARKET_CLOSE_MINUTE - 1 // no entry at the 15:30 bar
export const DATA_CLOSE_MINUTE = 15 * 60 + 30

export function istDate(iso: string): string {
  const date = new Date(new Date(iso).getTime() + IST_OFFSET_MS)
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(
    2,
    '0',
  )}-${String(date.getUTCDate()).padStart(2, '0')}`
}

export function istMinute(iso: string): number {
  const date = new Date(new Date(iso).getTime() + IST_OFFSET_MS)
  return date.getUTCHours() * 60 + date.getUTCMinutes()
}

export function parseHm(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!match) return fallback
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return fallback
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return fallback
  return hour * 60 + minute
}

export function isWeekendOrHoliday(date: string): boolean {
  const parsed = new Date(`${date}T00:00:00.000Z`)
  if (Number.isNaN(parsed.getTime())) return true
  const day = parsed.getUTCDay()
  return day === 0 || day === 6 || Boolean(NSE_TRADING_HOLIDAYS[date])
}

export function isTradingDate(date: string): boolean {
  return !isWeekendOrHoliday(date)
}

/**
 * Keeps only 09:15–15:30 IST bars, deduplicated by minute (last wins) and
 * sorted chronologically. The upstream files include pre-open and post-close
 * rows; this is the session boundary used by the strategy.
 */
export function sessionCandles(candles: Candle[]): Candle[] {
  const byMinute = new Map<number, Candle>()
  for (const candle of candles) {
    const parsed = Date.parse(candle[0])
    if (!Number.isFinite(parsed)) continue
    const minute = istMinute(candle[0])
    if (minute < MARKET_OPEN_MINUTE || minute > DATA_CLOSE_MINUTE) continue
    byMinute.set(minute, candle)
  }
  return [...byMinute.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([, candle]) => candle)
}

export function previousDateFromList(dates: string[], date: string): string | null {
  let previous: string | null = null
  for (const candidate of dates) {
    if (candidate >= date) break
    previous = candidate
  }
  return previous
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100
}

export function formatInr(value: number): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  }).format(value)
}
