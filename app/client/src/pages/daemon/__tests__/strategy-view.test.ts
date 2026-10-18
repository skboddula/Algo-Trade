import { describe, it, expect } from 'vitest'
import { DEFAULT_CONFIG } from '@/lib/types'
import type {
  ActivePosition,
  IndicatorsResult,
  MarketSnapshot,
  UserBotState,
} from '@/lib/types'
import type { DaemonHealth, DaemonStatus } from '@/lib/daemon'
import { deriveDaemonStrategyView } from '../strategy-view'

function makeUserState(overrides: Partial<UserBotState> = {}): UserBotState {
  return {
    userId: 'default_user',
    state: 'RUNNING',
    executionMode: 'paper',
    config: DEFAULT_CONFIG,
    positions: { 'NIFTY 50': null, BANKNIFTY: null, FINNIFTY: null },
    tradesCountToday: 0,
    tradesCountPerSymbol: {},
    lastTradeDate: '',
    lastExitTimes: {},
    totalRealizedPnl: 0,
    paperBalance: 500_000,
    updatedAt: new Date().toISOString(),
    ...overrides,
  }
}

function makeIndicators(ema: IndicatorsResult['ema']): IndicatorsResult {
  return {
    ema,
    adx: 'Hold',
    rsi: { value: 55, signal: 'Hold' },
    stochastic: { k: 50, d: 50, signal: 'Hold' },
    bollinger: {
      upper: 25_100,
      middle: 25_000,
      lower: 24_900,
      signal: 'Hold',
      trend: 'Neutral',
    },
    atr: { value: 120, level: 'Low' },
    pcr: 'Hold',
    pcrValue: 1.02,
  }
}

function makeSnapshot(overrides: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
    timestamp: new Date().toISOString(),
    underlyingSymbol: 'NIFTY 50',
    spotPrice: 25_000,
    candles: [],
    ...overrides,
  }
}

function makeHealth(source: string): DaemonHealth {
  return {
    status: 'ok',
    timestamp: new Date().toISOString(),
    feed: {
      source,
      ws: {
        state: 'open',
        activeForMs: 60_000,
        frames: {
          initial: 1,
          live: 10,
          marketInfo: 0,
          other: 0,
          decodeErrors: 0,
        },
        ticks: { index: 42, option: 7 },
        optionKeys: { current: 8, peak: 9 },
        reconnects: 0,
        chain: { calls: 3, failures: 0, lastLatencyMs: 40 },
        expiry: { calls: 1, failures: 0 },
        lastMessageAgeMs: 120,
      },
    },
  }
}

function makeStatus(overrides: Partial<DaemonStatus> = {}): DaemonStatus {
  return {
    serverTime: new Date().toISOString(),
    snapshots: {},
    userState: makeUserState(),
    paperTrades: [],
    ...overrides,
  }
}

function makePosition(overrides: Partial<ActivePosition> = {}): ActivePosition {
  return {
    instrumentKey: 'NSE_FO|NIFTY50|CE|25000',
    direction: 'CE',
    entryPrice: 120,
    quantity: 75,
    entryTime: new Date().toISOString(),
    tradeId: 1,
    ...overrides,
  }
}

describe('deriveDaemonStrategyView', () => {
  it('maps mock mode to no token and healthy mock sources', () => {
    const view = deriveDaemonStrategyView(
      makeStatus(),
      makeHealth('mock'),
      'NIFTY 50',
    )
    expect(view.token).toBeNull()
    expect(view.sourceStatus.candles).toBe('ok')
    expect(view.state).toBe('RUNNING')
    expect(view.paperBalance).toBe(5000)
  })

  it('maps the active symbol position, trade count and last tick', () => {
    const position = makePosition()
    const view = deriveDaemonStrategyView(
      makeStatus({
        userState: makeUserState({
          positions: {
            'NIFTY 50': position,
            BANKNIFTY: null,
            FINNIFTY: null,
          },
          tradesCountToday: 3,
        }),
      }),
      makeHealth('mock'),
      'NIFTY 50',
    )
    expect(view.position).toEqual(position)
    expect(view.tradesCount).toBe(3)
    expect(view.lastUpdated).toMatch(/^\d{2}:\d{2}:\d{2}$/)
  })

  it('bridges snapshot indicators into allSignalData (v3 mapping)', () => {
    const status = makeStatus({
      snapshots: {
        'NIFTY 50': makeSnapshot({
          indicators: makeIndicators('Buy'),
          signal: {
            signal: 'BUY_CE',
            confidence: 'strong',
            positionSize: 'full',
            v3: 'buy',
            v4: 'Buy',
            bullScore: 8,
            bearScore: 2,
            scoreMax: 10,
          },
        }),
      },
    })
    const view = deriveDaemonStrategyView(
      status,
      makeHealth('mock'),
      'NIFTY 50',
    )
    expect(view.allSignalData?.v3).toBe('buy')
    expect(view.indicators?.ema).toBe('Buy')
    expect(view.finalSignal?.signal).toBe('BUY_CE')
  })

  it('maps Sell/Hold ema states and tolerates a missing snapshot', () => {
    const sell = deriveDaemonStrategyView(
      makeStatus({
        snapshots: {
          'NIFTY 50': makeSnapshot({ indicators: makeIndicators('Sell') }),
        },
      }),
      makeHealth('mock'),
      'NIFTY 50',
    )
    expect(sell.allSignalData?.v3).toBe('sell')

    const missing = deriveDaemonStrategyView(
      makeStatus(),
      makeHealth('mock'),
      'BANKNIFTY',
    )
    expect(missing.allSignalData).toBeNull()
    expect(missing.indicators).toBeNull()
    expect(missing.candles).toEqual([])
    expect(missing.finalSignal).toBeNull()
    expect(missing.position).toBeNull()
  })

  it('marks the feed live when the daemon source is not mock', () => {
    const view = deriveDaemonStrategyView(
      makeStatus(),
      makeHealth('upstox-ws-v3'),
      'NIFTY 50',
    )
    expect(view.token).toBe('daemon-master-token')
    expect(view.sourceStatus.candles).toBe('ok')
    expect(view.sourceStatus['option-chain']).toBe('ok')
  })
})
