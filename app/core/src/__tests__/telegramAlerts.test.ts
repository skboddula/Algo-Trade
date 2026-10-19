import { describe, it, expect } from 'vitest'
import {
  buildDailyLossAlertMessage,
  buildDailySummaryMessage,
  buildEntryAlertMessage,
  buildExitAlertMessage,
  buildVixAlertMessage,
} from '../../../../packages/shared/src/telegram'

/**
 * Telegram alert builders — ported from the always-on-daemon branch and
 * unified into packages/shared. These tests pin the wording and the money
 * math (rupees contract) so the daemon and any future client emit identical
 * texts.
 */

describe('buildEntryAlertMessage', () => {
  it('carries instrument, SL/target levels, trail and signal details', () => {
    const msg = buildEntryAlertMessage({
      symbol: 'BANKNIFTY',
      signal: 'BUY_CE',
      confidence: 'strong',
      executionMode: 'paper',
      strikePrice: 58500,
      expiry: '2026-10-29',
      legs: [
        { direction: 'CE', entryPrice: 573.07, quantity: 65, lotSize: 65, tradeType: 'buying' },
      ],
      maxProfitPct: 20,
      maxLossPct: 15,
      trailPct: 5,
    })

    expect(msg).toContain('🟢 ALGO TRADE — PAPER ENTRY [BANKNIFTY]')
    expect(msg).toContain('BUY BANKNIFTY 58500 CE @ 573.07')
    expect(msg).toContain('CE: qty 65 (1 lot)')
    expect(msg).toContain('Expiry: 2026-10-29')
    // 573.07 * 0.85 = 487.11 · 573.07 * 1.20 = 687.68
    expect(msg).toContain('SL ≈ 487.11 (−15%) · Target ≈ 687.68 (+20%)')
    expect(msg).toContain('Trail: 5% from peak')
    expect(msg).toContain('Signal: BUY_CE · strong confidence')
  })

  it('marks live entries red and omits confidence when unknown', () => {
    const msg = buildEntryAlertMessage({
      symbol: 'NIFTY 50',
      signal: 'BUY_PE',
      executionMode: 'live',
      legs: [
        { direction: 'PE', entryPrice: 120, quantity: 75, lotSize: 75, tradeType: 'buying' },
      ],
      maxProfitPct: 10,
      maxLossPct: 5,
    })

    expect(msg).toContain('🔴 ALGO TRADE — LIVE ENTRY [NIFTY 50]')
    expect(msg).toContain('Signal: BUY_PE')
    expect(msg).not.toContain('confidence')
  })
})

describe('buildExitAlertMessage', () => {
  it('computes profit, percentage and duration for a buy', () => {
    const msg = buildExitAlertMessage({
      symbol: 'BANKNIFTY',
      direction: 'CE',
      executionMode: 'paper',
      entryPrice: 120,
      exitPrice: 138,
      quantity: 65,
      lotSize: 65,
      tradeType: 'buying',
      reason: 'Target hit',
      entryTime: '2026-10-19T07:40:00.000Z',
      exitTime: '2026-10-19T07:42:00.000Z',
      strikePrice: 58500,
    })

    expect(msg).toContain('🟢 ALGO TRADE — PAPER EXIT [BANKNIFTY]')
    expect(msg).toContain('SELL BANKNIFTY 58500 CE @ 138')
    expect(msg).toContain('Duration: 2 min')
    expect(msg).toContain('PnL: +₹1170 (+15.0%)')
    expect(msg).toContain('Reason: Target hit')
    expect(msg).toContain('✅')
  })

  it('flags a loss in red and mirrors the short side for selling', () => {
    const msg = buildExitAlertMessage({
      symbol: 'NIFTY 50',
      direction: 'PE',
      executionMode: 'paper',
      entryPrice: 100,
      exitPrice: 110,
      quantity: 65,
      lotSize: 65,
      tradeType: 'selling',
      reason: 'Hard Stop / Trailing SL',
      entryTime: '2026-10-19T07:40:00.000Z',
      exitTime: '2026-10-19T07:45:00.000Z',
    })

    expect(msg).toContain('🔴 ALGO TRADE — PAPER EXIT [NIFTY 50]')
    expect(msg).toContain('BUY (cover) NIFTY 50 PE @ 110')
    expect(msg).toContain('PnL: −₹650 (−10.0%)')
    expect(msg).toContain('⚠️')
  })
})

describe('buildVixAlertMessage', () => {
  it('names the level and the hard-stop threshold', () => {
    const msg = buildVixAlertMessage({ vix: 24.6, threshold: 25 })
    expect(msg).toContain('⚠️ VIX ALERT — India VIX at 24.6')
    expect(msg).toContain('Hard stop threshold is 25')
  })
})

describe('buildDailySummaryMessage', () => {
  it('formats signed rupees, balance and best/worst trades', () => {
    const msg = buildDailySummaryMessage({
      date: '2026-10-19',
      totalTrades: 3,
      wins: 1,
      losses: 2,
      realizedPnl: -1379.77,
      paperBalance: 98620.23,
      bestTrade: { symbol: 'FINNIFTY', direction: 'CE', pnl: 1423.74 },
      worstTrade: { symbol: 'BANKNIFTY', direction: 'PE', pnl: -1152.29 },
    })

    expect(msg).toContain('📊 DAILY SUMMARY — 2026-10-19')
    expect(msg).toContain('Trades: 3 | Wins: 1 | Losses: 2')
    expect(msg).toContain('Realized PnL: −₹1379.77')
    expect(msg).toContain('Paper Balance: ₹98620.23')
    expect(msg).toContain('Best: FINNIFTY CE +₹1423.74')
    expect(msg).toContain('Worst: BANKNIFTY PE −₹1152.29')
  })
})

describe('buildDailyLossAlertMessage', () => {
  it('states the day P&L, limit and equity-base provenance', () => {
    const msg = buildDailyLossAlertMessage({
      dayPnl: -10000.01,
      dayStartEquity: 100000,
      limitPct: 10,
      source: 'paper-ledger',
    })

    expect(msg).toContain('🛑 DAILY LOSS LIMIT — entries blocked for the rest of the day')
    expect(msg).toContain('Day P&L: −₹10000.01 (10.00%) · limit −10%')
    expect(msg).toContain('Base: ₹100000.00 (paper-ledger)')
    expect(msg).toContain('No new entries until the next trading day.')
  })
})
