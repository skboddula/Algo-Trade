import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type {
  AllSignalData,
  Candle,
  FinalSignal,
  IndicatorsResult,
  OptionData,
  StrategyConfig,
  VrdData,
} from '../../../../packages/shared/src/types'
import { DEFAULT_CONFIG } from '../../../../packages/shared/src/types'
import {
  applySlippage,
  calculateOptionCharges,
  COST_RATES,
} from '../backtest/costs'
import {
  findNearestExpiry,
  selectOptionContract,
  seriesAtOrBefore,
  seriesFirstAtOrAfter,
} from '../backtest/contracts'
import { runReplay } from '../backtest/engine'
import { MacroSeries, emptyMacroFile } from '../backtest/data/macro'
import { writeReplayReport } from '../backtest/report'
import {
  istDate,
  istMinute,
  isTradingDate,
  sessionCandles,
} from '../backtest/time'
import type {
  OptionBar,
  OptionSeries,
  ReplayDataset,
  ReplayDay,
  ReplayResult,
  ReplaySignalContext,
  ReplaySignalSource,
  YahooMacroFile,
} from '../backtest/types'

const DATE = '2026-03-04'
const EXPIRY = '2026-03-10'

function istIso(date: string, minute: number): string {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day, 0, minute - 330)).toISOString()
}

function makeCandle(
  date: string,
  minute: number,
  close = 100,
  spread = 1,
): Candle {
  return [
    istIso(date, minute),
    close,
    close + spread,
    close - spread,
    close,
    1000,
  ]
}

function makeOptionBar(
  date: string,
  minute: number,
  open: number,
  high: number,
  low: number,
  close: number,
  strike = 100,
  side: 'CE' | 'PE' = 'CE',
): OptionBar {
  return {
    timestamp: istIso(date, minute),
    istDate: date,
    minute,
    strike,
    side,
    open,
    high,
    low,
    close,
    volume: 1000,
    oi: 5000,
  }
}

function makeSeries(bars: OptionBar[]): OptionSeries {
  const byMinute = new Map(bars.map((bar) => [bar.minute, bar]))
  return {
    strike: bars[0].strike,
    side: bars[0].side,
    bars: [...bars].sort((left, right) => left.minute - right.minute),
    byMinute,
  }
}

function optionRow(
  strike: number,
  spot: number,
  callLtp = 5,
  putLtp = 5,
  callOi = 5000,
  putOi = 5000,
): OptionData {
  return {
    expiry: EXPIRY,
    strike_price: strike,
    underlying_spot_price: spot,
    call_options: {
      instrument_key: `C-${strike}`,
      trading_symbol: `NIFTY ${strike} CE`,
      market_data: { ltp: callLtp, volume: 1000, oi: callOi },
    },
    put_options: {
      instrument_key: `P-${strike}`,
      trading_symbol: `NIFTY ${strike} PE`,
      market_data: { ltp: putLtp, volume: 1000, oi: putOi },
    },
  }
}

function neutralIndicators(): IndicatorsResult {
  return {
    ema: 'Hold',
    adx: 'Hold',
    rsi: { value: 50, signal: 'Hold' },
    stochastic: { k: 50, d: 50, signal: 'Hold' },
    bollinger: {
      upper: 110,
      middle: 100,
      lower: 90,
      signal: 'Hold',
      trend: 'Neutral',
    },
    atr: { value: 1, level: 'Neutral' },
    pcr: 'Hold',
    pcrValue: 1,
    higherTimeframeTrend: 'Hold',
  }
}

function neutralVrd(): VrdData {
  return {
    mmi: null,
    advancesDeclines: null,
    fiiLongShort: null,
    fiiPositioning: null,
    pcr: { value: 1, zone: 'neutral' },
    straddleIv: null,
    niftyPe: null,
    vix: null,
    giftNifty: null,
    supportWall: null,
    resistanceWall: null,
    maxPain: null,
    newsAlerts: [],
    fetchedAt: new Date().toISOString(),
  }
}

function neutralData(): AllSignalData {
  return {
    v3: 'hold',
    indicators: neutralIndicators(),
    vrd: neutralVrd(),
    globalIndices: [],
  }
}

const NO_TRADE: FinalSignal = {
  signal: 'NO_TRADE',
  confidence: 'none',
  positionSize: 'none',
  v3: 'hold',
  v4: 'Hold',
  bullScore: 0,
  bearScore: 0,
  scoreMax: 1,
}

class ForcedSignalSource implements ReplaySignalSource {
  readonly contexts: ReplaySignalContext[] = []

  constructor(
    private readonly signalMinutes: Set<number>,
    private readonly direction: 'BUY_CE' | 'BUY_PE' = 'BUY_CE',
  ) {}

  buildData(context: ReplaySignalContext): AllSignalData {
    this.contexts.push(context)
    return neutralData()
  }

  signalFor(
    context: ReplaySignalContext,
    _data: AllSignalData,
    _config: StrategyConfig,
  ): FinalSignal | undefined {
    if (!this.signalMinutes.has(context.minute)) return NO_TRADE
    return {
      signal: this.direction,
      confidence: 'moderate',
      positionSize: 'half',
      v3: 'hold',
      v4: this.direction === 'BUY_CE' ? 'Buy' : 'Sell',
      bullScore: this.direction === 'BUY_CE' ? 10 : 0,
      bearScore: this.direction === 'BUY_PE' ? 10 : 0,
      scoreMax: 20,
    }
  }
}

class FilterVetoSource extends ForcedSignalSource {
  constructor() {
    super(new Set([560]))
  }

  signalFor(
    context: ReplaySignalContext,
    _data: AllSignalData,
    config: StrategyConfig,
  ): FinalSignal | undefined {
    if (context.minute !== 560) return NO_TRADE
    if (config.useMultiTimeframe) return NO_TRADE
    return {
      signal: 'BUY_CE',
      confidence: 'moderate',
      positionSize: 'half',
      v3: 'hold',
      v4: 'Buy',
      bullScore: 10,
      bearScore: 0,
      scoreMax: 20,
    }
  }
}

interface Fixture {
  day: ReplayDay
  dataset: ReplayDataset
  source: ForcedSignalSource
}

function makeFixture(input: {
  signalMinutes: number[]
  optionBars: OptionBar[]
  spotBars?: number
  direction?: 'BUY_CE' | 'BUY_PE'
}): Fixture {
  const spotBars = input.spotBars ?? 12
  const spotCandles = Array.from({ length: spotBars }, (_, index) =>
    makeCandle(DATE, 555 + index, 100),
  )
  const series = new Map<string, OptionSeries>()
  series.set('100:CE', makeSeries(input.optionBars))
  const day: ReplayDay = {
    date: DATE,
    expiry: EXPIRY,
    spotCandles,
    previousCandles: [],
    optionSeries: series,
    strikes: [100],
    chainAt: () => [optionRow(100, 100)],
  }
  const dataset: ReplayDataset = {
    symbol: 'NIFTY 50',
    dates: [DATE],
    getDay: async () => day,
    nearestExpiry: () => EXPIRY,
  }
  const source = new ForcedSignalSource(
    new Set(input.signalMinutes),
    input.direction ?? 'BUY_CE',
  )
  return { day, dataset, source }
}

async function runFixture(
  fixture: Fixture,
  strategyOverrides: Partial<StrategyConfig> = {},
  optionsOverrides: Partial<Parameters<typeof runReplay>[0]['options']> = {},
): Promise<ReplayResult> {
  return runReplay({
    dataset: fixture.dataset,
    macro: new MacroSeries(emptyMacroFile()),
    signalSource: fixture.source,
    options: {
      from: DATE,
      to: DATE,
      symbol: 'NIFTY 50',
      initialCapital: 100_000,
      lots: 1,
      lotSize: 75,
      slippageBps: 0,
      costModel: 'statutory',
      maxEntryDelayBars: 1,
      peakSource: 'close',
      maxStrikeDistancePct: 3,
      minBarsPerSession: 1,
      strategy: {
        ...DEFAULT_CONFIG,
        underlyingMode: 'NIFTY 50',
        maxProfitPct: 20,
        maxLossPct: 15,
        trailPct: 5,
        maxTradesPerDay: 10,
        lastEntryTime: '14:30',
        squareOffTime: '15:30',
        otmSkip: 0,
        ...strategyOverrides,
      },
      ...optionsOverrides,
    },
  })
}

describe('replay costs', () => {
  it('matches the browser paper ledger fee math in paper-parity mode', () => {
    const sell = calculateOptionCharges(100_000, 'sell', COST_RATES['paper-parity'])
    const buy = calculateOptionCharges(100_000, 'buy', COST_RATES['paper-parity'])
    expect(sell.total).toBe(164.94)
    expect(buy.total).toBe(67.94)
  })

  it('adds the SEBI fee in statutory mode', () => {
    const sell = calculateOptionCharges(100_000, 'sell', COST_RATES.statutory)
    const buy = calculateOptionCharges(100_000, 'buy', COST_RATES.statutory)
    expect(sell.total).toBe(165.05)
    expect(buy.total).toBe(68.05)
    expect(sell.sebi).toBe(0.1)
  })

  it('applies symmetric bps slippage', () => {
    expect(applySlippage(100, 10, 'buy')).toBe(100.1)
    expect(applySlippage(100, 10, 'sell')).toBe(99.9)
  })
})

describe('replay contract selection', () => {
  const chain = [90, 95, 100, 105, 110].map((strike) =>
    optionRow(strike, 100, 10, 11),
  )

  it('selects ATM and steps OTM in the requested direction', () => {
    const ce = selectOptionContract(chain, 100, 'CE', 1, 75, 10)
    const pe = selectOptionContract(chain, 100, 'PE', 1, 75, 10)
    expect(ce?.strike).toBe(105)
    expect(pe?.strike).toBe(95)
    expect(ce?.lotSize).toBe(75)
  })

  it('skips same-day expiry and picks the next one', () => {
    expect(findNearestExpiry(['2026-03-02', '2026-03-10'], '2026-03-02')).toBe(
      '2026-03-10',
    )
    expect(findNearestExpiry(['2026-03-02'], '2026-03-02')).toBeNull()
  })

  it('refuses a far-away strike when the ATM region is missing', () => {
    expect(
      selectOptionContract([optionRow(120, 100)], 100, 'CE', 0, 75, 3),
    ).toBeNull()
  })
})

describe('replay time helpers', () => {
  it('filters the session to 09:15-15:30 IST and dedupes by minute', () => {
    const candles = [
      makeCandle(DATE, 540, 90),
      makeCandle(DATE, 555, 100),
      makeCandle(DATE, 556, 101),
      makeCandle(DATE, 556, 102),
      makeCandle(DATE, 930, 103),
      makeCandle(DATE, 931, 104),
      makeCandle(DATE, 959, 105),
    ]
    const session = sessionCandles(candles)
    expect(session.map((candle) => istMinute(candle[0]))).toEqual([555, 556, 930])
    expect(session[1][4]).toBe(102)
  })

  it('recognizes IST dates and NSE holidays', () => {
    expect(istDate('2026-03-04T03:45:00.000Z')).toBe('2026-03-04')
    expect(istMinute('2026-03-04T03:45:00.000Z')).toBe(555)
    expect(isTradingDate('2026-03-04')).toBe(true)
    expect(isTradingDate('2026-03-03')).toBe(false)
    expect(isTradingDate('2026-03-07')).toBe(false)
  })

  it('finds the option bar around a minute', () => {
    const series = makeSeries([
      makeOptionBar(DATE, 560, 100, 102, 99, 101),
      makeOptionBar(DATE, 562, 101, 105, 100, 104),
    ])
    expect(seriesAtOrBefore(series, 561)?.minute).toBe(560)
    expect(seriesFirstAtOrAfter(series, 561)?.minute).toBe(562)
  })
})

describe('replay execution', () => {
  it('fills at the next option bar open with no look-ahead and stop-first priority', async () => {
    const fixture = makeFixture({
      signalMinutes: [560],
      optionBars: [
        makeOptionBar(DATE, 561, 100, 130, 80, 100),
        makeOptionBar(DATE, 562, 100, 105, 95, 102),
      ],
    })
    const result = await runFixture(fixture)
    expect(result.trades).toHaveLength(1)
    const trade = result.trades[0]
    expect(trade.entrySignalMinute).toBe(560)
    expect(trade.entryMinute).toBe(561)
    expect(trade.entryPrice).toBe(100)
    expect(trade.quantity).toBe(75)
    expect(trade.exitReason).toBe('stop-loss')
    expect(trade.exitPrice).toBe(85)
    expect(trade.netPnl).toBeLessThan(-1100)

    const signalContext = fixture.source.contexts.find(
      (context) => context.minute === 560,
    )
    expect(signalContext).toBeDefined()
    expect(signalContext?.candles.at(-1)?.[0]).toBe(istIso(DATE, 560))
    expect(signalContext?.htfCandles.at(-1)?.[0]).toBe(istIso(DATE, 560))
  })

  it('does not use the entry bar close to trigger a same-bar trailing stop', async () => {
    const fixture = makeFixture({
      signalMinutes: [560],
      optionBars: [
        makeOptionBar(DATE, 561, 100, 130, 99, 125),
        makeOptionBar(DATE, 562, 120, 122, 118, 119),
      ],
    })
    const result = await runFixture(fixture, {
      maxProfitPct: 50,
      trailPct: 5,
    })
    expect(result.trades).toHaveLength(1)
    expect(result.trades[0].exitReason).toBe('trailing-stop')
    expect(result.trades[0].exitMinute).toBe(562)
    expect(result.trades[0].exitPrice).toBe(118.75)
  })

  it('waits for the configured entry delay and never enters early', async () => {
    const fixture = makeFixture({
      signalMinutes: [560],
      optionBars: [makeOptionBar(DATE, 562, 100, 105, 99, 104)],
    })
    const result = await runFixture(fixture, {}, { maxEntryDelayBars: 2 })
    expect(result.trades).toHaveLength(1)
    expect(result.trades[0].entrySignalMinute).toBe(560)
    expect(result.trades[0].entryMinute).toBe(562)
  })

  it('does not chase an entry beyond the configured delay', async () => {
    const fixture = makeFixture({
      signalMinutes: [560],
      optionBars: [makeOptionBar(DATE, 563, 100, 105, 99, 104)],
    })
    const result = await runFixture(fixture, {}, { maxEntryDelayBars: 2 })
    expect(result.trades).toHaveLength(0)
    expect(result.signals.noOptionBar).toBe(1)
  })

  it('takes the target when only the target is inside the bar', async () => {
    const fixture = makeFixture({
      signalMinutes: [560],
      optionBars: [makeOptionBar(DATE, 561, 100, 130, 99, 125)],
    })
    const result = await runFixture(fixture)
    expect(result.trades).toHaveLength(1)
    expect(result.trades[0].exitReason).toBe('target')
    expect(result.trades[0].exitPrice).toBe(120)
    expect(result.trades[0].netPnl).toBeGreaterThan(1400)
  })

  it('records a 5-min-filter veto instead of entering the counter-trend arm', async () => {
    const fixture = makeFixture({
      signalMinutes: [560],
      optionBars: [makeOptionBar(DATE, 561, 100, 130, 99, 125)],
    })
    fixture.source = new FilterVetoSource()
    const filtered = await runFixture(fixture)
    expect(filtered.trades).toHaveLength(0)
    expect(filtered.signals.filterVetoed).toBe(1)
    expect(filtered.signals.actionable).toBe(0)

    const unfiltered = await runFixture(fixture, { useMultiTimeframe: false })
    expect(unfiltered.trades).toHaveLength(1)
  })

  it('blocks a second entry when the daily cap is reached', async () => {
    const fixture = makeFixture({
      signalMinutes: [560, 562],
      optionBars: [
        makeOptionBar(DATE, 561, 100, 130, 99, 125),
        makeOptionBar(DATE, 563, 100, 130, 99, 125),
      ],
    })
    const result = await runFixture(fixture, { maxTradesPerDay: 1 })
    expect(result.trades).toHaveLength(1)
    expect(result.signals.entries).toBe(1)
    expect(result.signals.capBlocked).toBe(1)
  })

  it('routes exits through the exit cooldown', async () => {
    const fixture = makeFixture({
      signalMinutes: [560, 562],
      optionBars: [
        makeOptionBar(DATE, 561, 100, 130, 99, 125),
        makeOptionBar(DATE, 563, 100, 130, 99, 125),
      ],
    })
    const result = await runFixture(fixture, {
      maxTradesPerDay: 10,
      exitCooldownSec: 300,
    })
    expect(result.trades).toHaveLength(1)
    expect(result.signals.cooldownBlocked).toBe(1)
  })
})

describe('macro as-of reconstruction', () => {
  it('uses prior completed global close and current VIX open', () => {
    const file: YahooMacroFile = {
      source: 'test',
      fetchedAt: 'test',
      symbols: {
        '^GSPC': {
          label: 'S&P 500',
          bars: [
            { date: '2026-03-02', open: 100, high: 101, low: 99, close: 100 },
            { date: '2026-03-03', open: 105, high: 111, low: 104, close: 110 },
            { date: '2026-03-04', open: 115, high: 121, low: 114, close: 120 },
          ],
        },
        '^INDIAVIX': {
          label: 'India VIX',
          bars: [
            { date: '2026-03-03', open: 14, high: 15, low: 13, close: 14.5 },
            { date: '2026-03-04', open: 15, high: 16, low: 14, close: 16.5 },
          ],
        },
      },
    }
    const series = new MacroSeries(file)
    const day = series.getDay('2026-03-04')
    expect(day.items).toHaveLength(1)
    expect(day.items[0].symbol).toBe('S&P 500')
    expect(day.items[0].change_per).toBe(10)
    expect(day.vix).toBe(15)
    expect(day.vixSource).toBe('daily-open')
    expect(series.getDay('2026-03-05').vix).toBe(16.5)
    expect(series.getDay('2026-03-05').vixSource).toBe('previous-close')
  })
})

describe('replay report writer', () => {
  it('writes trade, daily, summary and markdown outputs', async () => {
    const fixture = makeFixture({
      signalMinutes: [560],
      optionBars: [makeOptionBar(DATE, 561, 100, 130, 99, 125)],
    })
    const result = await runFixture(fixture)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'algo-replay-test-'))
    try {
      writeReplayReport(result, dir)
      expect(fs.existsSync(path.join(dir, 'trades.csv'))).toBe(true)
      expect(fs.existsSync(path.join(dir, 'daily.csv'))).toBe(true)
      expect(fs.existsSync(path.join(dir, 'summary.json'))).toBe(true)
      expect(fs.readFileSync(path.join(dir, 'report.md'), 'utf8')).toContain(
        'NIFTY 50 cost-aware options replay',
      )
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
