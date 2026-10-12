import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'fs'
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

  it('overwrites state on re-save', () => {
    saveState('test_overwrite', { version: 1 })
    saveState('test_overwrite', { version: 2 })
    const loaded = loadState<{ version: number }>('test_overwrite')
    expect(loaded?.version).toBe(2)
  })
})
