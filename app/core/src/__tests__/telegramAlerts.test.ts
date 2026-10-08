import { describe, it, expect } from 'vitest'

import {
  formatEntryAlert,
  formatExitAlert,
  formatVixAlert,
  formatDailySummary,
} from '../services/telegramAlerts'

describe('formatEntryAlert', () => {
  const base = {
    symbol: 'BANKNIFTY',
    signal: 'BUY_CE',
    confidence: 'strong',
    executionMode: 'paper' as const,
    strikePrice: 54500,
    entryPrice: 553.7,
    quantity: 30,
    lotSize: 30,
    tradeType: 'buying' as const,
    maxProfitPct: 10,
    maxLossPct: 5,
    trailPct: 5,
  }

  it('formats a paper BUY_CE entry with SL/target/trail', () => {
    const msg = formatEntryAlert(base)
    expect(msg).toContain('🟢 ALGO TRADE — PAPER ENTRY [BANKNIFTY]')
    expect(msg).toContain('BUY BANKNIFTY 54500 CE @ 553.7')
    expect(msg).toContain('Qty 30 (1 lot)')
    expect(msg).toContain('SL ≈ 526.01 (−5%)')
    expect(msg).toContain('Target ≈ 609.07 (+10%)')
    expect(msg).toContain('Trail: 5% from peak')
    expect(msg).toContain('Signal: BUY_CE · strong confidence')
  })

  it('formats a live entry with red icon', () => {
    const msg = formatEntryAlert({ ...base, executionMode: 'live' })
    expect(msg).toContain('🔴 ALGO TRADE — LIVE ENTRY')
  })

  it('handles selling (short) direction with inverted SL/target', () => {
    const msg = formatEntryAlert({
      ...base,
      signal: 'BUY_PE',
      tradeType: 'selling',
      entryPrice: 100,
      maxProfitPct: 20,
      maxLossPct: 10,
    })
    expect(msg).toContain('SELL')
    expect(msg).toContain('SL ≈ 110 (+10%)')
    expect(msg).toContain('Target ≈ 80 (−20%)')
  })
})

describe('formatExitAlert', () => {
  const base = {
    symbol: 'BANKNIFTY',
    direction: 'CE' as const,
    executionMode: 'paper' as const,
    entryPrice: 553.7,
    exitPrice: 707.3,
    quantity: 30,
    lotSize: 30,
    tradeType: 'buying' as const,
    reason: 'EOD forced exit',
    entryTime: '2026-10-08T06:20:31.847Z',
    exitTime: '2026-10-08T09:39:22.221Z',
  }

  it('formats a profitable exit with PnL and duration', () => {
    const msg = formatExitAlert(base)
    expect(msg).toContain('🟢 ALGO TRADE — PAPER EXIT [BANKNIFTY]')
    expect(msg).toContain('SELL BANKNIFTY CE @ 707.3')
    expect(msg).toContain('Entry: 553.7 · Exit: 707.3')
    expect(msg).toContain('Qty 30 (1 lot)')
    expect(msg).toContain('+₹4608')
    expect(msg).toContain('Reason: EOD forced exit')
    expect(msg).toContain('✅ Close your mirrored position')
  })

  it('formats a loss exit with red icon and warning', () => {
    const msg = formatExitAlert({
      ...base,
      exitPrice: 400,
      reason: 'Stop loss hit',
    })
    expect(msg).toContain('🔴 ALGO TRADE — PAPER EXIT')
    expect(msg).toContain('−₹')
    expect(msg).toContain('⚠️ Close your mirrored position')
  })

  it('formats duration in hours and minutes when over 60 min', () => {
    const msg = formatExitAlert({
      ...base,
      entryTime: '2026-10-08T04:00:00.000Z',
      exitTime: '2026-10-08T06:30:00.000Z',
    })
    expect(msg).toContain('Duration: 2h 30m')
  })
})

describe('formatVixAlert', () => {
  it('formats a critical VIX warning', () => {
    const msg = formatVixAlert({ vix: 24.5, threshold: 25 })
    expect(msg).toContain('⚠️ VIX ALERT')
    expect(msg).toContain('India VIX at 24.5')
    expect(msg).toContain('entries will be blocked soon')
  })
})

describe('formatDailySummary', () => {
  it('formats a complete daily summary', () => {
    const msg = formatDailySummary({
      date: '2026-10-08',
      totalTrades: 4,
      wins: 2,
      losses: 2,
      realizedPnl: 1234.56,
      paperBalance: 101234.56,
      bestTrade: { symbol: 'BANKNIFTY', direction: 'CE', pnl: 4608 },
      worstTrade: { symbol: 'NIFTY 50', direction: 'PE', pnl: -1027 },
      vixLast: 14.2,
    })
    expect(msg).toContain('📊 DAILY SUMMARY — 2026-10-08')
    expect(msg).toContain('Trades: 4 | Wins: 2 | Losses: 2')
    expect(msg).toContain('+₹1234.56')
    expect(msg).toContain('Best: BANKNIFTY CE +₹4608.00')
    expect(msg).toContain('Worst: NIFTY 50 PE −₹1027.00')
    expect(msg).toContain('VIX (last): 14.2')
  })

  it('handles empty summary (no best/worst)', () => {
    const msg = formatDailySummary({
      date: '2026-10-08',
      totalTrades: 0,
      wins: 0,
      losses: 0,
      realizedPnl: 0,
      paperBalance: 100000,
    })
    expect(msg).toContain('Trades: 0')
    expect(msg).not.toContain('Best:')
    expect(msg).not.toContain('Worst:')
  })
})
