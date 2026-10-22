import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_CONFIG } from '../../../packages/shared/src/types'
import type { StrategyConfig } from '../../../packages/shared/src/types'
import { HfNiftyDataset } from '../src/backtest/data/hfDataset'
import { emptyMacroFile, MacroSeries } from '../src/backtest/data/macro'
import { runReplay } from '../src/backtest/engine'
import { printReplaySummary, writeReplayReport } from '../src/backtest/report'

interface CliArgs {
  [key: string]: string | undefined
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const equals = token.indexOf('=')
    if (equals !== -1) {
      args[token.slice(2, equals)] = token.slice(equals + 1)
      continue
    }
    const key = token.slice(2)
    const next = argv[index + 1]
    if (!next || next.startsWith('--')) {
      args[key] = 'true'
      continue
    }
    args[key] = next
    index += 1
  }
  return args
}

function numberArg(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function loadStrategy(configPath: string): StrategyConfig {
  if (!fs.existsSync(configPath)) {
    console.warn(`Config not found at ${configPath}; using DEFAULT_CONFIG`)
    return { ...DEFAULT_CONFIG, underlyingMode: 'NIFTY 50', executionMode: 'paper' }
  }
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as
    | Partial<StrategyConfig>
    | { strategy?: Partial<StrategyConfig> }
  const overrides =
    'strategy' in raw && raw.strategy ? raw.strategy : (raw as Partial<StrategyConfig>)
  return {
    ...DEFAULT_CONFIG,
    underlyingMode: 'NIFTY 50',
    executionMode: 'paper',
    tradeType: 'buying',
    ...overrides,
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.help === 'true') {
    console.log(`NIFTY cost-aware options replay

Usage:
  npx tsx scripts/options-replay.ts [options]

Options:
  --from YYYY-MM-DD            First replay date (default 2026-01-01)
  --to YYYY-MM-DD              Last replay date (default 2026-05-22)
  --data-dir PATH              HF dataset + macro.json directory
                               (default data/replay/hf-nifty-1m)
  --config PATH                Strategy JSON (default scripts/options-replay/configs/production-2026.json)
  --out PATH                   Report directory (default data/replay/reports/<label>)
  --label TEXT                 Run label
  --filter on|off              Override useMultiTimeframe (default from config)
  --slippage-bps N             Per-side slippage (default 10)
  --otm-skip N                 Strike steps from ATM (default from config)
  --trail-pct N                Trailing stop % (0 disables; default from config)
  --max-profit-pct N           Target % (default from config)
  --max-loss-pct N             Stop % (default from config)
  --max-trades-per-day N       Per-symbol daily cap
  --max-total-trades-per-day N Total daily cap
  --max-daily-loss-pct N       Stop new entries after this daily loss
  --exit-cooldown-sec N        Re-entry cooldown after an exit
  --last-entry-time HH:MM      Entry cutoff
  --first-entry-time HH:MM     No entries before this time (warm-up; default 09:15)
  --max-entry-premium-move-pct N
                               Skip a buying entry when the next bar opens more
                               than N% above the signal-bar close (default off)
  --square-off-time HH:MM      EOD square-off
  --capital N                  Initial capital (default 100000)
  --lots N                     Lots per trade (default 1)
  --lot-size N                 Contract lot size (default 75 for NIFTY 2026)
  --cost-model statutory|paper-parity
  --max-entry-delay N          Bars after signal allowed for entry (default 1)
  --peak-source close|high     Trailing-stop peak source (default close)
  --max-strike-distance-pct N  Data-gap guard (default 3)
  --min-bars N                 Minimum spot bars per session (default 100)
`)
    return
  }

  const from = args.from ?? '2026-01-01'
  const to = args.to ?? '2026-05-22'
  const dataDir = path.resolve(
    process.cwd(),
    args['data-dir'] ?? 'data/replay/hf-nifty-1m',
  )
  const configPath = path.resolve(
    process.cwd(),
    args.config ?? 'scripts/options-replay/configs/production-2026.json',
  )
  const strategy = loadStrategy(configPath)
  if (args.filter === 'on') strategy.useMultiTimeframe = true
  if (args.filter === 'off') strategy.useMultiTimeframe = false
  if (args['otm-skip'] !== undefined) {
    strategy.otmSkip = Math.max(0, Math.trunc(numberArg(args['otm-skip'], strategy.otmSkip)))
  }
  if (args['trail-pct'] !== undefined) {
    strategy.trailPct = Math.max(0, numberArg(args['trail-pct'], strategy.trailPct ?? 5))
  }
  if (args['max-profit-pct'] !== undefined) {
    strategy.maxProfitPct = Math.max(
      0.1,
      numberArg(args['max-profit-pct'], strategy.maxProfitPct),
    )
  }
  if (args['max-loss-pct'] !== undefined) {
    strategy.maxLossPct = Math.max(
      0.1,
      numberArg(args['max-loss-pct'], strategy.maxLossPct),
    )
  }
  if (args['max-trades-per-day'] !== undefined) {
    strategy.maxTradesPerDay = Math.max(
      1,
      Math.trunc(numberArg(args['max-trades-per-day'], strategy.maxTradesPerDay)),
    )
  }
  if (args['max-total-trades-per-day'] !== undefined) {
    strategy.maxTotalTradesPerDay = Math.max(
      1,
      Math.trunc(
        numberArg(
          args['max-total-trades-per-day'],
          strategy.maxTotalTradesPerDay ?? strategy.maxTradesPerDay,
        ),
      ),
    )
  }
  if (args['max-daily-loss-pct'] !== undefined) {
    strategy.maxDailyLossPct = Math.max(
      0,
      numberArg(args['max-daily-loss-pct'], strategy.maxDailyLossPct ?? 0),
    )
  }
  if (args['exit-cooldown-sec'] !== undefined) {
    strategy.exitCooldownSec = Math.max(
      0,
      Math.trunc(
        numberArg(args['exit-cooldown-sec'], strategy.exitCooldownSec ?? 300),
      ),
    )
  }
  if (args['last-entry-time']) strategy.lastEntryTime = args['last-entry-time']
  if (args['first-entry-time']) strategy.firstEntryTime = args['first-entry-time']
  if (args['max-entry-premium-move-pct'] !== undefined) {
    strategy.maxEntryPremiumMovePct = Math.max(
      0,
      numberArg(args['max-entry-premium-move-pct'], 0),
    )
  }
  if (args['square-off-time']) strategy.squareOffTime = args['square-off-time']

  const filterLabel =
    strategy.useMultiTimeframe === false ? 'filter-off' : 'filter-on'
  const slippageBps = Math.max(0, numberArg(args['slippage-bps'], 10))
  const label =
    args.label ??
    `nifty-${from}-${to}-${filterLabel}-slip${slippageBps}`
  const outDir = path.resolve(
    process.cwd(),
    args.out ?? path.join('data', 'replay', 'reports', slug(label)),
  )

  const macroPath = path.join(dataDir, 'macro.json')
  const macro = fs.existsSync(macroPath)
    ? new MacroSeries(
        JSON.parse(fs.readFileSync(macroPath, 'utf8')) as ReturnType<
          typeof emptyMacroFile
        >,
      )
    : new MacroSeries(emptyMacroFile())
  if (!fs.existsSync(macroPath)) {
    console.warn(
      `Macro file not found at ${macroPath}; global sentiment and VIX will be unavailable.`,
    )
  }

  const dataset = new HfNiftyDataset(dataDir)
  await dataset.load()

  const result = await runReplay({
    dataset,
    macro,
    label,
    options: {
      from,
      to,
      symbol: 'NIFTY 50',
      initialCapital: Math.max(1, numberArg(args.capital, 100_000)),
      lots: Math.max(1, Math.trunc(numberArg(args.lots, 1))),
      lotSize: Math.max(1, Math.trunc(numberArg(args['lot-size'], 75))),
      slippageBps,
      costModel:
        args['cost-model'] === 'paper-parity' ? 'paper-parity' : 'statutory',
      maxEntryDelayBars: Math.max(
        1,
        Math.trunc(numberArg(args['max-entry-delay'], 1)),
      ),
      peakSource: args['peak-source'] === 'high' ? 'high' : 'close',
      maxStrikeDistancePct: Math.max(
        0.1,
        numberArg(args['max-strike-distance-pct'], 3),
      ),
      minBarsPerSession: Math.max(
        10,
        Math.trunc(numberArg(args['min-bars'], 100)),
      ),
      strategy,
    },
  })

  writeReplayReport(result, outDir)
  printReplaySummary(result, outDir)
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error)
  process.exitCode = 1
})
