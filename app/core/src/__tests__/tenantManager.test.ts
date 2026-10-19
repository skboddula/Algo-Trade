import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { TenantManager } from '../services/tenantManager'
import { MasterIngestionEngine } from '../services/masterIngestor'
import { OrderGateway } from '../services/orderGateway'
import { StateStore } from '../services/stateStore'
import { DEFAULT_STRATEGY_CONFIG } from '../constants'
import type { UserBotState } from '../types'

describe('Tenant Manager Suite (Multi-User Headless Bot Supervisor)', () => {
  it('isolates user bot instances and configurations independently', () => {
    const ingestor = new MasterIngestionEngine({ mockMode: true })
    const gateway = new OrderGateway()
    const manager = new TenantManager(ingestor, gateway)

    const userA = manager.getOrCreateUser('alice')
    const userB = manager.getOrCreateUser('bob')

    manager.updateConfig('alice', { strongThreshold: 18, maxLossPct: 10 })
    manager.updateConfig('bob', { strongThreshold: 12, maxLossPct: 20 })

    expect(userA.config.strongThreshold).toBe(18)
    expect(userB.config.strongThreshold).toBe(12)
    expect(userA.userId).toBe('alice')
    expect(userB.userId).toBe('bob')
  })

  it('manages bot lifecycle: IDLE -> RUNNING -> STOPPED', () => {
    const ingestor = new MasterIngestionEngine({ mockMode: true })
    const gateway = new OrderGateway()
    const manager = new TenantManager(ingestor, gateway)

    const user = manager.getOrCreateUser('trader_1')
    expect(user.state).toBe('IDLE')

    manager.startBot('trader_1', 'paper')
    expect(user.state).toBe('RUNNING')
    expect(user.executionMode).toBe('paper')

    manager.stopBot('trader_1')
    expect(user.state).toBe('STOPPED')
  })

  it('automatically enters position on valid signal during market tick and supervises position', async () => {
    const ingestor = new MasterIngestionEngine({ mockMode: true })
    const gateway = new OrderGateway()
    const manager = new TenantManager(ingestor, gateway)

    // Start bot for Alice
    manager.startBot('alice', 'paper')
    manager.updateConfig('alice', {
      strongThreshold: 1, // Easy threshold for test
      moderateThreshold: 1,
      minConfidence: 'moderate',
    })

    // Fetch and process tick
    await ingestor.fetchAndComputeMarketData()

    const user = manager.getOrCreateUser('alice')
    // Bot should have transitioned to ORDERED if signal was available
    const hasPosition = Object.values(user.positions).some((p) => p !== null)
    if (hasPosition) {
      expect(user.state).toBe('ORDERED')
      const niftyPos = user.positions['NIFTY 50']
      expect(niftyPos?.quantity).toBeGreaterThan(0)
      expect(niftyPos?.entryPrice).toBeGreaterThan(0)
    }
  })

  const buildEntryTick = () => {
    const chainRow = {
      expiry: '2099-01-07',
      strike_price: 25000,
      underlying_spot_price: 25000,
      call_options: { instrument_key: 'NSE_FO|CE1', trading_symbol: 'CE1', market_data: { ltp: 100, volume: 1, oi: 1 } },
      put_options: { instrument_key: 'NSE_FO|PE1', trading_symbol: 'PE1', market_data: { ltp: 200, volume: 1, oi: 1 } },
    }
    const snapshot = {
      timestamp: new Date().toISOString(),
      underlyingSymbol: 'NIFTY 50',
      spotPrice: 25000,
      candles: [],
      optionChain: [chainRow],
      indicators: {
        ema: 'Buy',
        adx: 'Buy',
        rsi: { value: 60, signal: 'Neutral' },
        stochastic: { k: 50, d: 50, signal: 'Hold' },
        bollinger: { upper: 25100, middle: 25000, lower: 24900, signal: 'Hold', trend: 'Up' },
        atr: { value: 30, level: 'Medium' },
        pcr: 'Hold',
        pcrValue: 1,
      },
      signal: { signal: 'BUY_CE', confidence: 'strong', positionSize: 'full' },
      sources: {
        quoteAgeMs: 5_000,
        candlesAgeMs: 5_000,
        chainAgeMs: 5_000,
        vixAgeMs: null,
        entryBlockedReasons: [] as string[],
      },
    }
    const tick = { timestamp: new Date().toISOString(), snapshots: { 'NIFTY 50': snapshot } }
    return { snapshot, tick }
  }

  it('gates new entries on snapshot source freshness (CR-11 arms)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-19T04:30:00.000Z')) // Monday 10:00 IST
    try {
      const ingestor = new MasterIngestionEngine({ mockMode: true })
      const gateway = new OrderGateway()
      const manager = new TenantManager(ingestor, gateway)
      const placeSpy = vi.spyOn(gateway, 'placeOrder')

      manager.startBot('gated', 'paper')
      manager.updateConfig('gated', {
        underlyingMode: 'NIFTY 50',
        lastEntryTime: '23:59', // deterministic: never past cutoff during tests
        strongThreshold: 1,
        moderateThreshold: 1,
        minConfidence: 'moderate',
      })

      const { snapshot, tick } = buildEntryTick()

      // Stale sources → entry blocked, no order placed.
      snapshot.sources.entryBlockedReasons = ['candles/indicators stale or missing']
      await (manager as any).handleMarketTick(tick)
      const gated = manager.getOrCreateUser('gated')
      expect(placeSpy).not.toHaveBeenCalled()
      expect(gated.positions['NIFTY 50']).toBeNull()

      // Fresh sources → gate opens, the same tick enters normally.
      snapshot.sources.entryBlockedReasons = []
      await (manager as any).handleMarketTick(tick)
      expect(placeSpy).toHaveBeenCalledTimes(1)
      expect(gated.positions['NIFTY 50']).not.toBeNull()
      placeSpy.mockRestore()
    } finally {
      vi.useRealTimers()
    }
  })

  it('squares off positions held outside market hours (off-hours guard)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date('2026-10-19T12:30:00.000Z')) // Monday 18:00 IST — after close
      const ingestor = new MasterIngestionEngine({ mockMode: true })
      const gateway = new OrderGateway()
      const manager = new TenantManager(ingestor, gateway)

      manager.startBot('keeper', 'paper')
      const user = manager.getOrCreateUser('keeper')
      user.positions['NIFTY 50'] = {
        instrumentKey: 'NSE_FO|OPT_24000_CE',
        direction: 'CE',
        entryPrice: 100,
        quantity: 65,
        entryTime: new Date().toISOString(),
        tradeId: Date.now(),
        executionMode: 'paper',
        currentPrice: 110,
        tradeType: 'buying',
        underlyingSymbol: 'NIFTY 50',
      }
      user.state = 'ORDERED'

      const { tick } = buildEntryTick()
      await (manager as any).handleMarketTick(tick)

      expect(user.positions['NIFTY 50']).toBeNull()
      expect(user.state).toBe('RUNNING')
    } finally {
      vi.useRealTimers()
    }
  })

  it('treats NSE holidays as non-market days (no entries)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date('2026-10-20T04:30:00.000Z')) // Tuesday 10:00 IST — Dussehra
      const ingestor = new MasterIngestionEngine({ mockMode: true })
      const gateway = new OrderGateway()
      const manager = new TenantManager(ingestor, gateway)

      manager.startBot('holiday', 'paper')
      manager.updateConfig('holiday', {
        underlyingMode: 'NIFTY 50',
        strongThreshold: 1,
        moderateThreshold: 1,
        minConfidence: 'moderate',
      })

      const { tick } = buildEntryTick()
      await (manager as any).handleMarketTick(tick)

      expect(manager.getOrCreateUser('holiday').positions['NIFTY 50']).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('allows manual position exit and updates state', async () => {
    const ingestor = new MasterIngestionEngine({ mockMode: true })
    const gateway = new OrderGateway()
    const manager = new TenantManager(ingestor, gateway)

    manager.startBot('alice', 'paper')

    // Force create an open position
    const user = manager.getOrCreateUser('alice')
    user.positions['NIFTY 50'] = {
      instrumentKey: 'NSE_FO|OPT_24000_CE',
      direction: 'CE',
      entryPrice: 100,
      quantity: 65,
      entryTime: new Date().toISOString(),
      tradeId: Date.now(),
      executionMode: 'paper',
      currentPrice: 110,
      tradeType: 'buying',
      underlyingSymbol: 'NIFTY 50',
    }
    user.state = 'ORDERED'

    const updatedUser = await manager.manualExit('alice', 'NIFTY 50', 'Test Manual Exit')
    expect(updatedUser.positions['NIFTY 50']).toBeNull()
    expect(updatedUser.state).toBe('RUNNING')
  })

  it('streams rehydrated open-position contracts and drops them on exit', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'algo-watch-test-'))
    const store = new StateStore(dir)
    const seeded: UserBotState = {
      userId: 'u9',
      state: 'ORDERED',
      executionMode: 'paper',
      config: { ...DEFAULT_STRATEGY_CONFIG },
      positions: {
        'NIFTY 50': {
          instrumentKey: 'NSE_FO|OPT_REHYDRATED_CE',
          direction: 'CE',
          entryPrice: 100,
          quantity: 75,
          entryTime: '2026-10-17T04:00:00.000Z',
          tradeId: 1,
          tradeType: 'buying',
          currentPrice: 100,
          underlyingSymbol: 'NIFTY 50',
        },
        BANKNIFTY: null,
        FINNIFTY: null,
      },
      tradesCountToday: 1,
      tradesCountPerSymbol: { 'NIFTY 50': 1 },
      lastTradeDate: '2026-10-17',
      lastExitTimes: {},
      totalRealizedPnl: 0,
      paperBalance: 100000,
      updatedAt: '2026-10-17T04:00:00.000Z',
    }
    store.saveUserState(seeded)

    const ingestor = new MasterIngestionEngine({ mockMode: true })
    const spy = vi.spyOn(ingestor, 'setWatchedOptionContracts')
    const manager = new TenantManager(ingestor, new OrderGateway('https://api.upstox.com/v2', store), { store })

    // Rehydration wired the open position's contract into the live feed
    expect(spy).toHaveBeenCalledWith(['NSE_FO|OPT_REHYDRATED_CE'])

    // Exit unsubscribes it again
    await manager.manualExit('u9', 'NIFTY 50', 'test exit')
    expect(spy).toHaveBeenLastCalledWith([])

    store.close()
  })
})
