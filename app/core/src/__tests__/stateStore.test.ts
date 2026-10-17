import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { StateStore } from '../services/stateStore'
import { DEFAULT_STRATEGY_CONFIG } from '../constants'
import type { PaperTradeRecord, UserBotState } from '../types'

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'algo-store-test-'))
}

function sampleUser(overrides: Partial<UserBotState> = {}): UserBotState {
  return {
    userId: 'u1',
    state: 'RUNNING',
    executionMode: 'paper',
    config: { ...DEFAULT_STRATEGY_CONFIG },
    upstoxToken: 'tok-123',
    positions: { 'NIFTY 50': null, BANKNIFTY: null, FINNIFTY: null },
    tradesCountToday: 1,
    tradesCountPerSymbol: { 'NIFTY 50': 1 },
    lastTradeDate: '2026-10-16',
    lastExitTimes: {},
    totalRealizedPnl: 0,
    paperBalance: 10000000,
    updatedAt: new Date().toISOString(),
    ...overrides,
  }
}

describe('StateStore', () => {
  it('round-trips user bot state (including token and positions)', () => {
    const dir = tempDir()
    const store = new StateStore(dir)

    const user = sampleUser({
      positions: {
        'NIFTY 50': {
          instrumentKey: 'NSE_FO|OPT_NIFTY_24500_CE',
          direction: 'CE',
          entryPrice: 120.5,
          quantity: 75,
          entryTime: '2026-10-16T04:00:00.000Z',
          tradeId: 123,
          peakFavorablePrice: 150.25,
          underlyingSymbol: 'NIFTY 50',
        },
        BANKNIFTY: null,
        FINNIFTY: null,
      },
    })

    store.saveUserState(user)
    store.close()

    const store2 = new StateStore(dir)
    const loaded = store2.loadUserStates()
    expect(loaded).toHaveLength(1)
    expect(loaded[0].userId).toBe('u1')
    expect(loaded[0].state).toBe('RUNNING')
    expect(loaded[0].upstoxToken).toBe('tok-123')
    expect(loaded[0].positions['NIFTY 50']?.peakFavorablePrice).toBe(150.25)
    expect(loaded[0].tradesCountPerSymbol['NIFTY 50']).toBe(1)
    store2.close()
  })

  it('upserts user state instead of duplicating rows', () => {
    const dir = tempDir()
    const store = new StateStore(dir)

    store.saveUserState(sampleUser())
    store.saveUserState(sampleUser({ state: 'STOPPED', tradesCountToday: 3 }))

    const loaded = store.loadUserStates()
    expect(loaded).toHaveLength(1)
    expect(loaded[0].state).toBe('STOPPED')
    expect(loaded[0].tradesCountToday).toBe(3)
    store.close()
  })

  it('round-trips paper accounts and trades with metadata', () => {
    const dir = tempDir()
    const store = new StateStore(dir)

    store.savePaperAccount({
      id: 'paper_acc_u1',
      userId: 'u1',
      balance: 10000000,
      currency: 'INR',
      updatedAt: '2026-10-16T04:00:00.000Z',
    })

    const trade: PaperTradeRecord = {
      id: 'paper_tr_1',
      accountId: 'paper_acc_u1',
      status: 'OPEN',
      instrumentKey: 'NSE_FO|OPT_NIFTY_24500_CE',
      direction: 'CE',
      quantity: 75,
      entryPrice: 12050,
      entryValue: 903750,
      openedAt: '2026-10-16T04:00:00.000Z',
      metadata: { tradeType: 'buying', underlyingSymbol: 'NIFTY 50' },
    }
    store.savePaperTrade(trade)
    store.close()

    const store2 = new StateStore(dir)
    const accounts = store2.loadPaperAccounts()
    expect(accounts).toHaveLength(1)
    expect(accounts[0].userId).toBe('u1')
    expect(accounts[0].balance).toBe(10000000)

    const trades = store2.loadPaperTrades()
    expect(trades).toHaveLength(1)
    expect(trades[0].id).toBe('paper_tr_1')
    expect(trades[0].status).toBe('OPEN')
    expect(trades[0].entryPrice).toBe(12050)
    expect(trades[0].metadata?.underlyingSymbol).toBe('NIFTY 50')
    store2.close()
  })

  it('persists trade close (exit price / realized pnl / cancellation)', () => {
    const dir = tempDir()
    const store = new StateStore(dir)

    const trade: PaperTradeRecord = {
      id: 'paper_tr_2',
      accountId: 'paper_acc_u1',
      status: 'OPEN',
      instrumentKey: 'NSE_FO|OPT_NIFTY_24500_PE',
      direction: 'PE',
      quantity: 75,
      entryPrice: 10000,
      entryValue: 750000,
      openedAt: '2026-10-16T04:00:00.000Z',
    }
    store.savePaperTrade(trade)

    // Simulate exit
    store.savePaperTrade({
      ...trade,
      status: 'CLOSED',
      exitPrice: 11000,
      exitValue: 825000,
      realizedPnl: 75000,
      closedAt: '2026-10-16T06:30:00.000Z',
      metadata: { exitReason: 'EOD' },
    })

    const trades = store.loadPaperTrades()
    expect(trades).toHaveLength(1)
    expect(trades[0].status).toBe('CLOSED')
    expect(trades[0].realizedPnl).toBe(75000)
    expect(trades[0].metadata?.exitReason).toBe('EOD')
    store.close()
  })

  it('creates the data directory if missing and closes idempotently', () => {
    const dir = path.join(tempDir(), 'nested', 'data')
    const store = new StateStore(dir)
    expect(fs.existsSync(path.join(dir, 'algo-trade.sqlite'))).toBe(true)
    store.close()
    expect(() => store.close()).not.toThrow()
  })
})
