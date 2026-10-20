#!/usr/bin/env node
/**
 * Builds a calibration/validation table from options-replay report directories.
 *
 * Usage:
 *   node scripts/options-replay/calibrate.mjs \
 *     "Trail 5%=data/replay/reports/filter-on-slip10" \
 *     "No trail=data/replay/reports/filter-on-notrail" \
 *     --split=2026-04-01 \
 *     --out=data/replay/reports/calibration.md
 *
 * By default only the calibration window is shown. Pass `--validation` only
 * after the candidate set has been selected, so validation data does not leak
 * into the selection decision.
 *
 * Each directory must contain `trades.csv`, `daily.csv` and `summary.json`
 * written by `scripts/options-replay.ts`.
 */
import fs from 'node:fs'
import path from 'node:path'

function parseArgs(argv) {
  const positional = []
  const flags = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) {
      positional.push(token)
      continue
    }
    const equals = token.indexOf('=')
    if (equals !== -1) {
      flags[token.slice(2, equals)] = token.slice(equals + 1)
      continue
    }
    const key = token.slice(2)
    const next = argv[index + 1]
    if (!next || next.startsWith('--')) {
      flags[key] = 'true'
      continue
    }
    flags[key] = next
    index += 1
  }
  return { positional, flags }
}

function parseArm(value) {
  const separator = value.indexOf('=')
  if (separator === -1) {
    return { label: path.basename(value), dir: value }
  }
  return {
    label: value.slice(0, separator),
    dir: value.slice(separator + 1),
  }
}

function readCsv(file) {
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n')
  if (!lines.length) return []
  const header = lines[0].split(',')
  const rows = []
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue
    const cells = line.split(',')
    const row = {}
    for (let index = 0; index < header.length; index += 1) {
      row[header[index]] = cells[index] ?? ''
    }
    rows.push(row)
  }
  return rows
}

function readArm(arm) {
  const summaryPath = path.join(arm.dir, 'summary.json')
  const tradesPath = path.join(arm.dir, 'trades.csv')
  const dailyPath = path.join(arm.dir, 'daily.csv')
  for (const file of [summaryPath, tradesPath, dailyPath]) {
    if (!fs.existsSync(file)) {
      throw new Error(`Missing ${file}`)
    }
  }
  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'))
  const trades = readCsv(tradesPath).map((row) => ({
    date: row.date,
    netPnl: Number(row.net_pnl),
    grossPnl: Number(row.gross_pnl),
    totalCharges: Number(row.total_charges),
    holdMinutes: Number(row.hold_minutes),
  }))
  const daily = readCsv(dailyPath)
    .map((row) => ({
      date: row.date,
      netPnl: Number(row.net_pnl),
    }))
    .sort((left, right) => left.date.localeCompare(right.date))
  return { ...arm, summary, trades, daily }
}

function formatInr(value) {
  const number = Number(value)
  const sign = number < 0 ? '-' : ''
  return `${sign}₹${Math.abs(number).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

function summarize(trades, daily, from, to, initialCapital) {
  const selectedTrades = trades.filter(
    (trade) => trade.date >= from && trade.date < to,
  )
  const selectedDays = daily.filter((day) => day.date >= from && day.date < to)
  const wins = selectedTrades.filter((trade) => trade.netPnl > 0)
  const losses = selectedTrades.filter((trade) => trade.netPnl < 0)
  const winNet = wins.reduce((sum, trade) => sum + trade.netPnl, 0)
  const lossNet = Math.abs(losses.reduce((sum, trade) => sum + trade.netPnl, 0))
  const netPnl = selectedTrades.reduce((sum, trade) => sum + trade.netPnl, 0)
  const grossPnl = selectedTrades.reduce((sum, trade) => sum + trade.grossPnl, 0)
  const totalCharges = selectedTrades.reduce(
    (sum, trade) => sum + trade.totalCharges,
    0,
  )
  const avgHold =
    selectedTrades.length > 0
      ? selectedTrades.reduce((sum, trade) => sum + trade.holdMinutes, 0) /
        selectedTrades.length
      : 0

  let equity = initialCapital
  let peak = initialCapital
  let maxDrawdown = 0
  let maxDrawdownPct = 0
  for (const day of selectedDays) {
    equity += day.netPnl
    peak = Math.max(peak, equity)
    const drawdown = peak - equity
    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown
      maxDrawdownPct = peak > 0 ? (drawdown / peak) * 100 : 0
    }
  }

  return {
    trades: selectedTrades.length,
    wins: wins.length,
    losses: losses.length,
    winRatePct: selectedTrades.length
      ? (wins.length / selectedTrades.length) * 100
      : 0,
    netPnl,
    grossPnl,
    totalCharges,
    profitFactor: lossNet > 0 ? winNet / lossNet : null,
    expectancy: selectedTrades.length ? netPnl / selectedTrades.length : 0,
    avgWin: wins.length ? winNet / wins.length : 0,
    avgLoss: losses.length
      ? losses.reduce((sum, trade) => sum + trade.netPnl, 0) / losses.length
      : 0,
    maxDrawdown,
    maxDrawdownPct,
    avgHold,
  }
}

function metricCells(stats) {
  return [
    String(stats.trades),
    `${stats.winRatePct.toFixed(1)}%`,
    formatInr(stats.netPnl),
    stats.profitFactor == null ? 'n/a' : stats.profitFactor.toFixed(3),
    `${stats.maxDrawdownPct.toFixed(2)}%`,
    formatInr(stats.expectancy),
    `${stats.avgHold.toFixed(1)} min`,
  ]
}

function monthBreakdown(trades, from, to) {
  const months = new Map()
  for (const trade of trades) {
    if (trade.date < from || trade.date >= to) continue
    const month = trade.date.slice(0, 7)
    months.set(month, (months.get(month) ?? 0) + trade.netPnl)
  }
  const names = [...months.keys()].sort()
  return names.map((name) => `${name}: ${formatInr(months.get(name))}`).join('<br>')
}

function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2))
  if (!positional.length) {
    console.error(
      'Usage: node scripts/options-replay/calibrate.mjs "Label=dir" ["Label=dir" ...] [--split=YYYY-MM-DD] [--validation] [--out=path] [--top=N]',
    )
    process.exitCode = 1
    return
  }

  const split = flags.split ?? '2026-04-01'
  const showValidation = flags.validation === 'true' || flags.validation === true
  const top = flags.top ? Number(flags.top) : 0
  const arms = positional.map((value) => readArm(parseArm(value)))
  const first = arms[0].summary
  const initialCapital = Number(
    flags.capital ?? first.options?.initialCapital ?? 100_000,
  )

  for (const arm of arms) {
    if (arm.summary.from !== first.from || arm.summary.to !== first.to) {
      throw new Error(
        `Window mismatch for ${arm.label}: ${arm.summary.from}..${arm.summary.to} vs ${first.from}..${first.to}`,
      )
    }
  }

  for (const arm of arms) {
    arm.calibration = summarize(
      arm.trades,
      arm.daily,
      first.from,
      split,
      initialCapital,
    )
    arm.validation = summarize(
      arm.trades,
      arm.daily,
      split,
      '9999-12-31',
      initialCapital,
    )
  }

  arms.sort(
    (left, right) =>
      right.calibration.netPnl - left.calibration.netPnl ||
      left.label.localeCompare(right.label),
  )
  const shown = top > 0 ? arms.slice(0, top) : arms

  const header = [
    'Arm',
    'Cal trades',
    'Cal win',
    'Cal net',
    'Cal PF',
    'Cal DD',
    'Cal expectancy',
    'Cal hold',
    ...(showValidation
      ? [
          'Val trades',
          'Val win',
          'Val net',
          'Val PF',
          'Val DD',
          'Val expectancy',
          'Val hold',
        ]
      : []),
  ]
  const divider = `|---${'|---:'.repeat(header.length - 1)}|`
  const rows = shown.map((arm) => {
    const cells = [
      arm.label,
      ...metricCells(arm.calibration),
      ...(showValidation ? metricCells(arm.validation) : []),
    ]
    return `| ${cells.join(' | ')} |`
  })

  const lines = [
    '# Options replay calibration split',
    '',
    `Window: ${first.from} → ${first.to}  `,
    `Calibration: ${first.from} → before ${split}  `,
    `Validation: ${split} → ${first.to}  `,
    `Generated: ${new Date().toISOString()}  `,
    `Cost mode: ${first.options?.costModel ?? 'unknown'}; slippage: ${first.options?.slippageBps ?? '?'} bps`,
    '',
    'Selection must use only the calibration columns. Validation is shown only after the candidate set is frozen.',
    '',
    `| ${header.join(' | ')} |`,
    divider,
    ...rows,
    '',
    '## Calibration monthly net',
    '',
    '| Arm | Months |',
    '|---|---|',
    ...shown.map(
      (arm) =>
        `| ${arm.label} | ${monthBreakdown(
          arm.trades,
          first.from,
          split,
        )} |`,
    ),
    ...(showValidation
      ? [
          '',
          '## Validation monthly net',
          '',
          '| Arm | Months |',
          '|---|---|',
          ...shown.map(
            (arm) =>
              `| ${arm.label} | ${monthBreakdown(
                arm.trades,
                split,
                '9999-12-31',
              )} |`,
          ),
        ]
      : []),
  ]

  const output = lines.join('\n')
  if (flags.out) {
    fs.mkdirSync(path.dirname(path.resolve(flags.out)), { recursive: true })
    fs.writeFileSync(path.resolve(flags.out), `${output}\n`)
    console.log(`Wrote ${path.resolve(flags.out)}`)
  } else {
    console.log(output)
  }
}

try {
  main()
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : error)
  process.exitCode = 1
}
