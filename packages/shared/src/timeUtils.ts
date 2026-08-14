// Indian Standard Time (IST - UTC+05:30) Time Utilities
// Ensures deterministic timezone math on US / European cloud servers (e.g. GCP us-central1)

export const IST_OFFSET_MINUTES = 330 // +5 hours 30 minutes
export const IST_OFFSET_MS = IST_OFFSET_MINUTES * 60 * 1000

export interface IndiaTimeInfo {
  date: Date
  hour: number
  minute: number
  second: number
  dayOfWeek: number // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
  dateString: string // YYYY-MM-DD
  timeString: string // HH:mm:ss
  isMarketDay: boolean
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

  // Market days are Monday (1) to Friday (5)
  const isMarketDay = dayOfWeek >= 1 && dayOfWeek <= 5

  // Market hours are 09:15 to 15:30 IST
  const currentMinutesFromMidnight = hour * 60 + minute
  const marketOpenMinutes = 9 * 60 + 15 // 09:15
  const marketCloseMinutes = 15 * 60 + 30 // 15:30
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
    isMarketHours,
    isAfterCutoff,
  }
}

export function isMarketOpen(date: Date = new Date()): boolean {
  return getIndiaTime(date).isMarketHours
}
