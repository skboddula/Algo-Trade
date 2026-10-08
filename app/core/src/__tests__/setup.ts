/**
 * Vitest global setup — configures the test environment.
 *
 * Points the file-based persistence store to a temporary directory so tests
 * don't pollute or read from the daemon's real data directory.
 */

import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { beforeEach, afterAll } from 'vitest'

const TEST_DATA_DIR = join(process.cwd(), 'data-test')

// Set the data directory before any store operations
process.env.DATA_DIR = TEST_DATA_DIR

// Clean the test data directory before each test file
beforeEach(() => {
  if (require('fs').existsSync(TEST_DATA_DIR)) {
    rmSync(TEST_DATA_DIR, { recursive: true })
  }
  mkdirSync(TEST_DATA_DIR, { recursive: true })
})

// Clean up after all tests
afterAll(() => {
  if (require('fs').existsSync(TEST_DATA_DIR)) {
    rmSync(TEST_DATA_DIR, { recursive: true })
  }
})
