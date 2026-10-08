import { EventEmitter } from 'events'
import type {
  UnderlyingSymbol,
  MarketSnapshot,
  Candle,
  OptionData,
  VrdData,
  AllSignalData,
} from '../types'
import { UNDERLYING_INSTRUMENT_KEYS } from '../types'
import { computeAllIndicators } from './indicators'
import { getFinalSignal } from './strategyEngine'
import { DEFAULT_STRATEGY_CONFIG } from '../constants'
import { getIndiaTime } from '../utils/timeUtils'
import { fetchWithRetry } from '../utils/http/fetchRetry'

export interface MasterIngestorConfig {
  pollingIntervalMs: number
  upstoxApiBaseUrl: string
  primaryUpstoxToken?: string
  mockMode?: boolean
}

export class MasterIngestionEngine extends EventEmitter {
  private isRunning = false
  private timer: NodeJS.Timeout | null = null
  private candleBuffer: Map<UnderlyingSymbol, Candle[]> = new Map()
  private latestSnapshots: Map<UnderlyingSymbol, MarketSnapshot> = new Map()
  private latestOptionChains: Map<UnderlyingSymbol, OptionData[]> = new Map()
  private latestVrd: VrdData | null = null
  private config: MasterIngestorConfig

  constructor(config?: Partial<MasterIngestorConfig>) {
    super()
    this.setMaxListeners(100) // Prevent memory leak warnings on high subscriber counts
    this.config = {
      pollingIntervalMs: config?.pollingIntervalMs ?? 2000,
      upstoxApiBaseUrl: config?.upstoxApiBaseUrl ?? 'https://api.upstox.com/v2',
      primaryUpstoxToken: config?.primaryUpstoxToken,
      mockMode: config?.mockMode ?? false,
    }

    // Seed initial candle buffer
    for (const sym of ['NIFTY 50', 'BANKNIFTY', 'FINNIFTY'] as UnderlyingSymbol[]) {
      this.candleBuffer.set(sym, this.generateSeedCandles(sym))
    }
  }

  public setToken(token: string) {
    this.config.primaryUpstoxToken = token
  }

  public getPrimaryToken(): string | null {
    return this.config.primaryUpstoxToken ?? null
  }

  public setMockMode(enabled: boolean) {
    this.config.mockMode = enabled
  }

  public start() {
    if (this.isRunning) return
    this.isRunning = true
    this.runTick()
  }

  public stop() {
    this.isRunning = false
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  public getSnapshot(symbol: UnderlyingSymbol): MarketSnapshot | undefined {
    return this.latestSnapshots.get(symbol)
  }

  public getAllSnapshots(): Record<UnderlyingSymbol, MarketSnapshot> {
    const result: Partial<Record<UnderlyingSymbol, MarketSnapshot>> = {}
    for (const [sym, snap] of this.latestSnapshots.entries()) {
      result[sym] = snap
    }
    return result as Record<UnderlyingSymbol, MarketSnapshot>
  }

  public getOptionChain(symbol: UnderlyingSymbol): OptionData[] {
    return this.latestOptionChains.get(symbol) || []
  }

  private async runTick() {
    if (!this.isRunning) return

    try {
      await this.fetchAndComputeMarketData()
    } catch (err) {
      if (this.listenerCount('error') > 0) {
        this.emit('error', err)
      }
    } finally {
      if (this.isRunning) {
        this.timer = setTimeout(() => this.runTick(), this.config.pollingIntervalMs)
      }
    }
  }

  public async fetchAndComputeMarketData() {
    const symbols: UnderlyingSymbol[] = ['NIFTY 50', 'BANKNIFTY', 'FINNIFTY']
    const istInfo = getIndiaTime()
    const timestamp = istInfo.date.toISOString()

    for (const symbol of symbols) {
      let spotPrice = 24000
      let candles = this.candleBuffer.get(symbol) || []
      let optionChain: OptionData[] = this.latestOptionChains.get(symbol) || []

      if (this.config.mockMode || !this.config.primaryUpstoxToken) {
        // Mock generation for testing / non-market hours
        const lastClose = candles.length ? candles[candles.length - 1][4] : (symbol === 'NIFTY 50' ? 24500 : 51500)
        const delta = (Math.random() - 0.49) * (symbol === 'NIFTY 50' ? 10 : 25)
        const newClose = Math.round((lastClose + delta) * 100) / 100
        spotPrice = newClose

        const newCandle: Candle = [
          timestamp,
          lastClose,
          Math.max(lastClose, newClose) + 2,
          Math.min(lastClose, newClose) - 2,
          newClose,
          Math.floor(Math.random() * 5000) + 1000,
        ]

        candles = [...candles.slice(-99), newCandle]
        this.candleBuffer.set(symbol, candles)

        if (!optionChain.length) {
          optionChain = this.generateMockOptionChain(spotPrice)
          this.latestOptionChains.set(symbol, optionChain)
        }
      } else {
        // Live Upstox fetch from primary token
        try {
          const instrumentKey = UNDERLYING_INSTRUMENT_KEYS[symbol]
          const quoteRes = await fetchWithRetry(
            `${this.config.upstoxApiBaseUrl}/market-quote/quotes?instrument_key=${encodeURIComponent(instrumentKey)}`,
            {
              headers: {
                Authorization: `Bearer ${this.config.primaryUpstoxToken}`,
                Accept: 'application/json',
              },
            },
          )

          if (quoteRes.ok) {
            const data = (await quoteRes.json()) as any
            const quote = data?.data?.[instrumentKey.replace('|', ':')] || Object.values(data?.data || {})[0] as any
            if (quote?.last_price) {
              spotPrice = quote.last_price
            }
          }
        } catch {
          // Fallback to previous price on network glitch
          spotPrice = candles.length ? candles[candles.length - 1][4] : 24500
        }
      }

      // Compute indicators and scoring ONCE
      const indicators = computeAllIndicators(candles, optionChain)
      const vrdData: VrdData = this.latestVrd ?? {
        mmi: { score: 45, label: 'Fear' },
        advancesDeclines: { advances: 30, declines: 20, ratio: 1.5, label: 'Healthy Breadth' },
        fiiLongShort: { longPct: 58, shortPct: 42, shortPctTrend: 'Rising' },
        fiiPositioning: { netPosition: 450, consecutiveShortDays: 0 },
        pcr: { value: indicators.pcrValue, zone: 'buy' },
        straddleIv: { elevated: false, percentAboveAvg: 0 },
        niftyPe: { pe: 21.5, label: 'Fair Value' },
        vix: 14.2,
        giftNifty: { price: spotPrice + 10, changePts: 10, changePct: 0.05, openingSignal: 'Flat' },
        supportWall: Math.floor(spotPrice / 100) * 100 - 200,
        resistanceWall: Math.floor(spotPrice / 100) * 100 + 200,
        maxPain: Math.round(spotPrice / 50) * 50,
        fetchedAt: timestamp,
      }

      const signalData: AllSignalData = {
        v3: indicators.ema === 'Buy' ? 'buy' : indicators.ema === 'Sell' ? 'sell' : 'hold',
        indicators,
        vrd: vrdData,
      }

      const finalSignal = getFinalSignal(signalData, DEFAULT_STRATEGY_CONFIG)

      const snapshot: MarketSnapshot = {
        timestamp,
        underlyingSymbol: symbol,
        spotPrice,
        candles,
        optionChain,
        vix: vrdData.vix ?? 14,
        pcr: indicators.pcrValue,
        indicators,
        vrdData,
        signal: finalSignal,
      }

      this.latestSnapshots.set(symbol, snapshot)
    }

    // Emit tick event to all listeners (TenantManager & WebSockets)
    this.emit('marketTick', {
      timestamp,
      snapshots: this.getAllSnapshots(),
    })
  }

  private generateSeedCandles(symbol: UnderlyingSymbol): Candle[] {
    const basePrice = symbol === 'NIFTY 50' ? 24500 : symbol === 'BANKNIFTY' ? 51500 : 23000
    const candles: Candle[] = []
    let current = basePrice
    const now = Date.now()

    for (let i = 50; i >= 0; i--) {
      const time = new Date(now - i * 60000).toISOString()
      const delta = (Math.random() - 0.48) * 15
      const open = current
      const close = Math.round((current + delta) * 100) / 100
      const high = Math.max(open, close) + Math.random() * 5
      const low = Math.min(open, close) - Math.random() * 5
      const volume = Math.floor(Math.random() * 8000) + 2000
      candles.push([time, open, high, low, close, volume])
      current = close
    }
    return candles
  }

  private generateMockOptionChain(spot: number): OptionData[] {
    const roundedSpot = Math.round(spot / 50) * 50
    const strikes = [-200, -150, -100, -50, 0, 50, 100, 150, 200].map((offset) => roundedSpot + offset)
    const expiry = new Date(Date.now() + 5 * 86400000).toISOString().split('T')[0]

    return strikes.map((strike) => {
      const cePrice = Math.max(5, Math.round((spot - strike + 80) * 100) / 100)
      const pePrice = Math.max(5, Math.round((strike - spot + 80) * 100) / 100)
      return {
        expiry,
        strike_price: strike,
        underlying_spot_price: spot,
        call_options: {
          instrument_key: `NSE_FO|OPT_NIFTY_${strike}_CE`,
          trading_symbol: `NIFTY ${expiry} ${strike} CE`,
          market_data: { ltp: cePrice, volume: 50000, oi: 120000 },
        },
        put_options: {
          instrument_key: `NSE_FO|OPT_NIFTY_${strike}_PE`,
          trading_symbol: `NIFTY ${expiry} ${strike} PE`,
          market_data: { ltp: pePrice, volume: 45000, oi: 135000 },
        },
      }
    })
  }
}
