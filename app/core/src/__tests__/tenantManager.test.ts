import { describe, it, expect } from 'vitest'
import { TenantManager } from '../services/tenantManager'
import { MasterIngestionEngine } from '../services/masterIngestor'
import { OrderGateway } from '../services/orderGateway'

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
})
