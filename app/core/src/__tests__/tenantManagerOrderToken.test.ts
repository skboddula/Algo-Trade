import { afterAll, beforeAll, describe, it, expect, vi } from 'vitest'
import { TenantManager } from '../services/tenantManager'
import { MasterIngestionEngine } from '../services/masterIngestor'
import { OrderGateway } from '../services/orderGateway'
import type { MarketSnapshot, UnderlyingSymbol } from '../types'

// These tests exercise live-order token resolution, which the server-side
// arming gate (DAEMON_LIVE_ARMED) now guards. Arm the gate for this file.
beforeAll(() => {
  process.env[TenantManager.LIVE_ARM_ENV] = 'true'
})
afterAll(() => {
  delete process.env[TenantManager.LIVE_ARM_ENV]
})

// ── Fixtures ────────────────────────────────────────────────────────────────
// Deterministic harness for the daemon-only live-order token resolution:
// when nobody sets a per-user token (the dashboard never talks to the daemon),
// live orders must fall back to the master ingestion token refreshed via the
// OAuth flow (/auth/upstox/start → /auth/upstox/callback).

function makeBuyCeSnapshot(): MarketSnapshot {
  return {
    timestamp: new Date().toISOString(),
    underlyingSymbol: 'NIFTY 50',
    spotPrice: 25000,
    candles: [],
    optionChain: [
      {
        expiry: '2026-10-22',
        strike_price: 25000,
        underlying_spot_price: 25000,
        call_options: {
          instrument_key: 'NSE_FO|CE_25000',
          trading_symbol: 'NIFTY 25000 CE',
          market_data: { ltp: 150, volume: 1000, oi: 500 },
        },
        put_options: {
          instrument_key: 'NSE_FO|PE_25000',
          trading_symbol: 'NIFTY 25000 PE',
          market_data: { ltp: 140, volume: 1000, oi: 500 },
        },
      },
    ],
    signal: {
      signal: 'BUY_CE',
      confidence: 'strong',
      positionSize: 'full',
      v3: 'buy',
      v4: 'Buy',
      bullScore: 20,
      bearScore: 2,
      scoreMax: 24,
    },
  }
}

function makeTick(): { timestamp: string; snapshots: Record<UnderlyingSymbol, MarketSnapshot> } {
  return {
    timestamp: new Date().toISOString(),
    snapshots: { 'NIFTY 50': makeBuyCeSnapshot() } as Record<UnderlyingSymbol, MarketSnapshot>,
  }
}

function makeHarness(masterToken?: string) {
  const ingestor = new MasterIngestionEngine({ mockMode: true, primaryUpstoxToken: masterToken })
  const gateway = new OrderGateway()
  const placeSpy = vi.spyOn(gateway, 'placeOrder').mockResolvedValue({
    success: true,
    tradeId: 'tr_test_1',
    filledPrice: 151,
    quantity: 75,
  })
  const exitSpy = vi.spyOn(gateway, 'exitOrder').mockResolvedValue({
    success: true,
    tradeId: 'tr_test_2',
    filledPrice: 152,
    quantity: 75,
  })
  const manager = new TenantManager(ingestor, gateway)
  return { ingestor, gateway, manager, placeSpy, exitSpy }
}

const LIVE_POSITION = {
  instrumentKey: 'NSE_FO|CE_25000',
  direction: 'CE' as const,
  entryPrice: 150,
  quantity: 75,
  entryTime: new Date().toISOString(),
  tradeId: 1,
  currentPrice: 150,
  tradeType: 'buying' as const,
}

describe('Tenant Manager — daemon-only live-order token resolution', () => {
  it('live entry falls back to the master ingestion token when no per-user token is set', async () => {
    const { ingestor, manager, placeSpy } = makeHarness('master-token-abc')
    manager.updateConfig('u1', { lastEntryTime: '24:00' }) // never after cutoff, regardless of test clock
    manager.startBot('u1', 'live')

    ingestor.emit('marketTick', makeTick())

    await vi.waitFor(() => expect(placeSpy).toHaveBeenCalledTimes(1))
    expect(placeSpy.mock.calls[0][0]).toMatchObject({
      userId: 'u1',
      executionMode: 'live',
      token: 'master-token-abc',
      instrumentKey: 'NSE_FO|CE_25000',
    })
    expect(manager.getOrCreateUser('u1').positions['NIFTY 50']).not.toBeNull()
  })

  it('per-user token (POST /api/bot/token) takes precedence over the master token for live entry', async () => {
    const { ingestor, manager, placeSpy } = makeHarness('master-token-abc')
    manager.setToken('u1', 'user-token-xyz')
    manager.updateConfig('u1', { lastEntryTime: '24:00' })
    manager.startBot('u1', 'live')

    ingestor.emit('marketTick', makeTick())

    await vi.waitFor(() => expect(placeSpy).toHaveBeenCalledTimes(1))
    expect(placeSpy.mock.calls[0][0].token).toBe('user-token-xyz')
  })

  it('live exit falls back to the master ingestion token', async () => {
    const { manager, exitSpy } = makeHarness('master-token-abc')
    manager.startBot('u1', 'live')
    const user = manager.getOrCreateUser('u1')
    user.positions['NIFTY 50'] = { ...LIVE_POSITION }

    await manager.manualExit('u1', 'NIFTY 50', 'Test exit')

    expect(exitSpy).toHaveBeenCalledTimes(1)
    expect(exitSpy.mock.calls[0][0]).toMatchObject({
      userId: 'u1',
      executionMode: 'live',
      token: 'master-token-abc',
    })
  })

  it('per-user token takes precedence over the master token for live exit', async () => {
    const { manager, exitSpy } = makeHarness('master-token-abc')
    manager.setToken('u1', 'user-token-xyz')
    manager.startBot('u1', 'live')
    const user = manager.getOrCreateUser('u1')
    user.positions['NIFTY 50'] = { ...LIVE_POSITION }

    await manager.manualExit('u1', 'NIFTY 50', 'Test exit')

    expect(exitSpy).toHaveBeenCalledTimes(1)
    expect(exitSpy.mock.calls[0][0].token).toBe('user-token-xyz')
  })

  it('resolves to undefined when neither a user token nor a master token exists (unchanged error path)', async () => {
    const { manager, exitSpy } = makeHarness(undefined)
    manager.startBot('u1', 'live')
    const user = manager.getOrCreateUser('u1')
    user.positions['NIFTY 50'] = { ...LIVE_POSITION }

    await manager.manualExit('u1', 'NIFTY 50', 'Test exit')

    expect(exitSpy).toHaveBeenCalledTimes(1)
    expect(exitSpy.mock.calls[0][0].token).toBeUndefined()
  })
})
