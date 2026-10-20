import { describe, it, expect } from 'vitest'
import {
  calcEMACrossover,
  calcRSI,
  calcBollingerBands,
  calcSupertrend,
  calcVWAP,
  calcPCR,
  computeAllIndicators,
} from '../services/indicators'
import {
  applyMultiTimeframeFilter,
  scoreBullish,
  scoreBearish,
  getFinalSignal,
  runHardStopChecks,
  shouldExit,
} from '../services/strategyEngine'
import type {
  Candle,
  OptionData,
  AllSignalData,
  ActivePosition,
  FinalSignal,
  VrdData,
} from '../types'
import { DEFAULT_STRATEGY_CONFIG } from '../constants'

function makeCandles(count: number, basePrice = 24000, trend = 10): Candle[] {
  const candles: Candle[] = []
  let price = basePrice
  for (let i = 0; i < count; i++) {
    const open = price
    const close = price + trend
    const high = Math.max(open, close) + 5
    const low = Math.min(open, close) - 5
    candles.push([
      new Date(Date.now() - (count - i) * 60000).toISOString(),
      open,
      high,
      low,
      close,
      1000,
    ])
    price = close
  }
  return candles
}

describe('Technical Indicators Suite', () => {
  it('calculates EMA Crossover correctly for uptrend and downtrend', () => {
    const upCandles = makeCandles(50, 24000, 15)
    expect(calcEMACrossover(upCandles)).toBe('Buy')

    const downCandles = makeCandles(50, 24000, -15)
    expect(calcEMACrossover(downCandles)).toBe('Sell')
  })

  it('calculates RSI(14) properly', () => {
    const upCandles = makeCandles(30, 24000, 20)
    const rsiUp = calcRSI(upCandles)
    expect(rsiUp.value).toBeGreaterThan(60)

    const downCandles = makeCandles(30, 24000, -20)
    const rsiDown = calcRSI(downCandles)
    expect(rsiDown.value).toBeLessThan(40)
  })

  it('calculates Bollinger Bands and trend', () => {
    const candles = makeCandles(30, 24000, 5)
    const bb = calcBollingerBands(candles)
    expect(bb.upper).toBeGreaterThan(bb.middle)
    expect(bb.middle).toBeGreaterThan(bb.lower)
    expect(bb.trend).toBe('Up')
  })

  it('calculates Supertrend and VWAP', () => {
    const candles = makeCandles(30, 24000, 10)
    const st = calcSupertrend(candles)
    expect(st.trend).toBe('Up')
    expect(st.value).toBeGreaterThan(0)

    const vwap = calcVWAP(candles)
    expect(vwap).toBeGreaterThan(24000)
  })

  it('calculates Put-Call Ratio (PCR)', () => {
    const optionChain: OptionData[] = [
      {
        expiry: '2026-08-20',
        strike_price: 24000,
        underlying_spot_price: 24000,
        call_options: {
          instrument_key: 'C1',
          market_data: { ltp: 100, volume: 1000, oi: 10000 },
        },
        put_options: {
          instrument_key: 'P1',
          market_data: { ltp: 100, volume: 1000, oi: 15000 },
        },
      },
    ]
    const res = calcPCR(optionChain)
    expect(res.pcr).toBe(1.5)
    expect(res.signal).toBe('Buy')
  })
})

describe('V5 Strategy Scoring & Risk Engine Suite', () => {
  it('generates a strong bullish score when technical and institutional factors align', () => {
    const candles = makeCandles(50, 24000, 20)
    const indicators = computeAllIndicators(candles)
    const signalData: AllSignalData = {
      v3: 'buy',
      indicators: {
        ...indicators,
        ema: 'Buy',
        adx: 'Buy',
        pcrValue: 1.4,
        pcr: 'Buy',
      },
      vrd: {
        mmi: { score: 25, label: 'Extreme Fear' },
        advancesDeclines: {
          advances: 40,
          declines: 10,
          ratio: 4.0,
          label: 'Breadth Thrust',
        },
        fiiLongShort: { longPct: 65, shortPct: 35, shortPctTrend: 'Rising' },
        fiiPositioning: { netPosition: 1500, consecutiveShortDays: 0 },
        pcr: { value: 1.4, zone: 'buy' },
        straddleIv: { elevated: false, percentAboveAvg: 0 },
        niftyPe: { pe: 20, label: 'Fair Value' },
        vix: 14.5,
        giftNifty: {
          price: 24050,
          changePts: 50,
          changePct: 0.2,
          openingSignal: 'Gap Up',
        },
        supportWall: 23800,
        resistanceWall: 24200,
        maxPain: 24000,
        fetchedAt: new Date().toISOString(),
      },
    }

    const bull = scoreBullish(signalData)
    const bear = scoreBearish(signalData)
    expect(bull.score).toBeGreaterThan(bear.score)

    const finalSignal = getFinalSignal(signalData, DEFAULT_STRATEGY_CONFIG)
    expect(finalSignal.signal).toBe('BUY_CE')
    expect(finalSignal.confidence).toBe('strong')
  })

  it('applies the HTF veto without altering confidence and can be disabled', () => {
    const signal: FinalSignal = {
      signal: 'BUY_CE',
      confidence: 'strong',
      positionSize: 'full',
      v3: 'buy',
      v4: 'Buy',
      bullScore: 20,
      bearScore: 2,
      scoreMax: 20,
    }

    const vetoed = applyMultiTimeframeFilter(signal, 'Sell', true)
    expect(vetoed.signal).toBe('NO_TRADE')
    expect(vetoed.confidence).toBe('strong')
    expect(vetoed.positionSize).toBe('none')
    expect(applyMultiTimeframeFilter(signal, 'Sell', false).signal).toBe(
      'BUY_CE',
    )
    expect(applyMultiTimeframeFilter(signal, 'Buy', true).signal).toBe('BUY_CE')
    expect(
      applyMultiTimeframeFilter(
        { ...signal, signal: 'BUY_PE' },
        'Buy',
        true,
      ).signal,
    ).toBe('NO_TRADE')
  })

  it('triggers trailing stop via the reference shouldExit when price pulls back from peak', () => {
    const position: ActivePosition = {
      instrumentKey: 'NSE_FO|OPT_24000_CE',
      direction: 'CE',
      entryPrice: 100,
      quantity: 50,
      entryTime: new Date().toISOString(),
      tradeId: 1,
      currentPrice: 112,
      peakFavorablePrice: 120, // Hit +20%, then pulled back to 112 (-6.6% from peak)
      unrealizedPnl: 600,
      tradeType: 'buying',
    }

    const dummyData: AllSignalData = {
      v3: 'buy',
      indicators: computeAllIndicators(makeCandles(50)),
      vrd: null,
    }

    const result = shouldExit(position, dummyData, 112, DEFAULT_STRATEGY_CONFIG)
    expect(result.exit).toBe(true)
    expect(result.reason).toContain('Trailing stop')
  })

  it('triggers max loss via the reference shouldExit when position exceeds maxLossPct', () => {
    const position: ActivePosition = {
      instrumentKey: 'NSE_FO|OPT_24000_CE',
      direction: 'CE',
      entryPrice: 100,
      quantity: 50,
      entryTime: new Date().toISOString(),
      tradeId: 1,
      currentPrice: 80,
      unrealizedPnl: -1000, // -20% loss vs maxLossPct of 15%
      tradeType: 'buying',
    }

    const dummyData: AllSignalData = {
      v3: 'buy',
      indicators: computeAllIndicators(makeCandles(50)),
      vrd: null,
    }

    const result = shouldExit(position, dummyData, 80, DEFAULT_STRATEGY_CONFIG)
    expect(result.exit).toBe(true)
    expect(result.reason).toContain('Stop loss')
  })

  it('blocks entries when VIX is outside the reference tradeability band', () => {
    const result = runHardStopChecks(makeVrd({ vix: 30 }))
    expect(result.blocked).toBe(true)
    expect(result.blockedDirection).toBe('BOTH')
    expect(result.reasons.join(' ')).toContain('VIX')
  })

  it('blocks entries on high-severity macro news', () => {
    const result = runHardStopChecks(
      makeVrd({
        vix: 14,
        newsAlerts: [
          {
            id: 'n1',
            headline: 'Geopolitical escalation',
            summary: 'Risk-off across Asia',
            type: 'MACRO',
            severity: 'HIGH',
            timestamp: Date.now(),
            matchedKeywords: ['war'],
          },
        ],
      }),
    )
    expect(result.blocked).toBe(true)
    expect(result.reasons.join(' ')).toContain('Macro Guard')
  })

  it('leaves null VRD unblocked (the caller enforces fail-closed freshness)', () => {
    const result = runHardStopChecks(null)
    expect(result.blocked).toBe(false)
  })
})

function makeVrd(overrides: Partial<VrdData> = {}): VrdData {
  return {
    mmi: null,
    advancesDeclines: null,
    fiiLongShort: null,
    fiiPositioning: null,
    pcr: null,
    straddleIv: null,
    niftyPe: null,
    vix: 14,
    giftNifty: null,
    supportWall: null,
    resistanceWall: null,
    maxPain: null,
    fetchedAt: new Date().toISOString(),
    ...overrides,
  }
}
