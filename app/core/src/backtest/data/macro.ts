import type { McMarketItem } from '../../../../../packages/shared/src/types'
import type {
  MacroBar,
  MacroDay,
  YahooMacroFile,
  YahooMacroSymbol,
} from '../types'

const GLOBAL_SYMBOLS: Array<{ key: string; label: string }> = [
  { key: '^GSPC', label: 'S&P 500' },
  { key: '^IXIC', label: 'NASDAQ' },
  { key: '^DJI', label: 'Dow Jones' },
  { key: '^N225', label: 'Nikkei 225' },
  { key: '^HSI', label: 'Hang Seng' },
  { key: '^FTSE', label: 'FTSE 100' },
  { key: '^GDAXI', label: 'DAX' },
  { key: 'USDINR=X', label: 'USD/INR' },
  { key: 'BZ=F', label: 'Brent Oil' },
  { key: 'GC=F', label: 'Gold' },
]

const VIX_KEY = '^INDIAVIX'

function findLastBefore(bars: MacroBar[], date: string): number {
  let low = 0
  let high = bars.length
  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    if (bars[mid].date < date) low = mid + 1
    else high = mid
  }
  return low - 1
}

function findExact(bars: MacroBar[], date: string): number {
  let low = 0
  let high = bars.length
  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    if (bars[mid].date < date) low = mid + 1
    else high = mid
  }
  return low < bars.length && bars[low].date === date ? low : -1
}

function changePct(bars: MacroBar[], index: number): number | null {
  if (index <= 0) return null
  const current = bars[index].close
  const previous = bars[index - 1].close
  if (current == null || previous == null || previous <= 0) return null
  return Math.round(((current - previous) / previous) * 10_000) / 100
}

/**
 * Builds the point-in-time macro inputs used by the replay:
 *
 * - Global indices: last completed daily bar strictly before the IST session
 *   date (the previous US/Europe/Asia close, which is known by 09:15 IST).
 * - India VIX: current day's daily open when available, otherwise the last
 *   completed close. This is a daily proxy, not the live intraday VIX.
 *
 * Missing symbols are omitted rather than silently neutral-filled.
 */
export class MacroSeries {
  private readonly symbols: Record<string, YahooMacroSymbol>

  constructor(file: YahooMacroFile) {
    this.symbols = file.symbols ?? {}
    for (const symbol of Object.values(this.symbols)) {
      symbol.bars.sort((left, right) => left.date.localeCompare(right.date))
    }
  }

  private barsFor(key: string): MacroBar[] {
    return this.symbols[key]?.bars ?? []
  }

  getDay(date: string): MacroDay {
    const items: McMarketItem[] = []
    for (const symbol of GLOBAL_SYMBOLS) {
      const bars = this.barsFor(symbol.key)
      if (!bars.length) continue
      const index = findLastBefore(bars, date)
      if (index < 0) continue
      const pct = changePct(bars, index)
      if (pct == null) continue
      items.push({ symbol: symbol.label, change_per: pct })
    }

    const vixBars = this.barsFor(VIX_KEY)
    let vix: number | null = null
    let vixSource: MacroDay['vixSource'] = 'missing'
    const exact = findExact(vixBars, date)
    if (exact >= 0) {
      const open = vixBars[exact].open
      const close = vixBars[exact].close
      if (open != null && open > 0) {
        vix = open
        vixSource = 'daily-open'
      } else if (close != null && close > 0) {
        vix = close
        vixSource = 'daily-open'
      }
    }
    if (vix == null) {
      const before = findLastBefore(vixBars, date)
      if (before >= 0) {
        const close = vixBars[before].close
        if (close != null && close > 0) {
          vix = close
          vixSource = 'previous-close'
        }
      }
    }

    return {
      date,
      items,
      vix,
      vixSource,
      symbolsWithData: items.length,
    }
  }
}

export function emptyMacroFile(): YahooMacroFile {
  return {
    source: 'unavailable',
    fetchedAt: new Date(0).toISOString(),
    symbols: {},
  }
}
