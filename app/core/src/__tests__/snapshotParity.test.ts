import { describe, it, expect } from 'vitest'
import { computeAllIndicators } from '../services/indicators'
import { getFinalSignal } from '../services/strategyEngine'
import { DEFAULT_STRATEGY_CONFIG } from '../constants'
import {
  compareSnapshotArms,
  signalFieldDiffs,
  type SnapshotParityRow,
} from '../backtest/snapshotParity'
import type { AllSignalData, Candle, StrategyConfig } from '../types'

function makeCandles(count: number, basePrice = 24000, trend = 20): Candle[] {
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

function bullishData(htf: 'Buy' | 'Sell'): AllSignalData {
  const indicators = computeAllIndicators(makeCandles(50, 24000, 20))
  return {
    v3: 'buy',
    indicators: {
      ...indicators,
      ema: 'Buy',
      adx: 'Buy',
      pcrValue: 1.4,
      pcr: 'Buy',
      higherTimeframeTrend: htf,
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
}

/** Mimic the daemon capture: store the exact inputs and the three arms. */
function captureRow(
  data: AllSignalData,
  config: StrategyConfig,
): SnapshotParityRow {
  return {
    id: 1,
    symbol: 'NIFTY 50',
    capturedAt: '2026-10-21T06:14:35.922Z',
    dataJson: JSON.stringify(data),
    configJson: JSON.stringify(config),
    userSignalJson: JSON.stringify(getFinalSignal(data, config)),
    unfilteredSignalJson: JSON.stringify(
      getFinalSignal(data, { ...config, useMultiTimeframe: false }),
    ),
    defaultSignalJson: JSON.stringify(
      getFinalSignal(data, DEFAULT_STRATEGY_CONFIG),
    ),
  }
}

describe('snapshot replay — arm parity', () => {
  it('replays all three arms bit-for-bit (filter-off user vs default veto)', () => {
    const data = bullishData('Sell')
    const config = { ...DEFAULT_STRATEGY_CONFIG, useMultiTimeframe: false }
    const row = captureRow(data, config)

    const parity = compareSnapshotArms(row)
    expect(parity.parseError).toBeNull()
    expect(parity.arms.map((arm) => [arm.arm, arm.status])).toEqual([
      ['user', 'match'],
      ['unfiltered', 'match'],
      ['default', 'match'],
    ])

    // Discriminator: the arms are genuinely different, so the parity check
    // exercised the right config per arm instead of one shared path.
    expect(getFinalSignal(data, config).signal).toBe('BUY_CE')
    expect(getFinalSignal(data, DEFAULT_STRATEGY_CONFIG).signal).toBe(
      'NO_TRADE',
    )
  })

  it('replays a filter-on user whose HTF veto emptied only the user arm', () => {
    const data = bullishData('Sell')
    const config = { ...DEFAULT_STRATEGY_CONFIG }
    const row = captureRow(data, config)

    const parity = compareSnapshotArms(row)
    expect(parity.arms.every((arm) => arm.status === 'match')).toBe(true)

    const storedUser = JSON.parse(row.userSignalJson) as { signal: string }
    const storedUnfiltered = JSON.parse(row.unfilteredSignalJson) as {
      signal: string
    }
    expect(storedUser.signal).toBe('NO_TRADE')
    expect(storedUnfiltered.signal).toBe('BUY_CE')
  })

  it('flags a corrupted stored arm with the exact field diff', () => {
    const data = bullishData('Buy')
    const config = { ...DEFAULT_STRATEGY_CONFIG }
    const row = captureRow(data, config)
    const expected = getFinalSignal(data, config)

    const corrupted = JSON.parse(row.userSignalJson) as Record<string, unknown>
    corrupted.bullScore = (corrupted.bullScore as number) - 2
    row.userSignalJson = JSON.stringify(corrupted)

    const parity = compareSnapshotArms(row)
    const userArm = parity.arms.find((arm) => arm.arm === 'user')
    expect(userArm?.status).toBe('mismatch')
    expect(userArm?.diffs).toEqual([
      {
        field: 'bullScore',
        stored: (corrupted.bullScore as number),
        recomputed: expected.bullScore,
      },
    ])
    // The other arms are untouched and still pass.
    expect(parity.arms.filter((arm) => arm.status === 'match')).toHaveLength(2)
  })

  it('reports parse errors and stored-missing arms without throwing', () => {
    const data = bullishData('Buy')
    const row = captureRow(data, { ...DEFAULT_STRATEGY_CONFIG })

    const bad = compareSnapshotArms({ ...row, dataJson: '{not-json' })
    expect(bad.parseError).toBeTruthy()
    expect(bad.arms).toEqual([])

    const noDefault = compareSnapshotArms({ ...row, defaultSignalJson: null })
    const defaultArm = noDefault.arms.find((arm) => arm.arm === 'default')
    expect(defaultArm?.status).toBe('stored-missing')
    expect(
      noDefault.arms.filter((arm) => arm.status === 'mismatch'),
    ).toHaveLength(0)
  })

  it('diffs missing and added fields by name', () => {
    const stored = { signal: 'BUY_CE', bullScore: 12 } as never
    const recomputed = { signal: 'BUY_PE', bullScore: 3, scoreMax: 20 } as never
    expect(signalFieldDiffs(stored, recomputed)).toEqual([
      { field: 'signal', stored: 'BUY_CE', recomputed: 'BUY_PE' },
      { field: 'bullScore', stored: 12, recomputed: 3 },
      { field: 'scoreMax', stored: undefined, recomputed: 20 },
    ])
  })
})
