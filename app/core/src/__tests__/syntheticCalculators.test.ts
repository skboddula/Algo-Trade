import { describe, expect, it } from 'vitest'
import type { OptionData, UnderlyingSymbol } from '../types'
import {
  getLotSizeForSymbol,
  pickBestOptionContract,
} from '../services/syntheticCalculators'

function chainRow(spot = 25_000, strike = 25_000): OptionData {
  return {
    expiry: '2099-01-07',
    strike_price: strike,
    underlying_spot_price: spot,
    call_options: {
      instrument_key: 'NSE_FO|CE_ATM',
      trading_symbol: 'CE_ATM',
      market_data: { ltp: 100, volume: 1, oi: 1 },
    },
    put_options: {
      instrument_key: 'NSE_FO|PE_ATM',
      trading_symbol: 'PE_ATM',
      market_data: { ltp: 200, volume: 1, oi: 1 },
    },
  }
}

describe('index option contract sizing', () => {
  it('uses the current NSE index lots', () => {
    expect(getLotSizeForSymbol('NIFTY 50')).toBe(75)
    expect(getLotSizeForSymbol('BANKNIFTY')).toBe(30)
    expect(getLotSizeForSymbol('FINNIFTY')).toBe(65)
  })

  it.each<[UnderlyingSymbol, number]>([
    ['NIFTY 50', 75],
    ['BANKNIFTY', 30],
    ['FINNIFTY', 65],
  ])('sizes %s orders from that symbol lot, not NIFTY', (symbol, lotSize) => {
    const selected = pickBestOptionContract([chainRow()], 'PE', symbol, 0)

    expect(selected).not.toBeNull()
    expect(selected?.strike).toBe(25_000)
    expect(selected?.instrumentKey).toBe('NSE_FO|PE_ATM')
    expect(selected?.lotSize).toBe(lotSize)
  })

  it('keeps ATM selection and the CE/PE strike offsets intact', () => {
    const chain = [
      chainRow(25_000, 24_900),
      chainRow(25_000, 25_000),
      chainRow(25_000, 25_100),
    ]

    expect(pickBestOptionContract(chain, 'PE', 'BANKNIFTY')?.strike).toBe(
      25_000,
    )
    expect(pickBestOptionContract(chain, 'CE', 'BANKNIFTY')?.strike).toBe(
      25_000,
    )
    expect(pickBestOptionContract(chain, 'PE', 'BANKNIFTY', 1)?.strike).toBe(
      24_900,
    )
    expect(pickBestOptionContract(chain, 'CE', 'BANKNIFTY', 1)?.strike).toBe(
      25_100,
    )
  })
})
