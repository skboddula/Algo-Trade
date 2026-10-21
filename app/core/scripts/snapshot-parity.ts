import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  compareSnapshotArms,
  type ArmParity,
  type SnapshotArm,
  type SnapshotParityRow,
} from '../src/backtest/snapshotParity'

/**
 * Exact snapshot replay — arm-parity check for one IST day.
 *
 * Usage (from anywhere):
 *   cd app/core
 *   npx tsx scripts/snapshot-parity.ts 2026-10-21 default_user [--all]
 *
 * Re-runs the production scoring from every stored `data_json`/`config_json`
 * and diffs it against the stored user / unfiltered / default arms. Exit code
 * is non-zero when any row mismatches: every later replay layer (entry gates,
 * cost-aware fills, re-entry policy) depends on this table replaying exactly.
 *
 * Parity is only meaningful against the same scoring build that captured the
 * rows. The table has no engine-version column, so after a scoring change old
 * rows will report mismatches until re-derived.
 */

const dbPath = path.resolve(__dirname, '../data/algo-trade.sqlite')

const args = process.argv.slice(2)
const printAll = args.includes('--all')
const positional = args.filter((arg) => !arg.startsWith('--'))

const date =
  positional[0] ??
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(
    new Date(),
  )
const userId = positional[1] ?? 'default_user'

const MAX_PRINTED_MISMATCHES = 20

type Row = {
  id: number
  symbol: string
  captured_at: string
  data_json: string
  config_json: string
  user_signal_json: string
  unfiltered_signal_json: string
  default_signal_json: string | null
}

const db = new DatabaseSync(dbPath, { readOnly: true })
const raw = db
  .prepare(
    `SELECT id, symbol, captured_at, data_json, config_json,
            user_signal_json, unfiltered_signal_json, default_signal_json
     FROM signal_snapshots
     WHERE user_id = ? AND ist_date = ?
     ORDER BY id`,
  )
  .all(userId, date) as Row[]
db.close()

const rows: SnapshotParityRow[] = raw.map((row) => ({
  id: row.id,
  symbol: row.symbol,
  capturedAt: row.captured_at,
  dataJson: row.data_json,
  configJson: row.config_json,
  userSignalJson: row.user_signal_json,
  unfilteredSignalJson: row.unfiltered_signal_json,
  defaultSignalJson: row.default_signal_json,
}))

type ArmTally = { match: number; mismatch: number; 'stored-missing': number }

const arms: Record<SnapshotArm, ArmTally> = {
  user: { match: 0, mismatch: 0, 'stored-missing': 0 },
  unfiltered: { match: 0, mismatch: 0, 'stored-missing': 0 },
  default: { match: 0, mismatch: 0, 'stored-missing': 0 },
}
let parseErrors = 0
const mismatchedRows: Array<{
  id: number
  symbol: string
  capturedAt: string
  arms: ArmParity[]
}> = []

for (const row of rows) {
  const parity = compareSnapshotArms(row)
  if (parity.parseError) {
    parseErrors++
    continue
  }
  for (const arm of parity.arms) {
    arms[arm.arm][arm.status]++
  }
  if (parity.arms.some((arm) => arm.status === 'mismatch')) {
    mismatchedRows.push({
      id: parity.id,
      symbol: parity.symbol,
      capturedAt: parity.capturedAt,
      arms: parity.arms.filter((arm) => arm.status === 'mismatch'),
    })
  }
}

const totalArmComparisons = (Object.keys(arms) as SnapshotArm[]).reduce(
  (sum, arm) => sum + arms[arm].match + arms[arm].mismatch,
  0,
)
const storedMissing = (Object.keys(arms) as SnapshotArm[]).reduce(
  (sum, arm) => sum + arms[arm]['stored-missing'],
  0,
)
const printed = printAll
  ? mismatchedRows
  : mismatchedRows.slice(0, MAX_PRINTED_MISMATCHES)

const summary = {
  date,
  userId,
  dbPath,
  rows: rows.length,
  parseErrors,
  arms,
  totalArmComparisons,
  storedMissing,
  mismatchedRowCount: mismatchedRows.length,
  mismatchesTruncated: printed.length < mismatchedRows.length,
  mismatches: printed,
}

console.log(JSON.stringify(summary, null, 2))

const failed = parseErrors > 0 || mismatchedRows.length > 0
if (failed) {
  console.log(
    `\nPARITY FAILED — ${mismatchedRows.length} mismatched row(s), ` +
      `${parseErrors} parse error(s). Do not build replay layers on this ` +
      'table until parity is restored (same scoring build as capture).',
  )
  process.exitCode = 1
} else {
  console.log(
    `\nOK: ${rows.length} row(s) replay bit-for-bit — ` +
      `${totalArmComparisons} arm comparisons, 0 mismatches` +
      (storedMissing > 0 ? `, ${storedMissing} stored-missing arm(s)` : '') +
      '.',
  )
}
