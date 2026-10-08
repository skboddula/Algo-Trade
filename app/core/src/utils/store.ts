/**
 * File-based persistence store for the daemon.
 *
 * Persists state to JSON files on disk so positions, paper accounts,
 * trade history, and bot configuration survive daemon restarts.
 *
 * Design:
 * - Single JSON file per concern (accounts, trades, user states)
 * - Debounced writes to avoid excessive disk I/O on every tick
 * - Atomic writes (write temp file, then rename) to prevent corruption
 * - Data directory configurable via DATA_DIR env var (default: ./data)
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'

const DEFAULT_DATA_DIR = join(process.cwd(), 'data')

function getDataDir(): string {
  const dir = process.env.DATA_DIR || DEFAULT_DATA_DIR
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

function getFilePath(name: string): string {
  return join(getDataDir(), `${name}.json`)
}

/**
 * Loads a JSON file, returning the parsed content or null if not found.
 */
export function loadState<T>(name: string): T | null {
  try {
    const path = getFilePath(name)
    if (!existsSync(path)) return null
    const raw = readFileSync(path, 'utf-8')
    return JSON.parse(raw) as T
  } catch (error) {
    console.warn(`[store] Failed to load ${name}:`, (error as Error).message)
    return null
  }
}

/**
 * Saves data to a JSON file atomically (write temp, then rename).
 */
export function saveState<T>(name: string, data: T): void {
  try {
    const path = getFilePath(name)
    const tmpPath = `${path}.tmp`
    writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8')
    renameSync(tmpPath, path)
  } catch (error) {
    console.error(`[store] Failed to save ${name}:`, (error as Error).message)
  }
}

/**
 * Appends a record to a JSONL (JSON Lines) file — each line is one JSON object.
 * Suitable for append-only logs like trade history.
 */
export function appendRecord<T>(name: string, record: T): void {
  try {
    const path = getFilePath(name)
    const line = JSON.stringify(record) + '\n'
    // Using appendFileSync via a stream would be better for high-volume,
    // but for 10-50 trades per day this is perfectly fine.
    const { appendFileSync } = require('fs') as typeof import('fs')
    appendFileSync(path, line, 'utf-8')
  } catch (error) {
    console.error(`[store] Failed to append to ${name}:`, (error as Error).message)
  }
}

/**
 * Loads all records from a JSONL file.
 */
export function loadRecords<T>(name: string): T[] {
  try {
    const path = getFilePath(name)
    if (!existsSync(path)) return []
    const raw = readFileSync(path, 'utf-8')
    return raw
      .trim()
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as T)
  } catch (error) {
    console.warn(`[store] Failed to load records from ${name}:`, (error as Error).message)
    return []
  }
}
