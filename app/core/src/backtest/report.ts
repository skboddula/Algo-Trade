import fs from 'node:fs'
import path from 'node:path'
import type { ReplayResult, ReplayTrade } from './types'
import { formatInr, round2 } from './time'

const pct = (value: number): string => `${value.toFixed(2)}%`
const num = (value: number): string => value.toFixed(2)
const esc = (value: unknown): string => {
  const text = value == null ? '' : String(value)
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

function csv(rows: Array<Array<unknown>>): string {
  return `${rows.map((row) => row.map(esc).join(',')).join('\n')}\n`
}

function tradeRows(trades: ReplayTrade[]): Array<Array<unknown>> {
  return [
    [
      'id',
      'date',
      'symbol',
      'expiry',
      'strike',
      'direction',
      'instrument_key',
      'lots',
      'lot_size',
      'quantity',
      'entry_time',
      'entry_minute',
      'entry_signal_minute',
      'entry_raw_price',
      'entry_price',
      'entry_spot',
      'entry_signal',
      'entry_confidence',
      'entry_bull_score',
      'entry_bear_score',
      'entry_v3',
      'entry_v4',
      'entry_htf',
      'entry_pcr',
      'entry_vix',
      'exit_time',
      'exit_minute',
      'exit_raw_price',
      'exit_price',
      'exit_spot',
      'exit_reason',
      'hold_minutes',
      'mfe_pct',
      'mae_pct',
      'gross_pnl',
      'raw_pnl',
      'slippage_cost',
      'entry_charges',
      'exit_charges',
      'total_charges',
      'net_pnl',
      'net_pnl_per_unit',
      'return_pct',
      'capital_after',
    ],
    ...trades.map((trade) => [
      trade.id,
      trade.date,
      trade.symbol,
      trade.expiry,
      trade.strike,
      trade.direction,
      trade.instrumentKey,
      trade.lots,
      trade.lotSize,
      trade.quantity,
      trade.entryTime,
      trade.entryMinute,
      trade.entrySignalMinute,
      trade.entryRawPrice,
      trade.entryPrice,
      trade.entrySpot,
      trade.entrySignal,
      trade.entryConfidence,
      trade.entryBullScore,
      trade.entryBearScore,
      trade.entryV3,
      trade.entryV4,
      trade.entryHtf ?? '',
      trade.entryPcr,
      trade.entryVix ?? '',
      trade.exitTime,
      trade.exitMinute,
      trade.exitRawPrice,
      trade.exitPrice,
      trade.exitSpot ?? '',
      trade.exitReason,
      trade.holdMinutes,
      trade.mfePct,
      trade.maePct,
      trade.grossPnl,
      trade.rawPnl,
      trade.slippageCost,
      trade.entryCharges,
      trade.exitCharges,
      trade.totalCharges,
      trade.netPnl,
      trade.netPnlPerUnit,
      trade.returnPct,
      trade.capitalAfter,
    ]),
  ]
}

function dailyRows(result: ReplayResult): Array<Array<unknown>> {
  return [
    [
      'date',
      'expiry',
      'spot_open',
      'spot_close',
      'spot_bars',
      'option_bars',
      'option_strikes',
      'chain_minutes',
      'macro_items',
      'vix',
      'evaluations',
      'actionable',
      'filter_vetoed',
      'entries',
      'trades',
      'gross_pnl',
      'total_charges',
      'net_pnl',
      'equity',
      'daily_return_pct',
      'max_drawdown_pct',
      'notes',
    ],
    ...result.days.map((day) => [
      day.date,
      day.expiry ?? '',
      day.spotOpen ?? '',
      day.spotClose ?? '',
      day.spotBars,
      day.optionBars,
      day.optionStrikes,
      day.chainMinutes,
      day.macroItems,
      day.vix ?? '',
      day.signals.evaluations,
      day.signals.actionable,
      day.signals.filterVetoed,
      day.entries,
      day.trades,
      day.grossPnl,
      day.totalCharges,
      day.netPnl,
      day.equity,
      day.dailyReturnPct,
      day.maxDrawdownPct,
      day.notes.join('; '),
    ]),
  ]
}

function comparisonSection(result: ReplayResult): string {
  if (!result.comparisons?.length) return ''
  const rows = result.comparisons
    .map(
      (row) =>
        `| ${row.label} | ${row.filter} | ${row.slippageBps} | ${row.trades} | ${pct(
          row.winRatePct,
        )} | ${formatInr(row.netPnl)} | ${pct(row.returnPct)} | ${pct(
          row.maxDrawdownPct,
        )} |`,
    )
    .join('\n')
  return `
## A/B and sensitivity

| Arm | 5-min filter | Slippage | Trades | Win rate | Net P&L | Return | Max DD |
|---|---|---|---:|---:|---:|---:|---:|
${rows}
`
}

export function writeReplayReport(result: ReplayResult, outDir: string): void {
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(path.join(outDir, 'trades.csv'), csv(tradeRows(result.trades)))
  fs.writeFileSync(path.join(outDir, 'daily.csv'), csv(dailyRows(result)))
  fs.writeFileSync(
    path.join(outDir, 'equity.csv'),
    csv([
      ['date', 'equity', 'daily_return_pct', 'max_drawdown_pct'],
      ...result.days.map((day) => [
        day.date,
        day.equity,
        day.dailyReturnPct,
        day.maxDrawdownPct,
      ]),
    ]),
  )
  fs.writeFileSync(
    path.join(outDir, 'summary.json'),
    `${JSON.stringify(result, null, 2)}\n`,
  )

  const metrics = result.metrics
  const coverage = result.coverage
  const pcrAverage =
    result.signals.pcrCount > 0
      ? result.signals.pcrSum / result.signals.pcrCount
      : 0
  const exitReasons = Object.entries(result.exitReasons)
    .sort((left, right) => right[1] - left[1])
    .map(([reason, count]) => `| ${reason} | ${count} |`)
    .join('\n')
  const dayTable = result.days
    .map(
      (day) =>
        `| ${day.date} | ${day.expiry ?? '—'} | ${day.spotClose?.toFixed(2) ?? '—'} | ${day.trades} | ${formatInr(
          day.netPnl,
        )} | ${formatInr(day.equity)} | ${pct(day.maxDrawdownPct)} |`,
    )
    .join('\n')

  const report = `# NIFTY 50 cost-aware options replay

**Run:** ${result.label}  
**Window:** ${result.from} → ${result.to} (${coverage.totalSessions} sessions)  
**Symbol:** ${result.symbol}  
**Data source:** ${result.dataSource}  
**License:** ${result.dataLicense}  
**Generated:** ${result.generatedAt}  
**Signal source:** reconstructed production scoring (not a live-VRD snapshot replay)  
**Fill model:** signal on 1-min close → entry at next 1-min option bar open + slippage; stops/targets use intrabar OHLC with stop-first ordering.

## Verdict

- **Net P&L:** ${formatInr(metrics.netPnl)}
- **Return on initial capital:** ${pct(metrics.returnPct)} (initial ${formatInr(
    result.options.initialCapital,
  )})
- **Trades:** ${metrics.totalTrades} (${metrics.wins}W / ${metrics.losses}L / ${
    metrics.flats
  } flat), win rate ${pct(metrics.winRatePct)}
- **Profit factor:** ${metrics.profitFactor == null ? 'n/a' : num(metrics.profitFactor)}
- **Expectancy:** ${formatInr(metrics.expectancy)} per trade
- **Max drawdown:** ${formatInr(metrics.maxDrawdown)} (${pct(metrics.maxDrawdownPct)})
- **Sharpe (daily, annualized):** ${
    metrics.sharpeDaily == null ? 'n/a' : num(metrics.sharpeDaily)
  }
- **Costs:** ${formatInr(metrics.totalCharges)} brokerage + statutory charges; ${formatInr(
    metrics.slippageCost,
  )} modelled slippage

> This is a **reconstructed partial-system replay**. Breadth, FII, MMI, Nifty PE, straddle IV, GIFT Nifty and news were not available historically and were passed as null/empty. It is not proof of live-system parity and must not be used by itself to arm live trading.

## Headline

| Metric | Value |
|---|---:|
| Gross P&L after slippage, before brokerage/statutory charges | ${formatInr(metrics.grossPnl)} |
| Brokerage + statutory charges | ${formatInr(metrics.totalCharges)} |
| Slippage cost (inside gross) | ${formatInr(metrics.slippageCost)} |
| Net P&L | ${formatInr(metrics.netPnl)} |
| Trades | ${metrics.totalTrades} |
| Average hold | ${metrics.avgHoldMinutes.toFixed(1)} min |
| Average MFE | ${pct(metrics.avgMfePct)} |
| Average MAE | ${pct(metrics.avgMaePct)} |
| Positive / negative / flat days | ${metrics.positiveDays} / ${
    metrics.negativeDays
  } / ${metrics.flatDays} |
| Traded sessions | ${metrics.tradedSessions} / ${metrics.totalSessions} |
| Average trades per session | ${metrics.avgTradesPerSession.toFixed(2)} |

## Data coverage

| Layer | Coverage |
|---|---:|
| Sessions with spot bars | ${coverage.sessionsWithSpot} / ${coverage.totalSessions} |
| Sessions with option bars | ${
    coverage.sessionsWithOptionData
  } / ${coverage.totalSessions} |
| Sessions with global macro | ${
    coverage.sessionsWithMacro
  } / ${coverage.totalSessions} |
| Sessions with India VIX | ${
    coverage.sessionsWithVix
  } / ${coverage.totalSessions} |
| Sessions with an actionable signal | ${
    coverage.sessionsWithSignals
  } / ${coverage.totalSessions} |
| Option bars loaded | ${coverage.optionBars} |
| Forward-filled chain minutes | ${coverage.chainMinutes} |
| Macro symbol-days | ${coverage.macroSymbolDays} |
| Average PCR (evaluated minutes) | ${num(pcrAverage)} |

**Disabled/unavailable VRD layers:** ${coverage.disabledVrdLayers.join(', ')}.

Data notes:

${coverage.notes.map((note) => `- ${note}`).join('\n')}

## Signal funnel

| Stage | Count |
|---|---:|
| Signal evaluations | ${result.signals.evaluations} |
| Actionable BUY_CE/BUY_PE signals | ${result.signals.actionable} |
| Vetoed by 5-min EMA 10/42 filter | ${result.signals.filterVetoed} |
| Blocked by VIX hard stop | ${result.signals.hardStopBlocked} |
| Blocked by daily loss kill switch | ${result.signals.dailyLossBlocked} |
| Blocked by daily trade caps | ${result.signals.capBlocked} |
| Blocked by exit cooldown | ${result.signals.cooldownBlocked} |
| Blocked by entry-time cutoff | ${result.signals.entryCutoff} |
| No strictly-future expiry | ${result.signals.noExpiry} |
| No selectable contract | ${result.signals.noContract} |
| No entry option bar | ${result.signals.noOptionBar} |
| Insufficient cash | ${result.signals.insufficientCash} |
| Entries executed | ${result.signals.entries} |
| BUY_CE / BUY_PE signals | ${result.signals.ceSignals} / ${
    result.signals.peSignals
  } |
| HTF Buy / Sell / Hold evaluations | ${result.signals.htfBuy} / ${
    result.signals.htfSell
  } / ${result.signals.htfHold} |
| V3 buy / sell / hold evaluations | ${result.signals.v3Buy} / ${
    result.signals.v3Sell
  } / ${result.signals.v3Hold} |

## Exit reasons

| Reason | Trades |
|---|---:|
${exitReasons}

## Daily results

| Date | Expiry | Spot close | Trades | Net P&L | Equity | Intraday max DD |
|---|---|---:|---:|---:|---:|---:|
${dayTable}

${comparisonSection(result)}

## Limitations and correct interpretation

- **Partial system:** the replay reconstructs technicals, chain PCR, a previous-close global sentiment proxy and a daily VIX proxy. It does **not** have breadth, FII/DII positioning, MMI, Nifty PE, straddle IV, GIFT Nifty, support/resistance from the live feed, or news alerts.
- **No bid/ask:** historical option files provide OHLC, volume and OI only. Slippage is a configurable bps proxy; the report separates it from statutory charges.
- **Option data quality:** far strikes are sparse. Contract selection refuses a strike more than ${pct(
    result.options.maxStrikeDistancePct,
  )} from spot rather than substituting an unrealistic far strike. ATM/near-ATM contracts are the usable region.
- **Expiry:** nearest strictly future expiry; same-day 0-DTE contracts are skipped. NIFTY lot size is ${result.options.lotSize}; the daemon uses 75. If the replay is run with a different lot size, compare per-unit premium P&L rather than absolute paper-ledger P&L.
- **No look-ahead convention:** a signal at minute t uses candles and chain OI up to t, and fills at t+1 open. Daily macro uses the previous completed session; VIX uses the current daily open or previous close. Stops are assumed to hit before targets inside the same bar.
- **Cost model:** ₹20 brokerage/order, 0.1% STT on sell premium, 0.03503% exchange fee, 0.003% stamp duty on buy, SEBI turnover fee in \`statutory\` mode, 18% GST. No DP charges, no margin/interest, no impact beyond the configured slippage.
- **This is not a live-trading green light.** Use it to reject or refine hypotheses, then confirm with exact \`signal_snapshots\` replay as the snapshot table accumulates.

## Reproduce

\`\`\`bash
cd app/core
node scripts/options-replay/download-hf.mjs --from ${result.from} --to ${result.to}
node scripts/options-replay/fetch-macro.mjs --from ${result.from} --to ${result.to}
npx tsx scripts/options-replay.ts --from ${result.from} --to ${result.to} --label ${result.label}
\`\`\`
`

  fs.writeFileSync(path.join(outDir, 'report.md'), report)
  if (result.comparisons?.length) {
    fs.writeFileSync(
      path.join(outDir, 'comparison.md'),
      `# Replay comparison\n\n${comparisonSection(result)}\n`,
    )
  }
}

export function printReplaySummary(result: ReplayResult, outDir: string): void {
  const metrics = result.metrics
  console.log('')
  console.log(`Replay: ${result.label}`)
  console.log(`Window: ${result.from} -> ${result.to}`)
  console.log(
    `Trades: ${metrics.totalTrades}  Win: ${metrics.winRatePct.toFixed(
      1,
    )}%  Net: ${formatInr(metrics.netPnl)}  Return: ${metrics.returnPct.toFixed(
      2,
    )}%`,
  )
  console.log(
    `Charges: ${formatInr(metrics.totalCharges)}  Slippage: ${formatInr(
      metrics.slippageCost,
    )}  MaxDD: ${metrics.maxDrawdownPct.toFixed(2)}%`,
  )
  console.log(
    `Coverage: options ${result.coverage.sessionsWithOptionData}/${result.coverage.totalSessions}, macro ${result.coverage.sessionsWithMacro}/${result.coverage.totalSessions}, VIX ${result.coverage.sessionsWithVix}/${result.coverage.totalSessions}`,
  )
  console.log(`Report: ${path.join(outDir, 'report.md')}`)
  console.log(`Trades: ${path.join(outDir, 'trades.csv')}`)
  console.log(`Summary: ${path.join(outDir, 'summary.json')}`)
  if (result.warnings.length) {
    console.log('Warnings:')
    for (const warning of result.warnings) console.log(`  - ${warning}`)
  }
  console.log(`Round-trip net (for sanity): ${round2(metrics.netPnl)}`)
}
