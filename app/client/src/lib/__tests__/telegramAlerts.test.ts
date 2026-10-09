import { describe, it, expect } from 'vitest'

import { buildExitAlertMessage, buildEntryAlertMessage } from '../telegram'

describe('buildExitAlertMessage', () => {
  const baseAlert = {
    symbol: 'SENSEX',
    direction: 'CE' as const,
    executionMode: 'paper' as const,
    entryPrice: 550,
    exitPrice: 575,
    quantity: 20,
    lotSize: 20,
    tradeType: 'buying' as const,
    reason: 'Target profit hit',
    entryTime: '2026-10-07T09:30:00.000Z',
    exitTime: '2026-10-07T10:15:00.000Z',
  }

  it('builds a profitable exit message with positive PnL', () => {
    const message = buildExitAlertMessage(baseAlert)
    expect(message).toContain('🟢 ALGO TRADE — PAPER EXIT [SENSEX]')
    expect(message).toContain('SELL SENSEX CE @ 575')
    expect(message).toContain('Entry: 550 · Exit: 575')
    expect(message).toContain('Qty 20 (1 lot)')
    expect(message).toContain('Duration: 45 min')
    // PnL = (575-550)*20 = 500; PnL% = 500/(550*20)*100 = 4.5%
    expect(message).toContain('+₹500 (+4.5%)')
    expect(message).toContain('Reason: Target profit hit')
    expect(message).toContain('✅ Close your mirrored position')
  })

  it('builds a loss exit message with negative PnL', () => {
    const message = buildExitAlertMessage({
      ...baseAlert,
      entryPrice: 550,
      exitPrice: 440,
      reason: 'Stop loss hit',
    })
    expect(message).toContain('🔴 ALGO TRADE — PAPER EXIT [SENSEX]')
    // PnL = (440-550)*20 = -2200; PnL% = -2200/(550*20)*100 = -20%
    expect(message).toContain('−₹2200 (−20.0%)')
    expect(message).toContain('⚠️ Close your mirrored position')
  })

  it('handles selling (short) direction correctly', () => {
    const message = buildExitAlertMessage({
      ...baseAlert,
      tradeType: 'selling',
      entryPrice: 100,
      exitPrice: 80,
      direction: 'PE',
    })
    expect(message).toContain('BUY (cover) SENSEX PE @ 80')
    // PnL = (100-80)*20 = 400; PnL% = 400/(100*20)*100 = 20%
    expect(message).toContain('+₹400 (+20.0%)')
  })

  it('handles live mode icon and label', () => {
    const message = buildExitAlertMessage({
      ...baseAlert,
      executionMode: 'live',
    })
    expect(message).toContain('LIVE EXIT')
  })

  it('formats duration in hours and minutes when over 60 min', () => {
    const message = buildExitAlertMessage({
      ...baseAlert,
      entryTime: '2026-10-07T09:30:00.000Z',
      exitTime: '2026-10-07T11:15:00.000Z',
    })
    expect(message).toContain('Duration: 1h 45m')
  })

  it('handles invalid timestamps gracefully', () => {
    const message = buildExitAlertMessage({
      ...baseAlert,
      entryTime: 'invalid-date',
      exitTime: 'also-invalid',
    })
    expect(message).not.toContain('Duration:')
  })

  it('includes strike price and expiry when provided', () => {
    const message = buildExitAlertMessage({
      ...baseAlert,
      strikePrice: 64500,
      expiry: '2026-10-13',
    })
    expect(message).toContain('SELL SENSEX 64500 CE @ 575')
    expect(message).toContain('Expiry: 2026-10-13')
  })

  it('omits strike and expiry when not provided (legacy positions)', () => {
    const message = buildExitAlertMessage(baseAlert)
    expect(message).toContain('SELL SENSEX CE @ 575')
    expect(message).not.toContain('Expiry:')
  })
})

describe('buildEntryAlertMessage (regression)', () => {
  it('still produces entry alerts correctly', () => {
    const message = buildEntryAlertMessage({
      symbol: 'NIFTY 50',
      signal: 'BUY_CE',
      confidence: 'strong',
      executionMode: 'paper',
      strikePrice: 24000,
      expiry: '2026-10-08',
      legs: [
        {
          direction: 'CE',
          entryPrice: 100,
          quantity: 75,
          lotSize: 75,
          tradeType: 'buying',
        },
      ],
      maxProfitPct: 20,
      maxLossPct: 10,
    })
    expect(message).toContain('🟢 ALGO TRADE — PAPER ENTRY [NIFTY 50]')
    expect(message).toContain('BUY NIFTY 50 24000 CE @ 100')
    expect(message).toContain('SL ≈ 90')
  })
})
