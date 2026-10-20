import fs from 'node:fs'
import path from 'node:path'
import type { Candle, UnderlyingSymbol } from '../../../../../packages/shared/src/types'
import {
  findNearestExpiry,
} from '../contracts'
import { previousDateFromList } from '../time'
import type {
  ReplayDataset,
  ReplayDay,
} from '../types'
import {
  buildReplayDay,
  loadNiftySpotParquet,
  loadOptionExpiryParquet,
  type OptionFileData,
} from './parquet'

/**
 * Adapter for the `thetrademarkk/india-index-options-1m` layout:
 *
 *   <dataDir>/index/NIFTY.parquet
 *   <dataDir>/options/NIFTY/<expiry>.parquet
 *
 * The dataset is third-party (CC-BY-NC-4.0), rebuilt from NSE 1-minute
 * contract bars. It is useful for research, not for production pricing; the
 * report script labels it explicitly.
 */
export class HfNiftyDataset implements ReplayDataset {
  readonly symbol: UnderlyingSymbol = 'NIFTY 50'
  private readonly dataDir: string
  private spotByDate = new Map<string, Candle[]>()
  private sortedDates: string[] = []
  private expiries: string[] = []
  private optionCache = new Map<string, OptionFileData>()
  private loaded = false

  constructor(dataDir: string) {
    this.dataDir = dataDir
  }

  async load(): Promise<void> {
    if (this.loaded) return
    const spotPath = path.join(this.dataDir, 'index', 'NIFTY.parquet')
    if (!fs.existsSync(spotPath)) {
      throw new Error(
        `Spot parquet not found at ${spotPath}. Run: node scripts/options-replay/download-hf.mjs --from 2026-01-01 --to 2026-05-22`,
      )
    }
    this.spotByDate = await loadNiftySpotParquet(spotPath)
    this.sortedDates = [...this.spotByDate.keys()].sort()

    const optionsDir = path.join(this.dataDir, 'options', 'NIFTY')
    if (fs.existsSync(optionsDir)) {
      this.expiries = fs
        .readdirSync(optionsDir)
        .filter((file) => /^\d{4}-\d{2}-\d{2}\.parquet$/.test(file))
        .map((file) => file.replace(/\.parquet$/, ''))
        .sort()
    }
    this.loaded = true
  }

  get dates(): string[] {
    return this.sortedDates
  }

  get downloadedExpiries(): string[] {
    return this.expiries
  }

  nearestExpiry(date: string): string | null {
    return findNearestExpiry(this.expiries, date)
  }

  private async getOptionFile(expiry: string): Promise<OptionFileData> {
    const cached = this.optionCache.get(expiry)
    if (cached) {
      // Refresh LRU position.
      this.optionCache.delete(expiry)
      this.optionCache.set(expiry, cached)
      return cached
    }
    const filePath = path.join(
      this.dataDir,
      'options',
      'NIFTY',
      `${expiry}.parquet`,
    )
    const data = await loadOptionExpiryParquet(filePath, expiry)
    if (this.optionCache.size >= 3) {
      const oldest = this.optionCache.keys().next().value
      if (typeof oldest === 'string') this.optionCache.delete(oldest)
    }
    this.optionCache.set(expiry, data)
    return data
  }

  async getDay(date: string): Promise<ReplayDay | null> {
    if (!this.loaded) await this.load()
    const spotCandles = this.spotByDate.get(date)
    if (!spotCandles?.length) return null

    const previousDate = previousDateFromList(this.sortedDates, date)
    const previousCandles = previousDate
      ? this.spotByDate.get(previousDate) ?? []
      : []
    const expiry = this.nearestExpiry(date)
    if (!expiry) {
      return buildReplayDay({
        date,
        expiry: null,
        spotCandles,
        previousCandles,
        raw: null,
      })
    }

    const optionFile = await this.getOptionFile(expiry)
    return buildReplayDay({
      date,
      expiry,
      spotCandles,
      previousCandles,
      raw: optionFile.days.get(date) ?? null,
    })
  }
}
