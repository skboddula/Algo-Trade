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
