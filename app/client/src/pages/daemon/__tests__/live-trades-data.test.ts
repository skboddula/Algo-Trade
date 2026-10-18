import { describe, it, expect } from 'vitest'
import type {
  ActivePosition,
  PaperTradeRecord,
  UserBotState,
} from '@/lib/types'
import { DEFAULT_CONFIG } from '@/lib/types'
import { buildDaemonDataset } from '../live-trades-data'
import { fmtCurrency, fmtPct } from '@/components/dashboard/trades/trades-model'

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

function makePosition(overrides: Partial<ActivePosition> = {}): ActivePosition {
  return {
    instrumentKey: 'NSE_FO|NIFTY50|CE|25000',
    direction: 'CE',
    entryPrice: 100,
    quantity: 50,
    entryTime: new Date().toISOString(),
    tradeId: 1,
    ...overrides,
  }
}

function makeTrade(
  overrides: Partial<PaperTradeRecord> = {},
): PaperTradeRecord {
  const now = new Date().toISOString()
  return {
    id: 'trade-1',
    accountId: 'default',
    status: 'CLOSED',
    instrumentKey: 'NSE_FO|NIFTY50|CE|25000',
    direction: 'CE',
    quantity: 50,
    entryPrice: 10_000,
    entryValue: 500_000,
    exitPrice: 10_500,
    exitValue: 525_000,
    realizedPnl: 25_000,
    openedAt: now,
    closedAt: now,
    metadata: { underlyingSymbol: 'NIFTY 50', tradeType: 'buying' },
    ...overrides,
  }
}

describe('buildDaemonDataset — paper mode', () => {
  it('builds stat cards from the daemon ledger', () => {
    const userState = makeUserState({
      positions: {
        'NIFTY 50': makePosition({ currentPrice: 110 }),
        BANKNIFTY: null,
        FINNIFTY: null,
      },
      tradesCountToday: 3,
    })
    const dataset = buildDaemonDataset({
      mode: 'paper',
      userState,
      paperTrades: [makeTrade()],
      liveFeed: false,
    })

    expect(dataset.stats[0].title).toBe('Portfolio Value')
    // 5,000 available + 5,000 committed + 500 unrealised
    expect(dataset.stats[0].value).toBe('₹10,500.00')
    expect(dataset.stats[1].title).toBe('Day P&L')
    // ₹250 realised + ₹500 unrealised
    expect(dataset.stats[1].value).toBe('+₹750.00')
    expect(dataset.stats[2].title).toBe('Open Positions')
    expect(dataset.stats[2].value).toBe('1')
    expect(dataset.stats[3].title).toBe('Win Rate')
    expect(dataset.stats[3].value).toBe('100.0%')
  })

  it('maps open positions to live rows with computed MTM', () => {
    const userState = makeUserState({
      positions: {
        'NIFTY 50': makePosition({
          tradeType: 'selling',
          currentPrice: 90,
        }),
        BANKNIFTY: null,
        FINNIFTY: null,
      },
    })
    const dataset = buildDaemonDataset({
      mode: 'paper',
      userState,
      paperTrades: [],
      liveFeed: true,
    })

    expect(dataset.openRows).toHaveLength(1)
    const row = dataset.openRows[0]
    expect(row.symbol).toBe('NIFTY 50')
    expect(row.displaySymbol).toBe('NIFTY 50 CE')
    expect(row.side).toBe('SELL')
    expect(row.type).toBe('CE')
    expect(row.qty).toBe(50)
    expect(row.entryPrice).toBe(100)
    expect(row.ltp).toBe(90)
    // selling: (entry − current) × qty
    expect(row.pnl).toBe(500)
    expect(row.pnlPct).toBeCloseTo(10)
    expect(row.status).toBe('ACTIVE')
    expect(row.isPaper).toBe(true)
  })

  it('aggregates multi-leg positions', () => {
    const userState = makeUserState({
      positions: {
        'NIFTY 50': makePosition({
          legs: [
            {
              instrumentKey: 'NSE_FO|NIFTY50|CE|25000',
              direction: 'CE',
              entryPrice: 100,
              quantity: 50,
              tradeType: 'buying',
              currentPrice: 110,
            },
            {
              instrumentKey: 'NSE_FO|NIFTY50|PE|25000',
              direction: 'PE',
              entryPrice: 80,
              quantity: 50,
              tradeType: 'selling',
              currentPrice: 78,
            },
          ],
        }),
        BANKNIFTY: null,
        FINNIFTY: null,
      },
    })
    const dataset = buildDaemonDataset({
      mode: 'paper',
      userState,
      paperTrades: [],
      liveFeed: true,
    })

    // (110−100)×50 + (80−78)×50 = 500 + 100
    expect(dataset.openRows[0].pnl).toBe(600)
  })

  it('maps closed paper trades with paise → rupees conversion', () => {
    const dataset = buildDaemonDataset({
      mode: 'paper',
      userState: makeUserState(),
      paperTrades: [
        makeTrade(),
        makeTrade({
          id: 'trade-2',
          realizedPnl: -15_000,
          metadata: { underlyingSymbol: 'BANKNIFTY', tradeType: 'selling' },
        }),
        makeTrade({ id: 'trade-3', status: 'CANCELLED', realizedPnl: 0 }),
        makeTrade({
          id: 'trade-old',
          closedAt: '2024-01-01T10:00:00.000Z',
          openedAt: '2024-01-01T09:30:00.000Z',
        }),
      ],
      liveFeed: true,
    })

    // Old trade filtered out by isToday()
    expect(dataset.closedRows).toHaveLength(3)
    const winning = dataset.closedRows.find((r) => r.id === 'trade-1')!
    expect(winning.pnl).toBe(250)
    expect(winning.status).toBe('TARGET_HIT')
    expect(winning.displaySymbol).toBe('NIFTY 50 CE')
    const losing = dataset.closedRows.find((r) => r.id === 'trade-2')!
    expect(losing.side).toBe('SELL')
    expect(losing.pnl).toBe(-150)
    expect(losing.status).toBe('SL_HIT')
    const cancelled = dataset.closedRows.find((r) => r.id === 'trade-3')!
    expect(cancelled.status).toBe('CANCELLED')
  })
})

describe('buildDaemonDataset — live mode', () => {
  it('hides the paper ledger and shows live order language', () => {
    const dataset = buildDaemonDataset({
      mode: 'live',
      userState: makeUserState({
        executionMode: 'live',
        positions: {
          'NIFTY 50': makePosition({
            executionMode: 'live',
            currentPrice: 105,
          }),
          BANKNIFTY: null,
          FINNIFTY: null,
        },
        tradesCountToday: 2,
      }),
      paperTrades: [makeTrade()],
      liveFeed: true,
    })

    expect(dataset.stats[2].title).toBe('Open Orders')
    expect(dataset.stats[3].title).toBe('Trades Today')
    expect(dataset.stats[3].value).toBe('2')
    expect(dataset.closedRows).toHaveLength(0)
    expect(dataset.openRows[0].isPaper).toBe(false)
  })

  it('handles a null user state safely', () => {
    const dataset = buildDaemonDataset({
      mode: 'paper',
      userState: null,
      paperTrades: [],
      liveFeed: false,
    })
    expect(dataset.stats[0].value).toBe('₹0.00')
    expect(dataset.openRows).toHaveLength(0)
    expect(dataset.closedRows).toHaveLength(0)
  })
})

describe('formatting helpers', () => {
  it('formats signed currency', () => {
    expect(fmtCurrency(1234.5, true)).toBe('+₹1,234.50')
    expect(fmtCurrency(-1234.5, true)).toBe('-₹1,234.50')
    expect(fmtCurrency(1234.5)).toBe('₹1,234.50')
  })

  it('formats percentages with sign', () => {
    expect(fmtPct(2.345)).toBe('+2.35%')
    expect(fmtPct(-2.345)).toBe('-2.35%')
  })
})
