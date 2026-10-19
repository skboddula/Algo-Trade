import { describe, it, expect } from 'vitest'
import { getPreviousTradingSessionDate } from '../utils/timeUtils'
import { buildHtfCandleHistory } from '../../../../packages/shared/src/candleHistory'
import type { Candle } from '../types'

const mkCandle = (ts: string, close: number): Candle => [
  new Date(ts).toISOString(),
  close,
  close + 1,
  close - 1,
  close,
  100,
]

describe('getPreviousTradingSessionDate', () => {
  it('returns the trading day before, skipping weekends', () => {
    // Friday 2026-08-14 23:30 IST → Thursday 2026-08-13
    expect(getPreviousTradingSessionDate(new Date('2026-08-14T18:00:00Z'))).toBe(
      '2026-08-13',
    )
    // Saturday 2026-08-15 00:00 IST → Friday 2026-08-14
    expect(getPreviousTradingSessionDate(new Date('2026-08-14T18:30:00Z'))).toBe(
      '2026-08-14',
    )
    // Monday 2026-08-17 09:30 IST → Friday 2026-08-14
    expect(getPreviousTradingSessionDate(new Date('2026-08-17T04:00:00Z'))).toBe(
      '2026-08-14',
    )
  })

  it('skips NSE trading holidays from the shared calendar', () => {
    // Wednesday 2026-10-21: Tuesday's Dussehra session never happened → Monday
    expect(getPreviousTradingSessionDate(new Date('2026-10-21T04:00:00Z'))).toBe(
      '2026-10-19',
    )
    // On the holiday itself (23:30 IST), the previous calendar day trades
    expect(getPreviousTradingSessionDate(new Date('2026-10-20T18:00:00Z'))).toBe(
      '2026-10-19',
    )
    // Holi 2026-03-03 (Tuesday) is skipped from Wednesday 2026-03-04
    expect(getPreviousTradingSessionDate(new Date('2026-03-04T04:00:00Z'))).toBe(
      '2026-03-02',
    )
    // Diwali-Balipratipada 2026-11-10 (Tuesday) is skipped from Wednesday
    expect(getPreviousTradingSessionDate(new Date('2026-11-11T04:00:00Z'))).toBe(
      '2026-11-09',
    )
  })
})

describe('buildHtfCandleHistory', () => {
  const prevSession = Array.from({ length: 7 }, (_, i) =>
    mkCandle(
      new Date(Date.UTC(2026, 9, 19, 3, 45) + i * 60_000).toISOString(),
      100 + i,
    ),
  )
  const today = Array.from({ length: 3 }, (_, i) =>
    mkCandle(
      new Date(Date.UTC(2026, 9, 21, 3, 45) + i * 60_000).toISOString(),
      200 + i,
    ),
  )

  it('returns the current series untouched without usable previous history', () => {
    // No previous session at all.
    expect(buildHtfCandleHistory([], today)).toBe(today)
    // Fewer candles than one resample group: ignored (it would only shift
    // today's 5-minute grouping).
    expect(buildHtfCandleHistory(today.slice(0, 3), today)).toBe(today)
  })

  it('trims the previous session to whole resample groups and appends today', () => {
    const merged = buildHtfCandleHistory(prevSession, today)
    // 7 previous candles → 5 kept (last two trimmed) + 3 today
    expect(merged).toHaveLength(8)
    expect(merged[0]).toBe(prevSession[0])
    expect(merged[4]).toBe(prevSession[4])
    expect(merged[5]).toBe(today[0])
    expect(merged[7]).toBe(today[2])
  })

  it('keeps group alignment: today starts a fresh 5-bar group', () => {
    const aligned = [...prevSession.slice(0, 5), ...today]
    expect(buildHtfCandleHistory(prevSession, today)).toEqual(aligned)
  })

  it('deduplicates overlapping timestamps (current wins) and sorts chronologically', () => {
    const previous = prevSession.slice(0, 5)
    const duplicateTs = previous[4][0]
    const current: Candle[] = [
      mkCandle(duplicateTs, 999),
      mkCandle(new Date(Date.UTC(2026, 9, 21, 3, 45, 59)).toISOString(), 300),
    ]
    const merged = buildHtfCandleHistory(previous, current)
    expect(merged).toHaveLength(6)
    expect(merged[4][4]).toBe(999) // current candle replaced the overlap
    expect(merged[5][4]).toBe(300)
    const times = merged.map((candle) => Date.parse(candle[0]))
    expect(times).toEqual([...times].sort((a, b) => a - b))
  })

  it('tolerates duplicate timestamps inside one session (last one wins)', () => {
    const doubled = [...today, mkCandle(today[0][0], 555)]
    const merged = buildHtfCandleHistory(prevSession, doubled)
    expect(merged).toHaveLength(5 + 3)
    expect(merged[5][4]).toBe(555)
  })
})
