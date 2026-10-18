import { describe, it, expect } from 'vitest'
import type { ActivePosition, PaperTradeRecord } from '@/lib/types'
import { buildDaemonHistoryData } from '../history-data'

function makeTrade(
  overrides: Partial<PaperTradeRecord> = {},
): PaperTradeRecord {
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
    openedAt: '2026-10-18T04:00:00.000Z',
    closedAt: '2026-10-18T10:00:00.000Z',
    metadata: { underlyingSymbol: 'NIFTY 50', tradeType: 'buying' },
    ...overrides,
  }
}

function makePosition(overrides: Partial<ActivePosition> = {}): ActivePosition {
  return {
    instrumentKey: 'NSE_FO|NIFTY50|CE|25000',
    direction: 'CE',
    entryPrice: 100,
    quantity: 50,
    entryTime: '2026-10-18T04:00:00.000Z',
    tradeId: 1,
    legs: [
      {
        instrumentKey: 'NSE_FO|NIFTY50|CE|25000',
        direction: 'CE',
        entryPrice: 100,
        quantity: 50,
        tradeType: 'selling',
        currentPrice: 90,
      },
    ],
    ...overrides,
  }
}

describe('buildDaemonHistoryData', () => {
  it('formats settled trades into statement + completed rows', () => {
    const data = buildDaemonHistoryData(
      [
        makeTrade(),
        makeTrade({
          id: 'trade-2',
          realizedPnl: -10_000,
          direction: 'PE',
          openedAt: '2026-10-18T04:30:00.000Z',
          closedAt: '2026-10-18T09:00:00.000Z',
          metadata: { underlyingSymbol: 'BANKNIFTY', tradeType: 'buying' },
        }),
      ],
      {},
      500_000,
    )

    expect(data.balanceLabel).toBe('₹5,000.00')
    expect(data.openCount).toBe(0)
    expect(data.statementRows).toHaveLength(2)
    expect(data.statementRows[0]).toMatchObject({
      amountLabel: '+₹250.00',
      amountPositive: true,
      balanceLabel: '₹5,000.00',
    })
    expect(data.statementRows[1]).toMatchObject({
      amountLabel: '-₹100.00',
      amountPositive: false,
      balanceLabel: '₹4,750.00',
    })
    expect(data.tradeRows[0]).toMatchObject({
      id: 'trade-1',
      quantity: 50,
      entryLabel: '100.00',
      exitLabel: '105.00',
      pnl: { label: '+₹250.00', positive: true, mtm: false },
      status: 'CLOSED',
    })
  })

  it('marks to market open selling trades from rupee position quotes', () => {
    const data = buildDaemonHistoryData(
      [
        makeTrade({
          id: 'open-sell',
          status: 'OPEN',
          exitPrice: undefined,
          exitValue: undefined,
          realizedPnl: undefined,
          closedAt: undefined,
          entryPrice: 10_000, // ₹100.00
          metadata: { underlyingSymbol: 'NIFTY 50', tradeType: 'selling' },
        }),
      ],
      { 'NIFTY 50': makePosition() },
      400_000,
    )

    expect(data.openCount).toBe(1)
    expect(data.tradeRows[0].exitLabel).toBe('90.00')
    expect(data.tradeRows[0].pnl).toEqual({
      label: '+₹500.00',
      positive: true,
      mtm: true,
    })
  })

  it('marks to market open buying trades with a loss', () => {
    const position = makePosition({
      legs: [
        {
          instrumentKey: 'NSE_FO|NIFTY50|CE|25000',
          direction: 'CE',
          entryPrice: 100,
          quantity: 50,
          tradeType: 'buying',
          currentPrice: 95,
        },
      ],
    })
    const data = buildDaemonHistoryData(
      [
        makeTrade({
          id: 'open-buy',
          status: 'OPEN',
          exitPrice: undefined,
          exitValue: undefined,
          realizedPnl: undefined,
          closedAt: undefined,
          entryPrice: 10_000,
          metadata: { underlyingSymbol: 'NIFTY 50', tradeType: 'buying' },
        }),
      ],
      { 'NIFTY 50': position },
      400_000,
    )

    expect(data.tradeRows[0].pnl).toEqual({
      label: '-₹250.00',
      positive: false,
      mtm: true,
    })
  })
})
