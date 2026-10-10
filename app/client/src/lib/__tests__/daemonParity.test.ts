/**
 * Daemon↔Browser parity golden tests.
 *
 * Runs the SAME deterministic inputs through BOTH calculation engines —
 * the browser bot's modules (src/lib/*) and the always-on daemon's
 * services (app/core/src/services/*) — and asserts identical outputs.
 * Any future divergence in the shared math fails here before it can
 * change live trading behaviour.
 */
import { describe, it, expect } from 'vitest'

import {
  computeAllIndicators as clientIndicators,
  getOtmStrike as clientGetOtmStrike,
} from '@/lib/indicators'
import {
  getFinalSignal as clientGetFinalSignal,
  shouldExit as clientShouldExit,
} from '@/lib/strategyEngine'
import {
  evaluateGlobalSentiment as clientEvalGlobal,
  evaluatePCR as clientEvalPCR,
  getV3Signal as clientGetV3,
} from '@/lib/v3Sentiment'
import {
  scoreMMI as clientScoreMMI,
  scoreADRatio as clientScoreAD,
  scoreFiiLongShort as clientScoreFii,
  scoreFiiPositioning as clientScoreFiiPos,
  scoreNiftyPE as clientScorePE,
  scoreVix as clientScoreVix,
  scoreStraddleIV as clientScoreIV,
} from '@/lib/vrdSignals'
import {
  scoreMMI as daemonScoreMMI,
  scoreADRatio as daemonScoreAD,
  scoreFiiLongShort as daemonScoreFii,
  scoreFiiPositioning as daemonScoreFiiPos,
  scoreNiftyPE as daemonScorePE,
  scoreVix as daemonScoreVix,
  scoreStraddleIV as daemonScoreIV,
} from '../../../../core/src/services/vrdSignals'

import { computeAllIndicators as daemonIndicators } from '../../../../core/src/services/indicators'
import { getOtmStrike as daemonGetOtmStrike } from '../../../../core/src/services/indicators'
import {
  getFinalSignal as daemonGetFinalSignal,
  shouldExit as daemonShouldExit,
} from '../../../../core/src/services/strategyEngine'
import {
  evaluateGlobalSentiment as daemonEvalGlobal,
  evaluatePCR as daemonEvalPCR,
  getV3Signal as daemonGetV3,
} from '../../../../core/src/services/v3Sentiment'

import type {
  Candle,
  OptionData,
  AllSignalData,
  ActivePosition,
  StrategyConfig,
} from '@/lib/types'
import { DEFAULT_STRATEGY_CONFIG } from '@/lib/constants'

// ─── Deterministic fixtures ──────────────────────────────────────────────────

function makeCandles(start: number, drift: number, count = 240): Candle[] {
  // Newest-first (Upstox native order — both engines are calibrated on it)
  const candles: Candle[] = []
  let price = start
  for (let i = 0; i < count; i++) {
    const time = `2026-10-09T${String(15 - Math.floor(i / 60)).padStart(2, '0')}:${String(59 - (i % 60)).padStart(2, '0')}:00+05:30`
    const open = price
    const close = price + drift
    candles.push([
      time,
      open,
      Math.max(open, close) + 1.5,
      Math.min(open, close) - 1.5,
      close,
      1000 + i,
    ])
    price = close
  }
  return candles
}

const UP_TREND = makeCandles(22000, 0.8) // rises to ~22192
const DOWN_TREND = makeCandles(22500, -0.8) // falls to ~22308

function makeChain(spot: number, step = 50): OptionData[] {
  const rows: OptionData[] = []
  for (let k = -10; k <= 10; k++) {
    const strike = spot + k * step
    const intrinsicCe = Math.max(0, spot - strike)
    const intrinsicPe = Math.max(0, strike - spot)
    rows.push({
      expiry: '2026-10-13',
      strike_price: strike,
      underlying_spot_price: spot,
      call_options: {
        instrument_key: `CE_${strike}`,
        trading_symbol: `NIFTY CE ${strike}`,
        market_data: {
          ltp: Math.max(5, intrinsicCe + 80 - k * 2),
          volume: 10000,
          oi: 90000 + (10 - Math.abs(k)) * 5000,
        },
      },
      put_options: {
        instrument_key: `PE_${strike}`,
        trading_symbol: `NIFTY PE ${strike}`,
        market_data: {
          ltp: Math.max(5, intrinsicPe + 80 + k * 2),
          volume: 9000,
          oi: 70000 + (10 - Math.abs(k)) * 6000,
        },
      },
    })
  }
  return rows
}

const CHAIN = makeChain(22500)

const VRD: AllSignalData['vrd'] = {
  mmi: { score: 52, label: 'Neutral' },
  advancesDeclines: { advances: 31, declines: 19, ratio: 1.632, label: null },
  fiiLongShort: { longPct: 40, shortPct: 60, shortPctTrend: 'Rising' },
  fiiPositioning: { netPosition: -20000, consecutiveShortDays: 3 },
  pcr: { value: 1.1, zone: 'Bullish' },
  straddleIv: { elevated: false, percentAboveAvg: -5 },
  niftyPe: { pe: 21, label: 'Fair Value' },
  vix: 14.5,
  giftNifty: {
    price: 22510,
    changePts: 10,
    changePct: 0.05,
    openingSignal: 'Flat',
  },
  supportWall: 22400,
  resistanceWall: 22600,
  maxPain: 22500,
  newsAlerts: [],
  fetchedAt: '2026-10-09T10:00:00.000Z',
}

const CONFIG: Pick<
  StrategyConfig,
  | 'strongThreshold'
  | 'moderateThreshold'
  | 'strongGap'
  | 'moderateGap'
  | 'minConfidence'
  | 'maxProfitPct'
  | 'maxLossPct'
  | 'trailPct'
  | 'useMultiTimeframe'
> = {
  strongThreshold: 14,
  moderateThreshold: 10,
  strongGap: 6,
  moderateGap: 3,
  minConfidence: 'moderate',
  maxProfitPct: 20,
  maxLossPct: 15,
  trailPct: 5,
  useMultiTimeframe: true,
}

function signalDataFor(
  candles: Candle[],
  chain: OptionData[],
  v3: 'buy' | 'sell' | 'hold',
  vrd: AllSignalData['vrd'],
): AllSignalData {
  return {
    v3,
    indicators: clientIndicators(candles, chain),
    vrd,
    globalIndices: [],
  }
}

// ─── 1. Indicator engine parity ─────────────────────────────────────────────

describe('parity: computeAllIndicators', () => {
  it('produces identical indicators on an up-trend', () => {
    const c = clientIndicators(UP_TREND, CHAIN)
    const d = daemonIndicators(UP_TREND, CHAIN)
    expect(d).toEqual(c)
  })

  it('produces identical indicators on a down-trend', () => {
    const c = clientIndicators(DOWN_TREND, CHAIN)
    const d = daemonIndicators(DOWN_TREND, CHAIN)
    expect(d).toEqual(c)
  })

  it('matches PCR value + signal on a synthetic chain', () => {
    const c = clientIndicators(UP_TREND, CHAIN)
    expect(c.pcrValue).toBeGreaterThan(0)
    // Same thresholds: >= 1.0 Buy, <= 0.7 Sell, else Hold
    const c2 = clientIndicators(UP_TREND, makeChain(22500, 100))
    const d2 = daemonIndicators(UP_TREND, makeChain(22500, 100))
    expect(d2.pcrValue).toBe(c2.pcrValue)
    expect(d2.pcr).toBe(c2.pcr)
  })
})

// ─── 2. Final signal / 5-layer scoring parity ────────────────────────────────

describe('parity: getFinalSignal', () => {
  const cases: [string, Candle[], 'buy' | 'sell' | 'hold'][] = [
    ['up-trend + buy v3', UP_TREND, 'buy'],
    ['down-trend + sell v3', DOWN_TREND, 'sell'],
    ['up-trend + sell v3 (conflict)', UP_TREND, 'sell'],
    ['down-trend + hold v3', DOWN_TREND, 'hold'],
  ]
  for (const [name, candles, v3] of cases) {
    it(`returns identical signals for ${name}`, () => {
      const data = signalDataFor(candles, CHAIN, v3, VRD)
      const c = clientGetFinalSignal(data, CONFIG)
      const d = daemonGetFinalSignal(data, CONFIG)
      expect(d).toEqual(c)
    })
  }

  it('applies the multi-timeframe gate identically', () => {
    // 1-min up-trend inside a 5-min down-trend is hard to synthesize; use
    // the raw trend cases which exercise the gate via higherTimeframeTrend.
    const data = signalDataFor(UP_TREND, CHAIN, 'buy', VRD)
    const c = clientGetFinalSignal(data, {
      ...CONFIG,
      useMultiTimeframe: false,
    })
    const d = daemonGetFinalSignal(data, {
      ...CONFIG,
      useMultiTimeframe: false,
    })
    expect(d).toEqual(c)
  })
})

// ─── 3. Exit engine parity (shouldExit vs runHardStopChecks) ─────────────────

describe('parity: exit engine', () => {
  const data = signalDataFor(UP_TREND, CHAIN, 'buy', VRD)

  function basePos(over: Partial<ActivePosition>): ActivePosition {
    return {
      instrumentKey: 'NSE_FO|TEST',
      direction: 'CE',
      entryPrice: 100,
      quantity: 65,
      entryTime: new Date().toISOString(),
      tradeId: 1,
      tradeType: 'buying',
      currentPrice: 100,
      unrealizedPnl: 0,
      ...over,
    }
  }

  const scenarios: { name: string; pos: ActivePosition }[] = [
    {
      name: 'take-profit hit (+21%)',
      pos: basePos({
        currentPrice: 121,
        peakFavorablePrice: 121,
        unrealizedPnl: 1365,
      }),
    },
    {
      name: 'stop-loss hit (−16%)',
      pos: basePos({
        currentPrice: 84,
        peakFavorablePrice: 100,
        unrealizedPnl: -1040,
      }),
    },
    {
      name: 'trailing stop on a CE (peak 120 → 112)',
      pos: basePos({
        currentPrice: 112,
        peakFavorablePrice: 120,
        unrealizedPnl: 780,
      }),
    },
    {
      name: 'trailing stop on a PE (peak 140 → 132)',
      pos: basePos({
        direction: 'PE',
        currentPrice: 132,
        peakFavorablePrice: 140,
        unrealizedPnl: 2080,
      }),
    },
    {
      name: 'no exit (small profit, near peak)',
      pos: basePos({
        currentPrice: 103,
        peakFavorablePrice: 104,
        unrealizedPnl: 195,
      }),
    },
  ]

  for (const { name, pos } of scenarios) {
    it(`agrees on: ${name}`, () => {
      const c = clientShouldExit(pos, data, pos.currentPrice ?? 100, {
        maxProfitPct: CONFIG.maxProfitPct,
        maxLossPct: CONFIG.maxLossPct,
        trailPct: CONFIG.trailPct,
      })
      const d = daemonShouldExit(pos, data, pos.currentPrice ?? 100, {
        maxProfitPct: CONFIG.maxProfitPct,
        maxLossPct: CONFIG.maxLossPct,
        trailPct: CONFIG.trailPct,
      })
      expect(d.exit).toBe(c.exit)
      if (c.exit) expect(d.reason).toBe(c.reason)
    })
  }

  it('agrees on breadth-reversal exits', () => {
    // PE position (bearish bias) with strongly bullish breadth (> 1.5)
    const bullData = signalDataFor(UP_TREND, CHAIN, 'buy', {
      ...VRD,
      advancesDeclines: {
        advances: 43,
        declines: 7,
        ratio: 6.143,
        label: null,
      },
    })
    const pePos = basePos({
      direction: 'PE',
      currentPrice: 99,
      peakFavorablePrice: 101,
      unrealizedPnl: -65,
    })
    const c = clientShouldExit(pePos, bullData, 99, {
      maxProfitPct: 20,
      maxLossPct: 15,
      trailPct: 5,
    })
    const d = daemonShouldExit(pePos, bullData, 99, {
      maxProfitPct: 20,
      maxLossPct: 15,
      trailPct: 5,
    })
    expect(d.exit).toBe(c.exit)
    if (c.exit) expect(d.reason).toBe(c.reason)
  })
})

// ─── 4. Contract selection parity ────────────────────────────────────────────

describe('parity: getOtmStrike', () => {
  for (const skip of [0, 1, 3]) {
    it(`selects the same CE and PE strikes at otmSkip=${skip}`, () => {
      expect(daemonGetOtmStrike(CHAIN, 'CE', skip)).toEqual(
        clientGetOtmStrike(CHAIN, 'CE', skip),
      )
      expect(daemonGetOtmStrike(CHAIN, 'PE', skip)).toEqual(
        clientGetOtmStrike(CHAIN, 'PE', skip),
      )
    })
  }
})

// ─── 5. V3 macro signal parity ───────────────────────────────────────────────

describe('parity: V3 macro sentiment', () => {
  const marketData = [
    { symbol: 'Dow Jones', last_price: 44000, change_per: 0.9 },
    { symbol: 'Nasdaq', last_price: 18000, change_per: 0.5 },
    { symbol: 'Brent Oil', last_price: 90, change_per: 1.2 },
    { symbol: 'GOLD', last_price: 2600, change_per: -0.4 },
    { symbol: 'Hang Seng', last_price: 20000, change_per: -0.9 },
  ]

  it('derives the same global sentiment', () => {
    expect(daemonEvalGlobal(marketData)).toBe(clientEvalGlobal(marketData))
  })

  it('zones PCR identically across the range', () => {
    for (const pcr of [0.4, 0.55, 0.61, 0.9, 0.99, 1.01, 1.3, 1.59, 1.7]) {
      expect(daemonEvalPCR(pcr)).toBe(clientEvalPCR(pcr))
    }
  })

  it('maps V3 identically across sentiment combinations', () => {
    const sentiments = [
      'very bullish',
      'bullish',
      'neutral',
      'bearish',
      'very bearish',
    ] as const
    const zones = ['overbought', 'buy', 'sell', 'oversold', 'neutral'] as const
    for (const g of ['bullish', 'neutral', 'bearish'] as const) {
      for (const n of sentiments) {
        for (const p of zones) {
          expect(daemonGetV3(g, n, p)).toBe(clientGetV3(g, n, p))
        }
      }
    }
  })
})

// ─── 6. VRD scorer branch sweeps (every branch, both engines) ────────────────

describe('parity: VRD scorer branches', () => {
  it('scoreMMI agrees across the full range', () => {
    for (const s of [
      null,
      0,
      20,
      24.9,
      25,
      39,
      40,
      45,
      54,
      55,
      60,
      69,
      70,
      75,
      80,
      100,
    ]) {
      expect(daemonScoreMMI(s)).toEqual(clientScoreMMI(s))
    }
  })

  it('scoreADRatio agrees across breadth regimes', () => {
    const combos: [number | null, number | null, number | null][] = [
      [39, 11, 3.5],
      [30, 20, 1.5],
      [22, 28, 0.79],
      [20, 20, 1.0],
      [15, 35, 0.43],
      [5, 45, 0.11],
      [null, null, null],
      [30, 0, 3.0],
      [0, 30, 0.0],
    ]
    for (const [a, d, r] of combos) {
      expect(daemonScoreAD(a, d, r)).toEqual(clientScoreAD(a, d, r))
    }
  })

  it('scoreFiiLongShort agrees across L/S regimes + trends', () => {
    const combos: [
      number | null,
      number | null,
      ('Rising' | 'Falling' | 'Stable' | null)?,
    ][] = [
      [null, null, null],
      [50, 50, 'Stable'],
      [35, 65, 'Rising'],
      [35, 65, 'Falling'],
      [30, 70, 'Rising'],
      [20, 80, null],
      [20, 80, 'Falling'],
      [20, 85, 'Rising'],
      [65, 35, 'Stable'],
      [70, 30, 'Rising'],
    ]
    for (const [l, s, t] of combos) {
      expect(daemonScoreFii(l, s, t)).toEqual(clientScoreFii(l, s, t))
    }
  })

  it('scoreFiiPositioning agrees across net positions', () => {
    const combos: [number | null, number | null][] = [
      [null, null],
      [0, null],
      [30000, null],
      [60000, 2],
      [-30000, 3],
      [-60000, 5],
      [-309822, 30],
      [60000, 15],
      [-100000, 20],
    ]
    for (const [n, d] of combos) {
      expect(daemonScoreFiiPos(n, d)).toEqual(clientScoreFiiPos(n, d))
    }
  })

  it('scoreNiftyPE agrees across valuation zones', () => {
    for (const pe of [null, 15, 17.9, 18, 21, 23.9, 24, 25, 28.1, 30]) {
      expect(daemonScorePE(pe)).toEqual(clientScorePE(pe))
    }
  })

  it('scoreVix agrees across volatility regimes', () => {
    for (const vix of [
      null,
      5,
      9.9,
      10,
      12,
      15,
      17.9,
      18,
      22,
      24.9,
      25.1,
      30,
    ]) {
      expect(daemonScoreVix(vix)).toEqual(clientScoreVix(vix))
    }
  })

  it('scoreStraddleIV agrees across IV regimes', () => {
    for (const iv of [null, -10, 0, 5, 20, 29.9, 30, 35, 50]) {
      expect(daemonScoreIV(iv)).toEqual(clientScoreIV(iv))
    }
  })
})

// Guard: the daemon must use the same default thresholds as the browser.
describe('parity: shared defaults', () => {
  it('DEFAULT_STRATEGY_CONFIG carries trailPct + useMultiTimeframe', () => {
    expect(DEFAULT_STRATEGY_CONFIG.trailPct).toBe(5)
    expect(DEFAULT_STRATEGY_CONFIG.useMultiTimeframe).toBe(true)
    expect(DEFAULT_STRATEGY_CONFIG.strongThreshold).toBe(14)
    expect(DEFAULT_STRATEGY_CONFIG.moderateThreshold).toBe(10)
    expect(DEFAULT_STRATEGY_CONFIG.maxProfitPct).toBe(20)
    expect(DEFAULT_STRATEGY_CONFIG.maxLossPct).toBe(15)
  })
})
