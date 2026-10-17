import { UNDERLYING_INSTRUMENT_KEYS } from '../../types'
import type { MarketDataSource, SymbolDataRequest, SymbolMarketData } from '../marketDataSource'

export interface RestMarketDataSourceOptions {
  upstoxApiBaseUrl: string
  /** Read the current master token on every call (supports runtime token swaps). */
  getToken: () => string | undefined
}

/**
 * Upstox REST quote polling — the current production transport.
 *
 * Fetches the index LTP once per symbol per tick; candles and option chain are
 * passed through untouched (live candle/chain coverage arrives with the future
 * WebSocket V3 source).
 */
export class RestMarketDataSource implements MarketDataSource {
  public readonly name = 'rest'

  private readonly apiBaseUrl: string
  private readonly getToken: () => string | undefined

  constructor(opts: RestMarketDataSourceOptions) {
    this.apiBaseUrl = opts.upstoxApiBaseUrl
    this.getToken = opts.getToken
  }

  public async acquire(req: SymbolDataRequest): Promise<SymbolMarketData> {
    const { symbol, candles, optionChain } = req
    const fallbackPrice = candles.length ? candles[candles.length - 1][4] : 24500

    try {
      const instrumentKey = UNDERLYING_INSTRUMENT_KEYS[symbol]
      const quoteRes = await fetch(
        `${this.apiBaseUrl}/market-quote/quotes?instrument_key=${encodeURIComponent(instrumentKey)}`,
        {
          headers: {
            Authorization: `Bearer ${this.getToken()}`,
            Accept: 'application/json',
          },
        },
      )

      if (quoteRes.ok) {
        const data = (await quoteRes.json()) as any
        const quote =
          data?.data?.[instrumentKey.replace('|', ':')] || (Object.values(data?.data || {})[0] as any)
        if (quote?.last_price) {
          return { spotPrice: quote.last_price, candles, optionChain }
        }
      }

      return {
        spotPrice: fallbackPrice,
        candles,
        optionChain,
        fetchFailed: true,
        fetchError: quoteRes.ok ? 'response missing last_price' : `HTTP ${quoteRes.status}`,
      }
    } catch (err) {
      return {
        spotPrice: fallbackPrice,
        candles,
        optionChain,
        fetchFailed: true,
        fetchError: (err as Error).message || 'network error',
      }
    }
  }
}
