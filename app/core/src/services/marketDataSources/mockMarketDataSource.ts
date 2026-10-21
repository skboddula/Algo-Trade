import type { Candle, OptionData } from '../../types'
import type { MarketDataSource, SymbolDataRequest, SymbolMarketData } from '../marketDataSource'

/**
 * Synthetic data source used for development, tests and MOCK_MODE.
 *
 * Generates random-walk candles around the last close and a synthetic option
 * chain when none exists. Never reports fetch failures.
 */
export class MockMarketDataSource implements MarketDataSource {
  public readonly name = 'mock'

  public async acquire(req: SymbolDataRequest): Promise<SymbolMarketData> {
    const { symbol, timestamp, candles, optionChain } = req

    const lastClose = candles.length
      ? candles[candles.length - 1][4]
      : symbol === 'NIFTY 50'
        ? 24500
        : 51500
    const delta = (Math.random() - 0.49) * (symbol === 'NIFTY 50' ? 10 : 25)
    const newClose = Math.round((lastClose + delta) * 100) / 100
    const spotPrice = newClose

    const newCandle: Candle = [
      timestamp,
      lastClose,
      Math.max(lastClose, newClose) + 2,
      Math.min(lastClose, newClose) - 2,
      newClose,
      Math.floor(Math.random() * 5000) + 1000,
    ]

    return {
      spotPrice,
      candles: [...candles.slice(-99), newCandle],
      optionChain: optionChain.length ? optionChain : this.generateMockOptionChain(spotPrice),
      quoteAtMs: Date.now(),
    }
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
