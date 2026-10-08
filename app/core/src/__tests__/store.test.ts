import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync, mkdirSync, rmSync, existsSync } from 'fs'
// readFileSync is imported for potential future use in store tests
void readFileSync
import { join } from 'path'
import { loadState, saveState, appendRecord, loadRecords } from '../utils/store'

const TEST_DIR = join(process.cwd(), 'data-test')

describe('file store persistence', () => {
  beforeEach(() => {
    process.env.DATA_DIR = TEST_DIR
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true })
    mkdirSync(TEST_DIR, { recursive: true })
  })

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true })
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
