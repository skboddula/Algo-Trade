import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, writeFileSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { loadState, saveState, appendRecord, loadRecords } from '../utils/store'

let TEST_DIR: string

describe('file store persistence', () => {
  beforeEach(() => {
    // Unique temp dir per test — a fixed in-repo path raced with parallel
    // vitest workers sharing process.env.DATA_DIR (rmSync hit ENOTEMPTY
    // when another worker's write landed mid-cleanup).
    process.env.DATA_DIR = TEST_DIR = mkdtempSync(join(tmpdir(), 'store-test-'))
  })

  afterEach(() => {
    if (TEST_DIR && existsSync(TEST_DIR))
      rmSync(TEST_DIR, { recursive: true, force: true })
    delete process.env.DATA_DIR
  })

  it('saves and loads a JSON state', () => {
    const data = { balance: 100000, state: 'RUNNING', positions: { NIFTY: null } }
    saveState('test_state', data)
    const loaded = loadState<typeof data>('test_state')
    expect(loaded).toEqual(data)
  })

  it('returns null for missing state', () => {
    expect(loadState('nonexistent')).toBeNull()
  })

  it('appends and loads JSONL records', () => {
    const trade1 = { id: 't1', symbol: 'NIFTY', pnl: 100 }
    const trade2 = { id: 't2', symbol: 'BANKNIFTY', pnl: -50 }
    appendRecord('test_trades', trade1)
    appendRecord('test_trades', trade2)
    const loaded = loadRecords<typeof trade1>('test_trades')
    expect(loaded).toHaveLength(2)
    expect(loaded[0]).toEqual(trade1)
    expect(loaded[1]).toEqual(trade2)
  })

  it('returns empty array for missing records', () => {
    expect(loadRecords('nonexistent')).toEqual([])
  })

  it('migrates legacy JSON files to SQLite on first open', () => {
    // Seed legacy-era files exactly as the JSON store left them
    writeFileSync(
      join(TEST_DIR, 'user_states.json'),
      JSON.stringify({
        legacy_user: { userId: 'legacy_user', state: 'STOPPED', positions: {} },
      }),
    )
    const legacyTrade = {
      id: 't_legacy',
      accountId: 'paper_acc_legacy_user',
      status: 'CLOSED',
      instrumentKey: 'NSE_FO|1',
      direction: 'CE',
      quantity: 50,
      entryPrice: 10000,
      entryValue: 500000,
      exitPrice: 10500,
      exitValue: 525000,
      realizedPnl: 25000,
      openedAt: '2026-10-01T04:00:00.000Z',
      closedAt: '2026-10-01T05:00:00.000Z',
    }
    writeFileSync(
      join(TEST_DIR, 'paper_trades.json'),
      JSON.stringify(legacyTrade) + '\n',
    )

    const loaded = loadState<{ legacy_user: { userId: string } }>(
      'user_states',
    )
    expect(loaded?.legacy_user?.userId).toBe('legacy_user')

    const trades = loadRecords<{
      id: string
      entryPrice: number
    }>('paper_trades')
    expect(trades).toHaveLength(1)
    expect(trades[0].id).toBe('t_legacy')
    expect(trades[0].entryPrice).toBe(10000)

    // Legacy files are renamed (kept as rollback copies), not deleted
    const entries = readdirSync(TEST_DIR)
    expect(
      entries.some((f) => f.startsWith('user_states.json.migrated-')),
    ).toBe(true)
    expect(
      entries.some((f) => f.startsWith('paper_trades.json.migrated-')),
    ).toBe(true)
  })

  it('overwrites state on re-save', () => {
    saveState('test_overwrite', { version: 1 })
    saveState('test_overwrite', { version: 2 })
    const loaded = loadState<{ version: number }>('test_overwrite')
    expect(loaded?.version).toBe(2)
  })
})
