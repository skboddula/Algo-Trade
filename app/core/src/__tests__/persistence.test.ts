import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { StateStore } from '../services/stateStore'
import { MasterIngestionEngine } from '../services/masterIngestor'
import { OrderGateway } from '../services/orderGateway'
import { TenantManager } from '../services/tenantManager'

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'algo-persist-test-'))
}

describe('restart recovery (StateStore + TenantManager + OrderGateway)', () => {
  it('rehydrates bot state and the paper ledger after a simulated restart', async () => {
    const dir = tempDir()

    // ── First "process" ─────────────────────────────────────────────────────
    const store1 = new StateStore(dir)
    const ingestor1 = new MasterIngestionEngine({ mockMode: true })
    const gateway1 = new OrderGateway('https://api.upstox.com/v2', store1)
    const tm1 = new TenantManager(ingestor1, gateway1, { store: store1 })

    tm1.setToken('u1', 'tok-abc')
    tm1.startBot('u1', 'paper')
    expect(tm1.getOrCreateUser('u1').state).toBe('RUNNING')

    const order = await gateway1.placeOrder({
      userId: 'u1',
      executionMode: 'paper',
      instrumentKey: 'NSE_FO|OPT_NIFTY_24500_CE',
      direction: 'CE',
      quantity: 75,
      price: 100,
      tradeType: 'buying',
      underlyingSymbol: 'NIFTY 50',
    })
    expect(order.success).toBe(true)
    store1.close()

    // ── Second "process" (restart) ──────────────────────────────────────────
    const store2 = new StateStore(dir)
    const gateway2 = new OrderGateway('https://api.upstox.com/v2', store2)
    const tm2 = new TenantManager(new MasterIngestionEngine({ mockMode: true }), gateway2, {
      store: store2,
    })

    const user = tm2.getOrCreateUser('u1')
    expect(user.state).toBe('RUNNING')
    expect(user.upstoxToken).toBe('tok-abc')

    const trades = gateway2.getPaperTrades('u1')
    expect(trades).toHaveLength(1)
    expect(trades[0].status).toBe('OPEN')
    expect(trades[0].instrumentKey).toBe('NSE_FO|OPT_NIFTY_24500_CE')
    store2.close()
  })

  it('keeps working without a store (in-memory mode)', async () => {
    const ingestor = new MasterIngestionEngine({ mockMode: true })
    const gateway = new OrderGateway('https://api.upstox.com/v2')
    const tm = new TenantManager(ingestor, gateway)

    const user = tm.startBot('u1', 'paper')
    expect(user.state).toBe('RUNNING')

    const order = await gateway.placeOrder({
      userId: 'u1',
      executionMode: 'paper',
      instrumentKey: 'NSE_FO|OPT_X',
      direction: 'CE',
      quantity: 75,
      price: 100,
      tradeType: 'buying',
    })
    expect(order.success).toBe(true)
  })
})
