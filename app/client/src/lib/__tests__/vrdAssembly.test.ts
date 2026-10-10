import { describe, it, expect } from 'vitest'

import { assembleVrdData, type VrdAssemblyInput } from '../vrdAssembly'
import type { IndicatorsResult, OptionData } from '@/lib/types'

const INDICATORS: IndicatorsResult = {
  ema: 'Buy',
  adx: 'Hold',
  rsi: { value: 52.4, signal: 'Hold' },
  stochastic: { k: 60, d: 55, signal: 'Hold' },
  bollinger: {
    upper: 22600,
    middle: 22500,
    lower: 22400,
    signal: 'Hold',
    trend: 'Up',
  },
  atr: { value: 12.5, level: 'Neutral' },
  pcr: 'Buy',
  pcrValue: 1.15,
  higherTimeframeTrend: 'Hold',
}

function makeChain(spot: number): OptionData[] {
  const rows: OptionData[] = []
  for (let k = -3; k <= 3; k++) {
    const strike = spot + k * 50
    rows.push({
      expiry: '2026-10-13',
      strike_price: strike,
      underlying_spot_price: spot,
      call_options: {
        instrument_key: `CE_${strike}`,
        trading_symbol: `CE ${strike}`,
        market_data: { ltp: 50, volume: 1000, oi: 5000 + k * 100 },
      },
      put_options: {
        instrument_key: `PE_${strike}`,
        trading_symbol: `PE ${strike}`,
        market_data: { ltp: 50, volume: 1000, oi: 9000 - k * 100 },
      },
    })
  }
  return rows
}

const BASE: VrdAssemblyInput = {
  optionChain: makeChain(22500),
  indicators: INDICATORS,
  vix: 14.5,
  breadth: { advances: 31, declines: 19, ratio: 1.632 },
  fiiLongShort: { longPct: 40, shortPct: 60, shortPctTrend: 'Rising' },
  fiiPositioning: { netPosition: -20000, consecutiveShortDays: 3 },
  giftNifty: {
    price: 22510,
    changePts: 10,
    changePct: 0.05,
    openingSignal: 'Flat',
  },
  officialPcr: null,
  maxPain: 22500,
  newsAlerts: [],
}

describe('assembleVrdData (canonical sentiment composition)', () => {
  it('derives support/resistance walls from max put/call OI', () => {
    const { vrd } = assembleVrdData(BASE)
    // put OI peaks at the lowest strike (9000+300), call OI at the highest (5000+300)
    expect(vrd.supportWall).toBe(22350)
    expect(vrd.resistanceWall).toBe(22650)
  })

  it('falls back to the chain-derived PCR when the official fetch failed', () => {
    const { vrd, effectivePcr } = assembleVrdData(BASE)
    expect(effectivePcr).toBe(1.15)
    expect(vrd.pcr?.value).toBe(1.15)
    expect(vrd.pcr?.zone).toBe('Bullish')
  })

  it('classifies all PCR zones exactly as the validated thresholds', () => {
    const zone = (pcr: number) =>
      assembleVrdData({ ...BASE, officialPcr: pcr }).vrd.pcr?.zone
    expect(zone(1.7)).toBe('Overbought')
    expect(zone(1.6)).toBe('Overbought')
    expect(zone(1.0)).toBe('Bullish')
    expect(zone(0.71)).toBe('Neutral')
    expect(zone(0.7)).toBe('Bearish')
    expect(assembleVrdData({ ...BASE, officialPcr: 0 }).vrd.pcr).toBeNull()
  })

  it('drops breadth when advances is null (client canonical semantics)', () => {
    const withNullAdvances = assembleVrdData({
      ...BASE,
      breadth: { advances: null, declines: 19, ratio: 1.6 },
    })
    expect(withNullAdvances.vrd.advancesDeclines).toBeNull()

    const withBreadth = assembleVrdData(BASE)
    expect(withBreadth.vrd.advancesDeclines).toEqual({
      advances: 31,
      declines: 19,
      ratio: 1.632,
      label: null,
    })
  })

  it('marks straddle IV elevated only above +30% vs VIX', () => {
    // No option_greeks in the synthetic chain → currentIv null → not elevated
    const { vrd } = assembleVrdData(BASE)
    expect(vrd.straddleIv?.elevated).toBe(false)
    expect(vrd.straddleIv?.percentAboveAvg).toBeNull()
  })

  it('composes MMI, proxy PE, and passes through VIX/GIFT/max-pain/news', () => {
    const { vrd, mmi } = assembleVrdData(BASE)
    expect(typeof vrd.mmi?.score).toBe('number')
    expect(vrd.mmi?.score).toBe(mmi.score)
    expect(typeof vrd.niftyPe?.pe).toBe('number')
    expect(vrd.vix).toBe(14.5)
    expect(vrd.giftNifty?.openingSignal).toBe('Flat')
    expect(vrd.maxPain).toBe(22500)
    expect(vrd.newsAlerts).toEqual([])
    expect(vrd.fiiLongShort?.shortPct).toBe(60)
    expect(vrd.fiiPositioning?.consecutiveShortDays).toBe(3)
  })

  it('stamps fetchedAt as a fresh ISO timestamp', () => {
    const { vrd } = assembleVrdData(BASE)
    expect(Number.isNaN(new Date(vrd.fetchedAt).getTime())).toBe(false)
  })
})
