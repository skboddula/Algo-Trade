import fs from 'node:fs'
import { parquetReadObjects, type AsyncBuffer } from 'hyparquet'
import { compressors } from 'hyparquet-compressors'
import type { Candle, OptionData } from '../../../../../packages/shared/src/types'
import { optionKey } from '../contracts'
import {
  DATA_CLOSE_MINUTE,
  MARKET_OPEN_MINUTE,
  istDate,
  istMinute,
  isTradingDate,
  sessionCandles,
} from '../time'
import type {
  OptionBar,
  OptionDayRaw,
  OptionSeries,
  ReplayDay,
} from '../types'

type Row = Record<string, unknown>

const asNumber = (value: unknown): number => {
  if (typeof value === 'bigint') return Number(value)
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

const asString = (value: unknown): string => {
  if (typeof value === 'string') return value
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8')
  if (value == null) return ''
  return String(value)
}

const asDateString = (value: unknown): string => {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '' : istDate(value.toISOString())
  }
  if (typeof value === 'string') {
    const match = /^(\d{4}-\d{2}-\d{2})/.exec(value)
    if (match) return match[1]
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime()) ? '' : istDate(parsed.toISOString())
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    const parsed = new Date(Number(value))
    return Number.isNaN(parsed.getTime()) ? '' : istDate(parsed.toISOString())
  }
  return ''
}

const asIso = (value: unknown): string | null => {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString()
  }
  if (typeof value === 'string') {
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
  }
  if (typeof value === 'number') {
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
  }
  if (typeof value === 'bigint') {
    const parsed = new Date(Number(value))
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
  }
  return null
}

async function readRows(path: string, columns: string[]): Promise<Row[]> {
  const buffer = fs.readFileSync(path)
  const arrayBuffer = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer
  const file: AsyncBuffer = {
    byteLength: arrayBuffer.byteLength,
    slice: async (start, end) => arrayBuffer.slice(start, end),
  }
  const rows = await parquetReadObjects({ file, compressors, columns })
  return rows as Row[]
}

export interface OptionFileData {
  expiry: string
  days: Map<string, OptionDayRaw>
}

/**
 * Loads the HF `index/NIFTY.parquet` spot file into session-scoped candles.
 * Pre-open/post-close rows are removed; holidays are skipped.
 */
export async function loadNiftySpotParquet(
  path: string,
): Promise<Map<string, Candle[]>> {
  const rows = await readRows(path, [
    'timestamp',
    'open',
    'high',
    'low',
    'close',
    'volume',
    'trading_day',
  ])
  const grouped = new Map<string, Candle[]>()
  for (const row of rows) {
    const timestamp = asIso(row.timestamp)
    if (!timestamp) continue
    const date = asDateString(row.trading_day) || istDate(timestamp)
    if (!isTradingDate(date)) continue
    const open = asNumber(row.open)
    const high = asNumber(row.high)
    const low = asNumber(row.low)
    const close = asNumber(row.close)
    if (close <= 0 || high <= 0 || low <= 0 || open <= 0) continue
    if (high < low) continue
    const candle: Candle = [
      timestamp,
      open,
      high,
      low,
      close,
      asNumber(row.volume),
    ]
    const bucket = grouped.get(date) ?? []
    bucket.push(candle)
    grouped.set(date, bucket)
  }

  const sessions = new Map<string, Candle[]>()
  for (const [date, candles] of grouped) {
    const session = sessionCandles(candles)
    if (session.length) sessions.set(date, session)
  }
  return sessions
}

/**
 * Loads one expiry's 1-minute option bars. Rows are grouped by IST trading
 * day and strike/side; duplicate minutes are collapsed (last row wins).
 */
export async function loadOptionExpiryParquet(
  path: string,
  expiryFromName: string,
): Promise<OptionFileData> {
  const rows = await readRows(path, [
    'timestamp',
    'open',
    'high',
    'low',
    'close',
    'volume',
    'open_interest',
    'trading_day',
    'strike',
    'option_type',
    'expiry',
  ])

  let expiry = expiryFromName
  const rawDays = new Map<string, Map<string, Map<number, OptionBar>>>()
  for (const row of rows) {
    const timestamp = asIso(row.timestamp)
    if (!timestamp) continue
    const date = asDateString(row.trading_day) || istDate(timestamp)
    if (!isTradingDate(date)) continue
    const minute = istMinute(timestamp)
    if (minute < MARKET_OPEN_MINUTE || minute > DATA_CLOSE_MINUTE) continue

    const sideRaw = asString(row.option_type).toUpperCase()
    if (sideRaw !== 'CE' && sideRaw !== 'PE') continue
    const side = sideRaw
    const strike = asNumber(row.strike)
    if (!Number.isFinite(strike) || strike <= 0) continue
    const open = asNumber(row.open)
    const high = asNumber(row.high)
    const low = asNumber(row.low)
    const close = asNumber(row.close)
    if (open <= 0 || high <= 0 || low <= 0 || close <= 0 || high < low) continue

    const rowExpiry = asDateString(row.expiry)
    if (rowExpiry) expiry = rowExpiry

    const bar: OptionBar = {
      timestamp,
      istDate: date,
      minute,
      strike,
      side,
      open,
      high,
      low,
      close,
      volume: asNumber(row.volume),
      oi: Math.max(0, asNumber(row.open_interest)),
    }

    const day = rawDays.get(date) ?? new Map<string, Map<number, OptionBar>>()
    const key = optionKey(strike, side)
    const series = day.get(key) ?? new Map<number, OptionBar>()
    series.set(minute, bar)
    day.set(key, series)
    rawDays.set(date, day)
  }

  const days = new Map<string, OptionDayRaw>()
  for (const [date, rawSeries] of rawDays) {
    const series = new Map<string, OptionSeries>()
    const strikes = new Set<number>()
    for (const [key, byMinute] of rawSeries) {
      const bars = [...byMinute.values()].sort((left, right) => left.minute - right.minute)
      if (!bars.length) continue
      const first = bars[0]
      series.set(key, {
        strike: first.strike,
        side: first.side,
        bars,
        byMinute,
      })
      strikes.add(first.strike)
    }
    if (series.size) {
      days.set(date, {
        expiry,
        series,
        strikes: [...strikes].sort((left, right) => left - right),
      })
    }
  }

  return { expiry, days }
}

interface LastQuote {
  bar: OptionBar
  oi: number
}

/**
 * Builds one replay day, including a forward-filled option-chain snapshot for
 * every session minute. OI zeros are treated as missing and carried forward;
 * the last positive OI is what the live chain would have shown.
 */
export function buildReplayDay(input: {
  date: string
  expiry: string | null
  spotCandles: Candle[]
  previousCandles: Candle[]
  raw: OptionDayRaw | null
}): ReplayDay {
  const { date, expiry, spotCandles, previousCandles, raw } = input
  const optionSeries = raw?.series ?? new Map<string, OptionSeries>()
  const strikes = raw?.strikes ?? []
  const seriesList = [...optionSeries.values()]
  const snapshots = new Map<number, OptionData[]>()

  if (seriesList.length) {
    const pointers = new Array<number>(seriesList.length).fill(0)
    const last = new Map<string, LastQuote>()
    for (let minute = MARKET_OPEN_MINUTE; minute <= DATA_CLOSE_MINUTE; minute += 1) {
      for (let index = 0; index < seriesList.length; index += 1) {
        const series = seriesList[index]
        let pointer = pointers[index]
        while (pointer < series.bars.length && series.bars[pointer].minute <= minute) {
          const bar = series.bars[pointer]
          const key = optionKey(bar.strike, bar.side)
          const previousOi = last.get(key)?.oi ?? 0
          last.set(key, {
            bar,
            oi: bar.oi > 0 ? bar.oi : previousOi,
          })
          pointer += 1
        }
        pointers[index] = pointer
      }

      const byStrike = new Map<
        number,
        { ce?: LastQuote; pe?: LastQuote }
      >()
      for (const quote of last.values()) {
        const row = byStrike.get(quote.bar.strike) ?? {}
        if (quote.bar.side === 'CE') row.ce = quote
        else row.pe = quote
        byStrike.set(quote.bar.strike, row)
      }

      const chain: OptionData[] = []
      for (const [strike, legs] of [...byStrike.entries()].sort(
        (left, right) => left[0] - right[0],
      )) {
        const instrument = (side: 'CE' | 'PE') =>
          `HF|NIFTY|${expiry ?? 'unknown'}|${strike}|${side}`
        chain.push({
          expiry: expiry ?? date,
          strike_price: strike,
          underlying_spot_price: 0,
          call_options: {
            instrument_key: instrument('CE'),
            trading_symbol: `NIFTY ${expiry ?? date} ${strike} CE`,
            market_data: {
              ltp: legs.ce?.bar.close ?? 0,
              volume: legs.ce?.bar.volume ?? 0,
              oi: legs.ce?.oi ?? 0,
            },
          },
          put_options: {
            instrument_key: instrument('PE'),
            trading_symbol: `NIFTY ${expiry ?? date} ${strike} PE`,
            market_data: {
              ltp: legs.pe?.bar.close ?? 0,
              volume: legs.pe?.bar.volume ?? 0,
              oi: legs.pe?.oi ?? 0,
            },
          },
        })
      }
      snapshots.set(minute, chain)
    }
  }

  const chainAt = (minute: number, spot: number): OptionData[] => {
    const chain = snapshots.get(minute) ?? []
    for (const row of chain) row.underlying_spot_price = spot
    return chain
  }

  return {
    date,
    expiry,
    spotCandles,
    previousCandles,
    optionSeries,
    strikes,
    chainAt,
  }
}
