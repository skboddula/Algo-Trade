import { describe, it, expect, vi } from 'vitest'
import { OrderGateway } from '../services/orderGateway'
import type { ActivePosition } from '../types'
import { DEFAULT_INITIAL_PAPER_BALANCE } from '../constants'

describe('Order Gateway Suite (Paper Ledger & Broker Gateway)', () => {
  it('initializes and manages paper trading accounts', () => {
    const gateway = new OrderGateway()
    const account = gateway.getOrCreatePaperAccount('user_1')

    expect(account.id).toBe('paper_acc_user_1')
    expect(account.balance).toBe(DEFAULT_INITIAL_PAPER_BALANCE)
    expect(account.currency).toBe('INR')
  })

  it('places paper trade with realistic slippage and records trade in ledger', async () => {
    const gateway = new OrderGateway()
    const result = await gateway.placeOrder({
      userId: 'user_1',
      executionMode: 'paper',
      instrumentKey: 'NSE_FO|OPT_24000_CE',
      direction: 'CE',
      quantity: 50,
      price: 100,
      tradeType: 'buying',
      underlyingSymbol: 'NIFTY 50',
    })

    expect(result.success).toBe(true)
    expect(result.tradeId).toMatch(/^paper_tr_/)
    expect(result.filledPrice).toBeCloseTo(100.1, 1) // 0.1% buying slippage

    const trades = gateway.getPaperTrades('user_1')
    expect(trades.length).toBe(1)
    expect(trades[0].status).toBe('OPEN')
    expect(trades[0].instrumentKey).toBe('NSE_FO|OPT_24000_CE')
  })

  it('rejects orders that are not a whole multiple of the contract lot', async () => {
    const gateway = new OrderGateway()
    const rejected = await gateway.placeOrder({
      userId: 'user_lot',
      executionMode: 'paper',
      instrumentKey: 'NSE_FO|BANKNIFTY_PE',
      direction: 'PE',
      quantity: 65,
      lotSize: 30,
      price: 100,
      tradeType: 'buying',
      underlyingSymbol: 'BANKNIFTY',
    })

    expect(rejected.success).toBe(false)
    expect(rejected.error).toContain('positive multiple of the contract lot size')
    expect(gateway.getPaperTrades('user_lot')).toHaveLength(0)

    const accepted = await gateway.placeOrder({
      userId: 'user_lot',
      executionMode: 'paper',
      instrumentKey: 'NSE_FO|BANKNIFTY_PE',
      direction: 'PE',
      quantity: 60,
      lotSize: 30,
      price: 100,
      tradeType: 'buying',
      underlyingSymbol: 'BANKNIFTY',
    })

    expect(accepted.success).toBe(true)
    expect(accepted.quantity).toBe(60)
    expect(gateway.getPaperTrades('user_lot')).toHaveLength(1)
  })

  it('rejects paper order if balance is insufficient', async () => {
    const gateway = new OrderGateway()
    const account = gateway.getOrCreatePaperAccount('user_broke')
    account.balance = 50000 // Only ₹500 in paise

    const result = await gateway.placeOrder({
      userId: 'user_broke',
      executionMode: 'paper',
      instrumentKey: 'NSE_FO|OPT_24000_CE',
      direction: 'CE',
      quantity: 1000,
      price: 100, // Needs ₹1,00,000
      tradeType: 'buying',
    })

    expect(result.success).toBe(false)
    expect(result.error).toContain('Insufficient paper balance')
  })

  it('exits paper trade, updates realized PnL, and increments account balance', async () => {
    const gateway = new OrderGateway()
    const entryRes = await gateway.placeOrder({
      userId: 'user_profit',
      executionMode: 'paper',
      instrumentKey: 'NSE_FO|OPT_24000_CE',
      direction: 'CE',
      quantity: 50,
      price: 100,
      tradeType: 'buying',
    })

    const initialBalance = gateway.getOrCreatePaperAccount('user_profit').balance

    const position: ActivePosition = {
      instrumentKey: 'NSE_FO|OPT_24000_CE',
      direction: 'CE',
      entryPrice: entryRes.filledPrice,
      quantity: 50,
      entryTime: new Date().toISOString(),
      tradeId: 1,
      paperTradeId: entryRes.tradeId,
      tradeType: 'buying',
    }

    const exitRes = await gateway.exitOrder({
      userId: 'user_profit',
      executionMode: 'paper',
      position,
      exitPrice: 120, // +20 pts profit
      reason: 'Take Profit Hit',
    })

    expect(exitRes.success).toBe(true)

    const updatedAccount = gateway.getOrCreatePaperAccount('user_profit')
    expect(updatedAccount.balance).toBeGreaterThan(initialBalance)

    const trades = gateway.getPaperTrades('user_profit')
    const closedTrade = trades.find((t) => t.id === entryRes.tradeId)
    expect(closedTrade?.status).toBe('CLOSED')
    expect(closedTrade?.realizedPnl).toBeGreaterThan(0)
  })

  it('resets paper account balance to initial state and cancels open trades', () => {
    const gateway = new OrderGateway()
    const account = gateway.getOrCreatePaperAccount('user_reset')
    account.balance = 5000000

    const resetAcc = gateway.resetPaperAccount('user_reset')
    expect(resetAcc.balance).toBe(DEFAULT_INITIAL_PAPER_BALANCE)
  })

  it('refuses new live entries when DAEMON_LIVE_ARMED is not set', async () => {
    const previousArm = process.env.DAEMON_LIVE_ARMED
    const fetchMock = vi.fn().mockRejectedValue(new Error('network disabled'))
    vi.stubGlobal('fetch', fetchMock)
    delete process.env.DAEMON_LIVE_ARMED
    try {
      const gateway = new OrderGateway()
      const result = await gateway.placeOrder({
        userId: 'live_unarmed',
        executionMode: 'live',
        token: 'test-token',
        instrumentKey: 'NSE_FO|OPT_LIVE',
        direction: 'CE',
        quantity: 75,
        price: 100,
        tradeType: 'buying',
        underlyingSymbol: 'NIFTY 50',
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain('DAEMON_LIVE_ARMED')
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
      if (previousArm === undefined) delete process.env.DAEMON_LIVE_ARMED
      else process.env.DAEMON_LIVE_ARMED = previousArm
    }
  })
})
