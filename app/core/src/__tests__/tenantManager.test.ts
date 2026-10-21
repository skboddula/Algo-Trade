import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { TenantManager } from '../services/tenantManager'
import { MasterIngestionEngine } from '../services/masterIngestor'
import { OrderGateway } from '../services/orderGateway'
import { StateStore } from '../services/stateStore'
import { DEFAULT_STRATEGY_CONFIG, LOSS_PAUSE_MS } from '../constants'
import type { FinalSignal, UserBotState } from '../types'

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

  it('summarizes execution mode for the startup banner', () => {
    const manager = new TenantManager(
      new MasterIngestionEngine({ mockMode: true }),
      new OrderGateway(),
    )
    expect(manager.getExecutionModeSummary()).toBe('paper')

    manager.startBot('paper_user', 'paper')
    expect(manager.getExecutionModeSummary()).toBe('paper')
    manager.stopBot('paper_user')

    const previousArm = process.env.DAEMON_LIVE_ARMED
    process.env.DAEMON_LIVE_ARMED = 'true'
    try {
      manager.startBot('live_user', 'live')
      expect(manager.getExecutionModeSummary()).toBe('mixed')

      const liveOnly = new TenantManager(
        new MasterIngestionEngine({ mockMode: true }),
        new OrderGateway(),
      )
      liveOnly.startBot('live_only', 'live')
      expect(liveOnly.getExecutionModeSummary()).toBe('live')
    } finally {
      if (previousArm === undefined) delete process.env.DAEMON_LIVE_ARMED
      else process.env.DAEMON_LIVE_ARMED = previousArm
    }
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
        higherTimeframeTrend: 'Hold',
      },
      signal: { signal: 'BUY_CE', confidence: 'strong', positionSize: 'full' },
      sources: {
        quoteAgeMs: 5_000,
        candlesAgeMs: 5_000,
        chainAgeMs: 5_000,
        vixAgeMs: null,
        sentimentFault: null as string | null,
        entryBlockedReasons: [] as string[],
      },
    }
    const tick = { timestamp: new Date().toISOString(), snapshots: { 'NIFTY 50': snapshot } }
    return { snapshot, tick }
  }

  const buildSignal = (
    confidence: FinalSignal['confidence'],
    direction: 'CE' | 'PE',
    score: number,
  ): FinalSignal => ({
    signal: direction === 'CE' ? 'BUY_CE' : 'BUY_PE',
    confidence,
    positionSize: confidence === 'strong' ? 'full' : 'half',
    v3: 'buy',
    v4: direction === 'CE' ? 'Buy' : 'Sell',
    bullScore: direction === 'CE' ? score : 0,
    bearScore: direction === 'PE' ? score : 0,
    scoreMax: 20,
  })

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

  it('sizes BANKNIFTY entries from the BANKNIFTY lot, not NIFTY', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-19T04:30:00.000Z')) // Monday 10:00 IST
    try {
      const gateway = new OrderGateway()
      const manager = new TenantManager(
        new MasterIngestionEngine({ mockMode: true }),
        gateway,
      )
      const placeSpy = vi.spyOn(gateway, 'placeOrder')

      manager.startBot('bn-lot', 'paper')
      manager.updateConfig('bn-lot', {
        underlyingMode: 'BANKNIFTY',
        lastEntryTime: '23:59',
        strongThreshold: 1,
        moderateThreshold: 1,
        minConfidence: 'moderate',
      })

      const { snapshot } = buildEntryTick()
      const bankSnapshot = {
        ...snapshot,
        underlyingSymbol: 'BANKNIFTY' as const,
        spotPrice: 55_000,
        optionChain: [
          {
            ...snapshot.optionChain[0],
            strike_price: 55_000,
            underlying_spot_price: 55_000,
          },
        ],
      }
      const tick = {
        timestamp: new Date().toISOString(),
        snapshots: { BANKNIFTY: bankSnapshot } as any,
      }

      await (manager as any).handleMarketTick(tick)

      expect(placeSpy).toHaveBeenCalledTimes(1)
      expect(placeSpy.mock.calls[0][0]).toMatchObject({
        quantity: 30,
        lotSize: 30,
        underlyingSymbol: 'BANKNIFTY',
      })
      placeSpy.mockRestore()
    } finally {
      vi.useRealTimers()
    }
  })

  it('blocks new live entries per tick when the arm flag is removed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-19T04:30:00.000Z')) // Monday 10:00 IST
    const previousArm = process.env.DAEMON_LIVE_ARMED
    process.env.DAEMON_LIVE_ARMED = 'true'
    try {
      const gateway = new OrderGateway()
      const manager = new TenantManager(
        new MasterIngestionEngine({ mockMode: true }),
        gateway,
      )
      const placeSpy = vi.spyOn(gateway, 'placeOrder')
      manager.startBot('live-gated', 'live')
      manager.updateConfig('live-gated', {
        underlyingMode: 'NIFTY 50',
        lastEntryTime: '23:59',
        strongThreshold: 1,
        moderateThreshold: 1,
        minConfidence: 'moderate',
      })

      // Flag removed after the tenant started (e.g. restart with a persisted
      // live state): entries must stay blocked on every tick.
      delete process.env.DAEMON_LIVE_ARMED
      const { tick } = buildEntryTick()
      await (manager as any).handleMarketTick(tick)

      const user = manager.getOrCreateUser('live-gated')
      expect(placeSpy).not.toHaveBeenCalled()
      expect(user.positions['NIFTY 50']).toBeNull()
      expect(user.executionMode).toBe('live')

      // Re-arming opens the per-tick gate again.
      process.env.DAEMON_LIVE_ARMED = 'true'
      placeSpy.mockResolvedValueOnce({
        success: true,
        tradeId: 'live_test_trade',
        filledPrice: 100,
        quantity: 75,
      })
      await (manager as any).handleMarketTick(tick)
      expect(placeSpy).toHaveBeenCalledTimes(1)
      expect(user.positions['NIFTY 50']).not.toBeNull()
      placeSpy.mockRestore()
    } finally {
      vi.useRealTimers()
      if (previousArm === undefined) delete process.env.DAEMON_LIVE_ARMED
      else process.env.DAEMON_LIVE_ARMED = previousArm
    }
  })

  it('logs replayable filter verdicts and honors the per-user multi-timeframe toggle', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-19T04:30:00.000Z')) // Monday 10:00 IST
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'algo-signal-log-'))
    const store = new StateStore(dir)
    try {
      const gateway = new OrderGateway()
      const manager = new TenantManager(
        new MasterIngestionEngine({ mockMode: true }),
        gateway,
        { store },
      )
      const placeSpy = vi.spyOn(gateway, 'placeOrder')

      manager.startBot('filter-log', 'paper')
      manager.updateConfig('filter-log', {
        underlyingMode: 'NIFTY 50',
        lastEntryTime: '23:59',
        strongThreshold: 1,
        moderateThreshold: 1,
        minConfidence: 'moderate',
        maxTradesPerDay: 5,
        maxTotalTradesPerDay: 24,
        useMultiTimeframe: true,
      })

      const { snapshot, tick } = buildEntryTick()
      snapshot.indicators.higherTimeframeTrend = 'Sell'
      // Mark the snapshot as a production one (with the unfiltered reference
      // twin) so this exercises the per-user recompute path, not the legacy
      // test-fixture fallback.
      ;(snapshot as any).v3 = 'buy'
      ;(snapshot as any).unfilteredSignal = {
        signal: 'BUY_CE',
        confidence: 'strong',
        positionSize: 'full',
        v3: 'buy',
        v4: 'Hold',
        bullScore: 8,
        bearScore: 0,
        scoreMax: 14,
      }

      // Filter on: the counter-trend BUY_CE is vetoed, no order, but the
      // evaluation is still persisted with both arms.
      await (manager as any).handleMarketTick(tick)
      expect(placeSpy).not.toHaveBeenCalled()
      let rows = manager.getSignalSnapshots('filter-log', '2026-10-19')
      expect(rows.length).toBeGreaterThan(0)
      expect(rows[0].filterVerdict).toBe('vetoed')
      expect(rows[0].entryEligible).toBe(false)
      expect(rows[0].blockedReason).toBe('htf-veto')
      expect(rows[0].higherTimeframeTrend).toBe('Sell')
      expect(rows[0].unfilteredSignal.signal).toBe('BUY_CE')
      expect(rows[0].userSignal.signal).toBe('NO_TRADE')
      expect(rows[0].data.indicators.higherTimeframeTrend).toBe('Sell')

      // Filter off: the same signal enters, and the row is attached to the
      // resulting paper trade.
      manager.updateConfig('filter-log', { useMultiTimeframe: false })
      await (manager as any).handleMarketTick(tick)
      expect(placeSpy).toHaveBeenCalledTimes(1)
      rows = manager.getSignalSnapshots('filter-log', '2026-10-19')
      expect(rows[0].filterVerdict).toBe('off')
      expect(rows[0].entryEligible).toBe(true)
      expect(rows[0].orderPlaced).toBe(true)
      expect(rows[0].tradeId).toMatch(/^paper_tr_/)
      expect(rows[0].instrumentKey).toBe('NSE_FO|CE1')
      expect(rows[0].entryPrice).toBeGreaterThan(0)
      placeSpy.mockRestore()
    } finally {
      store.close()
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

  it('allows entries on other symbols while ORDERED (ALL_PARALLEL, CR-14)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-19T04:30:00.000Z')) // Monday 10:00 IST
    try {
      const ingestor = new MasterIngestionEngine({ mockMode: true })
      const gateway = new OrderGateway()
      const manager = new TenantManager(ingestor, gateway)
      const placeSpy = vi.spyOn(gateway, 'placeOrder')

      manager.startBot('parallel', 'paper')
      manager.updateConfig('parallel', {
        underlyingMode: 'ALL_PARALLEL',
        lastEntryTime: '23:59',
        strongThreshold: 1,
        moderateThreshold: 1,
        minConfidence: 'moderate',
      })

      const user = manager.getOrCreateUser('parallel')
      // One open position in NIFTY keeps the bot ORDERED.
      user.positions['NIFTY 50'] = {
        instrumentKey: 'NSE_FO|CE1',
        direction: 'CE',
        entryPrice: 100,
        quantity: 1,
        entryTime: new Date().toISOString(),
        tradeId: 1,
        executionMode: 'paper',
        tradeType: 'buying',
        currentPrice: 100,
        underlyingSymbol: 'NIFTY 50',
      }
      user.state = 'ORDERED'

      const { snapshot } = buildEntryTick()
      const tick = {
        timestamp: new Date().toISOString(),
        snapshots: {
          'NIFTY 50': snapshot,
          BANKNIFTY: { ...snapshot, underlyingSymbol: 'BANKNIFTY' },
        },
      }
      await (manager as any).handleMarketTick(tick)

      expect(placeSpy).toHaveBeenCalledTimes(1)
      expect(user.positions['NIFTY 50']).not.toBeNull()
      expect(user.positions['BANKNIFTY']).not.toBeNull()
      placeSpy.mockRestore()
    } finally {
      vi.useRealTimers()
    }
  })

  it('enforces the optional global daily cap across symbols (CR-14)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-19T04:30:00.000Z')) // Monday 10:00 IST
    try {
      const ingestor = new MasterIngestionEngine({ mockMode: true })
      const gateway = new OrderGateway()
      const manager = new TenantManager(ingestor, gateway)
      const placeSpy = vi.spyOn(gateway, 'placeOrder')

      manager.startBot('capped', 'paper')
      manager.updateConfig('capped', {
        underlyingMode: 'ALL_PARALLEL',
        lastEntryTime: '23:59',
        maxTotalTradesPerDay: 1,
        strongThreshold: 1,
        moderateThreshold: 1,
        minConfidence: 'moderate',
      })
      const user = manager.getOrCreateUser('capped')
      user.tradesCountToday = 1

      const { tick } = buildEntryTick()
      await (manager as any).handleMarketTick(tick)

      expect(placeSpy).not.toHaveBeenCalled()
      expect(user.positions['NIFTY 50']).toBeNull()
      placeSpy.mockRestore()
    } finally {
      vi.useRealTimers()
    }
  })

  it('surfaces persistence faults, blocks live entries, lets paper continue (CR-15)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-19T04:30:00.000Z')) // Monday 10:00 IST
    const oldArm = process.env[TenantManager.LIVE_ARM_ENV]
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'algo-persist-fault-'))
    const store = new StateStore(dir)
    try {
      const gateway = new OrderGateway()
      const manager = new TenantManager(
        new MasterIngestionEngine({ mockMode: true }),
        gateway,
        { store },
      )
      process.env[TenantManager.LIVE_ARM_ENV] = 'true'

      // A failed critical write is surfaced and blocks a live start.
      const failSave = () => {
        throw new Error('disk full')
      }
      const saveSpy = vi.spyOn(store, 'saveUserState').mockImplementation(failSave)
      expect(() => manager.startBot('live-start', 'live')).toThrow(/persistence fault/)
      expect(manager.getPersistenceFault()).toContain('disk full')
      saveSpy.mockRestore()

      // Paper trading continues while the store is broken.
      manager.startBot('paper-ok', 'paper')
      manager.updateConfig('paper-ok', {
        lastEntryTime: '23:59',
        strongThreshold: 1,
        moderateThreshold: 1,
        minConfidence: 'moderate',
      })
      const paper = manager.getOrCreateUser('paper-ok')
      const placeSpy = vi.spyOn(gateway, 'placeOrder')
      const saveSpy2 = vi.spyOn(store, 'saveUserState').mockImplementation(failSave)

      const { tick } = buildEntryTick()
      await (manager as any).handleMarketTick(tick)
      expect(placeSpy).toHaveBeenCalledTimes(1)
      expect(paper.positions['NIFTY 50']).not.toBeNull()

      // ... but new LIVE entries are blocked while the fault is active.
      const liveUser = manager.getOrCreateUser('live-entry')
      liveUser.executionMode = 'live'
      liveUser.config.executionMode = 'live'
      liveUser.state = 'RUNNING'
      placeSpy.mockClear()
      await (manager as any).handleMarketTick(tick)
      expect(placeSpy).not.toHaveBeenCalled()
      expect(liveUser.positions['NIFTY 50']).toBeNull()

      // Recovery clears the fault once a write succeeds again.
      saveSpy2.mockRestore()
      manager.updateConfig('live-entry', { strongThreshold: 2 })
      expect(manager.getPersistenceFault()).toBeNull()
      placeSpy.mockRestore()
    } finally {
      if (oldArm === undefined) delete process.env[TenantManager.LIVE_ARM_ENV]
      else process.env[TenantManager.LIVE_ARM_ENV] = oldArm
      errorSpy.mockRestore()
      infoSpy.mockRestore()
      store.close()
      vi.useRealTimers()
    }
  })

  it('blocks live entries on a sentiment fault while paper continues (fail-closed VRD)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-19T04:30:00.000Z')) // Monday 10:00 IST
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const gateway = new OrderGateway()
      const manager = new TenantManager(new MasterIngestionEngine({ mockMode: true }), gateway)
      const placeSpy = vi.spyOn(gateway, 'placeOrder')

      // Paper staging continues on the deterministic fallback.
      manager.startBot('paper-vrd', 'paper')
      manager.updateConfig('paper-vrd', {
        underlyingMode: 'NIFTY 50',
        lastEntryTime: '23:59',
        strongThreshold: 1,
        moderateThreshold: 1,
        minConfidence: 'moderate',
      })
      const { snapshot, tick } = buildEntryTick()
      snapshot.sources.sentimentFault = 'India VIX stale'
      await (manager as any).handleMarketTick(tick)
      expect(placeSpy).toHaveBeenCalledTimes(1)

      // ... but LIVE entries are blocked by the same fault (fail-closed).
      const liveUser = manager.getOrCreateUser('live-vrd')
      liveUser.executionMode = 'live'
      liveUser.config.executionMode = 'live'
      liveUser.state = 'RUNNING'
      placeSpy.mockClear()
      await (manager as any).handleMarketTick(tick)
      expect(placeSpy).not.toHaveBeenCalled()
      expect(liveUser.positions['NIFTY 50']).toBeNull()
      expect(warnSpy).toHaveBeenCalled()
      placeSpy.mockRestore()
    } finally {
      warnSpy.mockRestore()
      vi.useRealTimers()
    }
  })

  it('applies the reference VIX hard-stop gate to new entries', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-19T04:30:00.000Z')) // Monday 10:00 IST
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const gateway = new OrderGateway()
      const manager = new TenantManager(new MasterIngestionEngine({ mockMode: true }), gateway)
      const placeSpy = vi.spyOn(gateway, 'placeOrder')

      manager.startBot('vix-block', 'paper')
      manager.updateConfig('vix-block', {
        underlyingMode: 'NIFTY 50',
        lastEntryTime: '23:59',
        strongThreshold: 1,
        moderateThreshold: 1,
        minConfidence: 'moderate',
      })

      const { snapshot, tick } = buildEntryTick()
      ;(snapshot as any).vrdData = {
        mmi: null,
        advancesDeclines: null,
        fiiLongShort: null,
        fiiPositioning: null,
        pcr: null,
        straddleIv: null,
        niftyPe: null,
        vix: 30, // outside the tradeability band — blocks BOTH directions
        giftNifty: null,
        supportWall: null,
        resistanceWall: null,
        maxPain: null,
        fetchedAt: new Date().toISOString(),
      }

      await (manager as any).handleMarketTick(tick)
      expect(placeSpy).not.toHaveBeenCalled()
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Entry blocked'))
      placeSpy.mockRestore()
    } finally {
      warnSpy.mockRestore()
      vi.useRealTimers()
    }
  })

  it('trips the daily loss kill switch and blocks entries for the rest of the day', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-19T04:30:00.000Z')) // Monday 10:00 IST
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const gateway = new OrderGateway()
      const notifier = vi.fn()
      const manager = new TenantManager(
        new MasterIngestionEngine({ mockMode: true }),
        gateway,
        { notifier },
      )
      const placeSpy = vi.spyOn(gateway, 'placeOrder')

      manager.startBot('risk', 'paper')
      manager.updateConfig('risk', {
        underlyingMode: 'NIFTY 50',
        lastEntryTime: '23:59',
        strongThreshold: 1,
        moderateThreshold: 1,
        minConfidence: 'moderate',
        maxDailyLossPct: 10,
      })
      const user = manager.getOrCreateUser('risk')
      user.paperBalance = 10_000_000 // ₹1,00,000 in paise
      user.realizedPnlToday = -10_00_001 // ₹10,000.01 — just past the 10% limit

      const { tick } = buildEntryTick()
      await (manager as any).handleMarketTick(tick)

      expect(user.dayStartEquity).toBe(10_000_000)
      expect(user.dayStartEquitySource).toBe('paper-ledger')
      expect(user.dailyLossTripped).toBe(true)
      expect(user.dailyLossTrippedAt).toBeTruthy()
      expect(user.positions['NIFTY 50']).toBeNull()
      expect(placeSpy).not.toHaveBeenCalled()
      expect(notifier).toHaveBeenCalledTimes(1)
      expect(String(notifier.mock.calls[0][0])).toContain('DAILY LOSS LIMIT')
      placeSpy.mockRestore()
    } finally {
      warnSpy.mockRestore()
      vi.useRealTimers()
    }
  })

  it('allows entries while day P&L is inside the daily loss limit', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-19T04:30:00.000Z')) // Monday 10:00 IST
    try {
      const gateway = new OrderGateway()
      const manager = new TenantManager(new MasterIngestionEngine({ mockMode: true }), gateway)
      const placeSpy = vi.spyOn(gateway, 'placeOrder')

      manager.startBot('inside-limit', 'paper')
      manager.updateConfig('inside-limit', {
        underlyingMode: 'NIFTY 50',
        lastEntryTime: '23:59',
        strongThreshold: 1,
        moderateThreshold: 1,
        minConfidence: 'moderate',
        maxDailyLossPct: 10,
      })
      const user = manager.getOrCreateUser('inside-limit')
      user.paperBalance = 10_000_000
      user.realizedPnlToday = -9_99_999 // −₹9,999.99 — inside the 10% limit

      const { tick } = buildEntryTick()
      await (manager as any).handleMarketTick(tick)

      expect(user.dailyLossTripped).toBe(false)
      expect(placeSpy).toHaveBeenCalledTimes(1)
      expect(user.positions['NIFTY 50']).not.toBeNull()
      placeSpy.mockRestore()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not trip when maxDailyLossPct is unset', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-19T04:30:00.000Z')) // Monday 10:00 IST
    try {
      const gateway = new OrderGateway()
      const manager = new TenantManager(new MasterIngestionEngine({ mockMode: true }), gateway)
      const placeSpy = vi.spyOn(gateway, 'placeOrder')

      manager.startBot('no-cap', 'paper')
      manager.updateConfig('no-cap', {
        underlyingMode: 'NIFTY 50',
        lastEntryTime: '23:59',
        strongThreshold: 1,
        moderateThreshold: 1,
        minConfidence: 'moderate',
      })
      const user = manager.getOrCreateUser('no-cap')
      user.realizedPnlToday = -99_00_000 // a huge loss must not matter when off

      const { tick } = buildEntryTick()
      await (manager as any).handleMarketTick(tick)

      expect(user.dailyLossTripped).toBeFalsy()
      expect(user.dayStartEquity).toBeNull()
      expect(placeSpy).toHaveBeenCalledTimes(1)
      placeSpy.mockRestore()
    } finally {
      vi.useRealTimers()
    }
  })

  it('resets the daily loss kill switch on the next IST day', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-19T04:30:00.000Z')) // Monday 10:00 IST
    try {
      const manager = new TenantManager(
        new MasterIngestionEngine({ mockMode: true }),
        new OrderGateway(),
      )
      const user = manager.getOrCreateUser('rollover')
      user.dailyLossTripped = true
      user.dailyLossTrippedAt = new Date().toISOString()
      user.realizedPnlToday = -5_00_000
      user.dayStartEquity = 10_000_000
      user.tradesCountToday = 4
      user.reentry = {
        'NIFTY 50': {
          lastEntryScore: 13,
          lastEntryDirection: 'CE',
          lastExitNetPnlPaise: -1_000,
          consecutiveLosses: 2,
          pauseUntil: Date.now() + 60_000,
        },
      }
      user.lastTradeDate = '2026-10-18' // previous IST day

      const refreshed = manager.getOrCreateUser('rollover')
      expect(refreshed.dailyLossTripped).toBe(false)
      expect(refreshed.dailyLossTrippedAt).toBeNull()
      expect(refreshed.realizedPnlToday).toBe(0)
      expect(refreshed.dayStartEquity).toBeNull()
      expect(refreshed.dayStartEquitySource).toBeNull()
      expect(refreshed.tradesCountToday).toBe(0)
      expect(refreshed.reentry).toEqual({})
    } finally {
      vi.useRealTimers()
    }
  })

  it('books realized P&L into the daily loss basis on exit', async () => {
    const gateway = new OrderGateway()
    const manager = new TenantManager(new MasterIngestionEngine({ mockMode: true }), gateway)
    manager.startBot('pnl', 'paper')

    const user = manager.getOrCreateUser('pnl')
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

    await manager.manualExit('pnl', 'NIFTY 50', 'test exit')

    // 110 × 0.999 paper slippage = 109.89 → (109.89 − 100) × 65 = ₹642.85
    expect(user.realizedPnlToday).toBe(64_285)
  })

  it('tags the paper-ledger fallback when live equity is unavailable', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const ingestor = new MasterIngestionEngine({ mockMode: true })
      vi.spyOn(ingestor, 'getMasterToken').mockReturnValue(undefined)
      const manager = new TenantManager(ingestor, new OrderGateway())
      const user = manager.getOrCreateUser('live-base')
      user.executionMode = 'live'
      user.config.executionMode = 'live'
      user.config.maxDailyLossPct = 10
      user.paperBalance = 9_500_000

      await (manager as any).updateDailyRisk(user)

      expect(user.dayStartEquity).toBe(9_500_000)
      expect(user.dayStartEquitySource).toBe('paper-fallback')
      expect(user.dailyLossTripped).toBe(false)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('warns and keeps live mode when a live tenant resumes unarmed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'algo-live-arm-'))
    const store = new StateStore(dir)
    const previousArm = process.env.DAEMON_LIVE_ARMED
    process.env.DAEMON_LIVE_ARMED = 'true'
    try {
      const seeded = new TenantManager(
        new MasterIngestionEngine({ mockMode: true }),
        new OrderGateway(),
        { store },
      )
      seeded.startBot('live-resume', 'live')

      delete process.env.DAEMON_LIVE_ARMED
      const activityLog = {
        add: vi.fn(),
        addCoalesced: vi.fn(),
        clearCoalesced: vi.fn(),
      } as any
      const notifier = vi.fn(async () => undefined)
      const resumed = new TenantManager(
        new MasterIngestionEngine({ mockMode: true }),
        new OrderGateway(),
        { store, activityLog, notifier },
      )

      const user = resumed.getOrCreateUser('live-resume')
      expect(user.executionMode).toBe('live')
      expect(resumed.getExecutionModeSummary()).toBe('live')

      const warned = activityLog.add.mock.calls.some(
        (call: any[]) =>
          call[0] === 'warn' &&
          call[1] === 'risk' &&
          String(call[2]).includes('DAEMON_LIVE_ARMED'),
      )
      expect(warned).toBe(true)
      expect(notifier).toHaveBeenCalledWith(
        expect.stringContaining('DAEMON_LIVE_ARMED'),
      )
    } finally {
      if (previousArm === undefined) delete process.env.DAEMON_LIVE_ARMED
      else process.env.DAEMON_LIVE_ARMED = previousArm
      store.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('allows unlimited strong repeats while gating moderate re-entries', () => {
    const manager = new TenantManager(
      new MasterIngestionEngine({ mockMode: true }),
      new OrderGateway(),
    )
    const user = manager.getOrCreateUser('reentry-quality')
    const gate = (
      confidence: FinalSignal['confidence'],
      direction: 'CE' | 'PE',
      score: number,
    ) =>
      (manager as any).describeReentryBlock(
        user,
        'NIFTY 50',
        buildSignal(confidence, direction, score),
      )

    // After a net loss: same score and +1 are stale; +2 or a flip is new info.
    user.reentry = {
      'NIFTY 50': {
        lastEntryScore: 13,
        lastEntryDirection: 'CE',
        lastExitNetPnlPaise: -1_000,
        consecutiveLosses: 1,
      },
    }
    expect(gate('moderate', 'CE', 13)).toBe('no-new-information')
    expect(gate('moderate', 'CE', 14)).toBe('no-new-information')
    expect(gate('moderate', 'CE', 15)).toBeUndefined()
    expect(gate('moderate', 'PE', 13)).toBeUndefined()
    expect(gate('strong', 'CE', 13)).toBeUndefined()

    // After a net win: same or higher is allowed, lower is stale — unless strong.
    user.reentry = {
      'NIFTY 50': {
        lastEntryScore: 13,
        lastEntryDirection: 'CE',
        lastExitNetPnlPaise: 1_000,
        consecutiveLosses: 0,
      },
    }
    expect(gate('moderate', 'CE', 13)).toBeUndefined()
    expect(gate('moderate', 'CE', 12)).toBe('no-new-information')
    expect(gate('strong', 'CE', 12)).toBeUndefined()
  })

  it('pauses moderate entries after two net losses and rests the symbol after three', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-19T04:30:00.000Z')) // Monday 10:00 IST
    try {
      const manager = new TenantManager(
        new MasterIngestionEngine({ mockMode: true }),
        new OrderGateway(),
      )
      const user = manager.getOrCreateUser('loss-ladder')
      const position = {
        instrumentKey: 'NSE_FO|OPT_24000_CE',
        direction: 'CE' as const,
        entryPrice: 100,
        quantity: 65,
        entryTime: new Date().toISOString(),
        tradeId: Date.now(),
        tradeType: 'buying' as const,
        entrySignalScore: 13,
        entrySignalConfidence: 'moderate' as const,
      }
      const gate = (confidence: FinalSignal['confidence'], score: number) =>
        (manager as any).describeReentryBlock(
          user,
          'NIFTY 50',
          buildSignal(confidence, 'CE', score),
        )

      ;(manager as any).recordExitOutcome(user, 'NIFTY 50', position, -1_000)
      expect(user.reentry?.['NIFTY 50']?.consecutiveLosses).toBe(1)
      expect(user.reentry?.['NIFTY 50']?.pauseUntil).toBeUndefined()

      const secondLossAt = Date.now()
      ;(manager as any).recordExitOutcome(user, 'NIFTY 50', position, -1_000)
      expect(user.reentry?.['NIFTY 50']?.consecutiveLosses).toBe(2)
      expect(user.reentry?.['NIFTY 50']?.pauseUntil).toBe(
        secondLossAt + LOSS_PAUSE_MS,
      )
      // The 30-minute pause blocks even an improved moderate signal; strong
      // signals are the only exception.
      expect(gate('moderate', 20)).toBe('loss-pause')
      expect(gate('strong', 20)).toBeUndefined()

      ;(manager as any).recordExitOutcome(user, 'NIFTY 50', position, -1_000)
      expect(user.reentry?.['NIFTY 50']?.consecutiveLosses).toBe(3)
      expect(user.reentry?.['NIFTY 50']?.blockedForDay).toBe(true)
      expect(gate('moderate', 20)).toBe('rest-of-day')
      expect(gate('strong', 20)).toBe('rest-of-day')
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the five-minute all-exit cooldown above the strong exemption', () => {
    const manager = new TenantManager(
      new MasterIngestionEngine({ mockMode: true }),
      new OrderGateway(),
    )
    const user = manager.getOrCreateUser('cooldown-policy')
    user.config.exitCooldownSec = 300
    const { snapshot } = buildEntryTick()
    const strong = buildSignal('strong', 'CE', 17)

    user.lastExitTimes['NIFTY 50'] = Date.now() - 60_000
    expect(
      (manager as any).describeEntryBlock(user, snapshot, true, false, strong),
    ).toBe('cooldown')

    user.lastExitTimes['NIFTY 50'] = Date.now() - 301_000
    expect(
      (manager as any).describeEntryBlock(user, snapshot, true, false, strong),
    ).toBeUndefined()
  })

  it('never raises the pre-registered 8/24 hard caps', () => {
    const manager = new TenantManager(
      new MasterIngestionEngine({ mockMode: true }),
      new OrderGateway(),
    )
    const user = manager.getOrCreateUser('hard-caps')
    user.config.maxTradesPerDay = 99
    user.config.maxTotalTradesPerDay = 99
    const { snapshot } = buildEntryTick()
    const strong = buildSignal('strong', 'CE', 17)

    user.tradesCountToday = 24
    expect(
      (manager as any).describeEntryBlock(user, snapshot, true, false, strong),
    ).toBe('total-cap')

    user.tradesCountToday = 23
    expect(
      (manager as any).describeEntryBlock(user, snapshot, true, false, strong),
    ).toBeUndefined()

    user.tradesCountToday = 0
    user.tradesCountPerSymbol['NIFTY 50'] = 8
    expect(
      (manager as any).describeEntryBlock(user, snapshot, true, false, strong),
    ).toBe('symbol-cap')
  })

  it('records cost-aware net exit P&L and opens the loss ladder', async () => {
    const gateway = new OrderGateway()
    const manager = new TenantManager(
      new MasterIngestionEngine({ mockMode: true }),
      gateway,
    )
    manager.startBot('net-exit', 'paper')
    const user = manager.getOrCreateUser('net-exit')
    user.positions['NIFTY 50'] = {
      instrumentKey: 'NSE_FO|OPT_24000_CE',
      direction: 'CE',
      entryPrice: 100,
      quantity: 65,
      entryTime: new Date().toISOString(),
      tradeId: Date.now(),
      executionMode: 'paper',
      currentPrice: 90,
      tradeType: 'buying',
      underlyingSymbol: 'NIFTY 50',
      entrySignalScore: 13,
      entrySignalConfidence: 'moderate',
    }
    user.state = 'ORDERED'

    await manager.manualExit('net-exit', 'NIFTY 50', 'test exit')

    const state = user.reentry?.['NIFTY 50']
    expect(user.realizedPnlToday).toBeLessThan(0)
    expect(state?.lastExitNetPnlPaise).toBeLessThan(user.realizedPnlToday ?? 0)
    expect(state?.consecutiveLosses).toBe(1)
    expect(state?.lastEntryScore).toBe(13)
    expect(state?.lastEntryDirection).toBe('CE')
  })

  it('lets a strong signal re-enter during the two-loss pause in the tick path', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-19T04:30:00.000Z')) // Monday 10:00 IST
    try {
      const gateway = new OrderGateway()
      const manager = new TenantManager(
        new MasterIngestionEngine({ mockMode: true }),
        gateway,
      )
      const placeSpy = vi.spyOn(gateway, 'placeOrder')

      manager.startBot('strong-pause', 'paper')
      manager.updateConfig('strong-pause', {
        underlyingMode: 'NIFTY 50',
        lastEntryTime: '23:59',
        strongThreshold: 1,
        moderateThreshold: 1,
        minConfidence: 'moderate',
        maxTradesPerDay: 8,
        maxTotalTradesPerDay: 24,
        exitCooldownSec: 300,
      })
      const user = manager.getOrCreateUser('strong-pause')
      user.reentry = {
        'NIFTY 50': {
          lastEntryScore: 13,
          lastEntryDirection: 'CE',
          lastExitNetPnlPaise: -1_000,
          consecutiveLosses: 2,
          pauseUntil: Date.now() + LOSS_PAUSE_MS,
        },
      }

      const { tick } = buildEntryTick()
      await (manager as any).handleMarketTick(tick)

      expect(placeSpy).toHaveBeenCalledTimes(1)
      expect(user.positions['NIFTY 50']).not.toBeNull()
      expect(user.reentry?.['NIFTY 50']?.lastEntryScore).toBeDefined()
      placeSpy.mockRestore()
    } finally {
      vi.useRealTimers()
    }
  })

  it('persists the re-entry guard across daemon restarts', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'algo-reentry-'))
    try {
      const store = new StateStore(dir)
      const manager = new TenantManager(
        new MasterIngestionEngine({ mockMode: true }),
        new OrderGateway(),
        { store },
      )
      const user = manager.getOrCreateUser('restart-guard')
      user.reentry = {
        'NIFTY 50': {
          lastEntryScore: 13,
          lastEntryDirection: 'CE',
          lastExitNetPnlPaise: -1_000,
          consecutiveLosses: 2,
          pauseUntil: Date.now() + LOSS_PAUSE_MS,
          blockedForDay: false,
        },
      }
      manager.updateConfig('restart-guard', { exitCooldownSec: 300 })
      store.close()

      const reloadedStore = new StateStore(dir)
      const reloaded = new TenantManager(
        new MasterIngestionEngine({ mockMode: true }),
        new OrderGateway(),
        { store: reloadedStore },
      ).getOrCreateUser('restart-guard')
      expect(reloaded.reentry?.['NIFTY 50']).toMatchObject({
        lastEntryScore: 13,
        lastEntryDirection: 'CE',
        lastExitNetPnlPaise: -1_000,
        consecutiveLosses: 2,
      })
      expect(reloaded.reentry?.['NIFTY 50']?.pauseUntil).toBeGreaterThan(
        Date.now(),
      )
      reloadedStore.close()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
