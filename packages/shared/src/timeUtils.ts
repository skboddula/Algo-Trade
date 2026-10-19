// Indian Standard Time (IST - UTC+05:30) Time Utilities
// Ensures deterministic timezone math on US / European cloud servers (e.g. GCP us-central1)

export const IST_OFFSET_MINUTES = 330 // +5 hours 30 minutes
export const IST_OFFSET_MS = IST_OFFSET_MINUTES * 60 * 1000

/**
 * NSE trading holidays for the equity + F&O segments, maintained yearly from
 * the official exchange holiday circular (nseindia.com). Formation or
 * settlement-only holidays (e.g. Id-E-Milad 2026-08-26 — a settlement
 * holiday) are NOT listed here: markets trade on those days. One-off
 * closures (e.g. Maharashtra municipal elections, 2026-01-15) belong here too.
 * Muhurat sessions (e.g. the evening of 2026-11-08) are special one-hour
 * sessions the daemon intentionally does not trade.
 */
export const NSE_TRADING_HOLIDAYS: Readonly<Record<string, string>> = {
  '2026-01-15': 'Municipal Corporation Elections (Maharashtra)',
  '2026-01-26': 'Republic Day',
  '2026-03-03': 'Holi',
  '2026-03-26': 'Shri Ram Navami',
  '2026-03-31': 'Shri Mahavir Jayanti',
  '2026-04-03': 'Good Friday',
  '2026-04-14': 'Dr. Baba Saheb Ambedkar Jayanti',
  '2026-05-01': 'Maharashtra Day',
  '2026-05-28': 'Bakri Eid',
  '2026-06-26': 'Moharram',
  '2026-09-14': 'Ganesh Chaturthi',
  '2026-10-02': 'Mahatma Gandhi Jayanti',
  '2026-10-20': 'Dussehra',
  '2026-11-10': 'Diwali-Balipratipada',
  '2026-11-24': 'Prakash Gurpurb Sri Guru Nanak Dev',
  '2026-12-25': 'Christmas',
}

export interface IndiaTimeInfo {
  date: Date
  hour: number
  minute: number
  second: number
  dayOfWeek: number // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
  dateString: string // YYYY-MM-DD
  timeString: string // HH:mm:ss
  isMarketDay: boolean
  isMarketHoliday: boolean
  isMarketHours: boolean
  isAfterCutoff: (cutoffTimeStr: string) => boolean
}

export function getIndiaTime(date: Date = new Date()): IndiaTimeInfo {
  // Convert UTC timestamp to IST by adding 330 minutes
  const utcMs = date.getTime()
  const istDate = new Date(utcMs + IST_OFFSET_MS)

  const year = istDate.getUTCFullYear()
  const month = String(istDate.getUTCMonth() + 1).padStart(2, '0')
  const day = String(istDate.getUTCDate()).padStart(2, '0')
  const hour = istDate.getUTCHours()
  const minute = istDate.getUTCMinutes()
  const second = istDate.getUTCSeconds()
  const dayOfWeek = istDate.getUTCDay()

  const dateString = `${year}-${month}-${day}`
  const timeString = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`

  // Market days are Monday (1) to Friday (5), excluding NSE trading holidays
  const holidayName = NSE_TRADING_HOLIDAYS[dateString] ?? null
  const isMarketHoliday = holidayName !== null
  const isMarketDay = dayOfWeek >= 1 && dayOfWeek <= 5 && !isMarketHoliday

  // Market hours are 09:15 to 15:40 IST — the equity-derivatives segment
  // close was extended to 15:40 (NSE Closing Auction Session alignment,
  // per nseindia.com: "Equity Derivatives Segment: 9:15 am to 3:40 pm")
  const currentMinutesFromMidnight = hour * 60 + minute
  const marketOpenMinutes = 9 * 60 + 15 // 09:15
  const marketCloseMinutes = 15 * 60 + 40 // 15:40
  const isMarketHours =
    isMarketDay &&
    currentMinutesFromMidnight >= marketOpenMinutes &&
    currentMinutesFromMidnight <= marketCloseMinutes

  const isAfterCutoff = (cutoffTimeStr: string): boolean => {
    const [ch, cm] = (cutoffTimeStr || '15:15').split(':').map(Number)
    if (!Number.isFinite(ch) || !Number.isFinite(cm)) return false
    const cutoffMinutes = ch * 60 + cm
    return currentMinutesFromMidnight >= cutoffMinutes
  }

  return {
    date: istDate,
    hour,
    minute,
    second,
    dayOfWeek,
    dateString,
    timeString,
    isMarketDay,
    isMarketHoliday,
    isMarketHours,
    isAfterCutoff,
  }
}

export function isMarketOpen(date: Date = new Date()): boolean {
  return getIndiaTime(date).isMarketHours
}

/**
 * The most recent NSE trading session strictly before the given instant's IST
 * calendar day, as `YYYY-MM-DD` (weekends and the holiday calendar skipped).
 *
 * Used by both runtimes to pre-seed the multi-timeframe trend with the
 * previous session's 1-minute candles, so the 5-minute EMA 10/42 filter is
 * warm from the open instead of abstaining until ~12:45 IST.
 */
export function getPreviousTradingSessionDate(
  date: Date = new Date(),
): string {
  // Start at the IST calendar day before `date`. `getIndiaTime().date` carries
  // IST wall-clock fields in its UTC components, so UTC math on it stays in IST.
  const istToday = getIndiaTime(date)
  let cursorMs =
    Date.UTC(
      istToday.date.getUTCFullYear(),
      istToday.date.getUTCMonth(),
      istToday.date.getUTCDate(),
    ) - 86_400_000

  for (let i = 0; i < 30; i++) {
    const cursor = new Date(cursorMs)
    const dateString = `${cursor.getUTCFullYear()}-${String(
      cursor.getUTCMonth() + 1,
    ).padStart(2, '0')}-${String(cursor.getUTCDate()).padStart(2, '0')}`
    const dayOfWeek = cursor.getUTCDay()
    if (
      dayOfWeek >= 1 &&
      dayOfWeek <= 5 &&
      !NSE_TRADING_HOLIDAYS[dateString]
    ) {
      return dateString
    }
    cursorMs -= 86_400_000
  }

  // Unreachable with a sane calendar (< 30 consecutive non-trading days).
  return new Date(cursorMs).toISOString().slice(0, 10)
}

/** Name of the NSE trading holiday on this date (IST), or null if none. */
export function getNseHolidayName(date: Date = new Date()): string | null {
  return NSE_TRADING_HOLIDAYS[getIndiaTime(date).dateString] ?? null
}
