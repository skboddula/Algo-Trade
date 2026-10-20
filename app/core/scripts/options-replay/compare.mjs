#!/usr/bin/env node
/**
 * Compares two or more options-replay report directories.
 *
 * Usage:
 *   node scripts/options-replay/compare.mjs \
 *     "Production filter on=data/replay/reports/filter-on-slip10" \
 *     "Production filter off=data/replay/reports/filter-off-slip10" \
 *     "No-trail filter on=data/replay/reports/filter-on-notrail" \
 *     --baseline="Production filter on" \
 *     --out=data/replay/reports/comparison.md
 *
 * Each directory must contain `summary.json` and `daily.csv` written by
 * `scripts/options-replay.ts`. The paired table uses daily net P&L, so all
 * arms should cover the same date range.
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

function readArm(arm) {
  const summaryPath = path.join(arm.dir, 'summary.json')
  const dailyPath = path.join(arm.dir, 'daily.csv')
  if (!fs.existsSync(summaryPath) || !fs.existsSync(dailyPath)) {
    throw new Error(`Missing summary.json/daily.csv in ${arm.dir}`)
  }
  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'))
  const daily = new Map()
  const lines = fs.readFileSync(dailyPath, 'utf8').trim().split('\n')
  const header = lines[0].split(',')
  const dateIndex = header.indexOf('date')
  const netIndex = header.indexOf('net_pnl')
  if (dateIndex === -1 || netIndex === -1) {
    throw new Error(`daily.csv in ${arm.dir} is missing date/net_pnl columns`)
  }
  for (const line of lines.slice(1)) {
    const cells = line.split(',')
    const date = cells[dateIndex]
    const netPnl = cells[netIndex]
    if (!date || netPnl === undefined || netPnl === '') continue
    daily.set(date, Number(netPnl))
  }
  return { ...arm, summary, daily }
}

function formatInr(value) {
  const number = Number(value)
  const sign = number < 0 ? '-' : ''
  return `${sign}₹${Math.abs(number).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function quantile(sorted, probability) {
  const index = (sorted.length - 1) * probability
  const lower = Math.floor(index)
  const upper = Math.ceil(index)
  if (lower === upper) return sorted[lower]
  const weight = index - lower
  return sorted[lower] * (1 - weight) + sorted[upper] * weight
}

function bootstrapMean(values, samples = 20_000) {
  // Deterministic PRNG so the comparison is reproducible.
  let state = 0x9e3779b9
  const random = () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 0x100000000
  }
  const means = []
  for (let sample = 0; sample < samples; sample += 1) {
    let total = 0
    for (let index = 0; index < values.length; index += 1) {
      total += values[Math.floor(random() * values.length)]
    }
    means.push(total / values.length)
  }
  means.sort((left, right) => left - right)
  return {
    mean: mean(values),
    low: quantile(means, 0.025),
    high: quantile(means, 0.975),
  }
}

function table(arms) {
  const header =
    '| Arm | Trades | Win rate | Gross P&L | Charges | Slippage | Net P&L | Return | Max DD | Profit factor | Avg hold |'
  const divider =
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|'
  const rows = arms.map((arm) => {
    const metrics = arm.summary.metrics
    return `| ${arm.label} | ${metrics.totalTrades} | ${metrics.winRatePct.toFixed(
      1,
    )}% | ${formatInr(metrics.grossPnl)} | ${formatInr(
      metrics.totalCharges,
    )} | ${formatInr(metrics.slippageCost)} | ${formatInr(
      metrics.netPnl,
    )} | ${metrics.returnPct.toFixed(2)}% | ${metrics.maxDrawdownPct.toFixed(
      2,
    )}% | ${metrics.profitFactor == null ? 'n/a' : metrics.profitFactor.toFixed(3)} | ${metrics.avgHoldMinutes.toFixed(1)} min |`
  })
  return [header, divider, ...rows].join('\n')
}

function pairedTable(arms, baseline) {
  const dates = [...baseline.daily.keys()].filter((date) =>
    arms.every((arm) => arm.daily.has(date)),
  )
  const rows = arms
    .filter((arm) => arm !== baseline)
    .map((arm) => {
      const differences = dates.map(
        (date) => arm.daily.get(date) - baseline.daily.get(date),
      )
      const stats = bootstrapMean(differences)
      const better = differences.filter((value) => value > 0).length
      const worse = differences.filter((value) => value < 0).length
      return `| ${arm.label} vs ${baseline.label} | ${formatInr(
        stats.mean,
      )} | ${formatInr(stats.low)} .. ${formatInr(
        stats.high,
      )} | ${better} | ${worse} |`
    })
  if (!rows.length) return ''
  return `\n## Paired daily difference vs baseline\n\nPositive means the arm did better than the baseline on that day. The interval is a deterministic 20,000-resample bootstrap of the mean daily net P&L difference; it is not a guarantee and ignores regime clustering.\n\n| Comparison | Mean diff/day | 95% bootstrap CI | Better days | Worse days |\n|---|---:|---:|---:|---:|\n${rows.join('\n')}\n`
}

function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2))
  if (!positional.length) {
    console.error(
      'Usage: node scripts/options-replay/compare.mjs "Label=dir" ["Label=dir" ...] [--baseline="Label"] [--out=path]',
    )
    process.exitCode = 1
    return
  }
  const arms = positional.map((value) => readArm(parseArm(value)))
  const baselineLabel = flags.baseline ?? arms[0].label
  const baseline = arms.find((arm) => arm.label === baselineLabel)
  if (!baseline) {
    throw new Error(`Baseline not found: ${baselineLabel}`)
  }
  const first = arms[0].summary
  const output = `# Options replay comparison\n\nWindow: ${first.from} → ${first.to}  \nGenerated: ${new Date().toISOString()}  \nBaseline: ${baseline.label}\n\n${table(
    arms,
  )}\n${pairedTable(arms, baseline)}`
  if (flags.out) {
    fs.mkdirSync(path.dirname(path.resolve(flags.out)), { recursive: true })
    fs.writeFileSync(path.resolve(flags.out), output)
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
