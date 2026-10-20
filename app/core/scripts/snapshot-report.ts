import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { getFinalSignal } from '../../../packages/strategy-engine/src'

/**
 * Signal-snapshot report for one IST day.
 *
 * Usage (from anywhere):
 *   cd app/core
 *   npx tsx scripts/snapshot-report.ts 2026-10-21 default_user
 *
 * The table is append-only telemetry; rows start at the daemon deploy that
 * introduced signal_snapshots. Earlier dates are not backfilled.
 */

const dbPath = path.resolve(__dirname, '../data/algo-trade.sqlite')

const date =
  process.argv[2] ??
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(
    new Date(),
  )
const userId = process.argv[3] ?? 'default_user'

type Row = {
  id: number
  symbol: string
  captured_at: string
  filter_verdict: string
  blocked_reason: string | null
  order_placed: number
  trade_id: string | null
  entry_price: number | null
  data_json: string
  config_json: string
}

const db = new DatabaseSync(dbPath, { readOnly: true })
const rows = db
  .prepare(
    `SELECT id, symbol, captured_at, filter_verdict, blocked_reason,
            order_placed, trade_id, entry_price, data_json, config_json
     FROM signal_snapshots
     WHERE user_id = ? AND ist_date = ?
     ORDER BY id`,
  )
  .all(userId, date) as Row[]
db.close()

const actionable = (signal: string) =>
  signal === 'BUY_CE' || signal === 'BUY_PE'

let onActionable = 0
let offActionable = 0
let vetoed = 0
let actualOrders = 0
let parseErrors = 0

const bySymbol = new Map<
  string,
  { rows: number; on: number; off: number; vetoed: number; orders: number }
>()

for (const row of rows) {
  let data: Parameters<typeof getFinalSignal>[0]
  let config: Parameters<typeof getFinalSignal>[1]
  try {
    data = JSON.parse(row.data_json)
    config = JSON.parse(row.config_json)
  } catch {
    parseErrors++
    continue
  }

  const on = getFinalSignal(data, { ...config, useMultiTimeframe: true })
  const off = getFinalSignal(data, { ...config, useMultiTimeframe: false })
  const entry = bySymbol.get(row.symbol) ?? {
    rows: 0,
    on: 0,
    off: 0,
    vetoed: 0,
    orders: 0,
  }
  entry.rows++
  if (actionable(on.signal)) {
    onActionable++
    entry.on++
  }
  if (actionable(off.signal)) {
    offActionable++
    entry.off++
  }
  if (row.filter_verdict === 'vetoed') {
    vetoed++
    entry.vetoed++
  }
  if (row.order_placed) {
    actualOrders++
    entry.orders++
  }
  bySymbol.set(row.symbol, entry)
}

const summary = {
  date,
  userId,
  dbPath,
  candidateRows: rows.length,
  onActionableRows: onActionable,
  offActionableRows: offActionable,
  vetoedRows: vetoed,
  actualOrders,
  parseErrors,
  bySymbol: Object.fromEntries(bySymbol),
}

console.log(JSON.stringify(summary, null, 2))

if (rows.length === 0) {
  console.log(
    '\nNo snapshot rows for this date. signal_snapshots starts at the deploy that introduced it; earlier dates are not backfilled.',
  )
}
