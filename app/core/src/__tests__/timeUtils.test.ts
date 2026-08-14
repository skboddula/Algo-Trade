import { describe, it, expect } from 'vitest'
import { getIndiaTime, isMarketOpen } from '../utils/timeUtils'

describe('IST Time Utilities Suite', () => {
  it('correctly converts UTC timestamps to Indian Standard Time (UTC+05:30)', () => {
    // 03:45 UTC = 09:15 IST (Market Open)
    const marketOpenUtc = new Date('2026-08-14T03:45:00.000Z')
    const ist = getIndiaTime(marketOpenUtc)

    expect(ist.hour).toBe(9)
    expect(ist.minute).toBe(15)
    expect(ist.isMarketHours).toBe(true)
  })

  it('detects market hours between 09:15 and 15:30 IST on weekdays', () => {
    // 08:00 UTC = 13:30 IST (Mid-day trading) on Friday
    const midDay = new Date('2026-08-14T08:00:00.000Z')
    expect(isMarketOpen(midDay)).toBe(true)

    // 10:15 UTC = 15:45 IST (After market close)
    const afterClose = new Date('2026-08-14T10:15:00.000Z')
    expect(isMarketOpen(afterClose)).toBe(false)
  })

  it('identifies weekends as non-market days', () => {
    // Saturday 05:00 UTC
    const saturday = new Date('2026-08-15T05:00:00.000Z')
    const ist = getIndiaTime(saturday)
    expect(ist.isMarketDay).toBe(false)
    expect(ist.isMarketHours).toBe(false)
  })

  it('correctly evaluates last entry time cutoff in IST', () => {
    // 09:44 UTC = 15:14 IST (Before 15:15 cutoff)
    const beforeCutoff = new Date('2026-08-14T09:44:00.000Z')
    const istBefore = getIndiaTime(beforeCutoff)
    expect(istBefore.isAfterCutoff('15:15')).toBe(false)

    // 09:46 UTC = 15:16 IST (After 15:15 cutoff)
    const afterCutoff = new Date('2026-08-14T09:46:00.000Z')
    const istAfter = getIndiaTime(afterCutoff)
    expect(istAfter.isAfterCutoff('15:15')).toBe(true)
  })
})
