#!/usr/bin/env node
/**
 * Fetches daily macro proxies from Yahoo Finance for the replay:
 *
 * - previous completed daily close for global indices / USDINR / Brent / Gold
 * - India VIX daily open (or previous close) for the VIX hard-stop layer
 *
 * This is not the live MoneyControl technical-rating feed. It is a
 * point-in-time daily proxy, labelled as such in the replay report.
 */
import fs from 'node:fs'
import path from 'node:path'

const SYMBOLS = [
  { key: '^GSPC', label: 'S&P 500' },
  { key: '^IXIC', label: 'NASDAQ' },
  { key: '^DJI', label: 'Dow Jones' },
  { key: '^N225', label: 'Nikkei 225' },
  { key: '^HSI', label: 'Hang Seng' },
  { key: '^FTSE', label: 'FTSE 100' },
  { key: '^GDAXI', label: 'DAX' },
  { key: 'USDINR=X', label: 'USD/INR' },
  { key: 'BZ=F', label: 'Brent Oil' },
  { key: 'GC=F', label: 'Gold' },
  { key: '^INDIAVIX', label: 'India VIX' },
]

function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
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

function shiftDate(date, days) {
  const parsed = new Date(`${date}T00:00:00.000Z`)
  parsed.setUTCDate(parsed.getUTCDate() + days)
  return parsed.toISOString().slice(0, 10)
}

async function fetchJson(url, attempts = 3) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0',
          Accept: 'application/json',
        },
        redirect: 'follow',
      })
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
      return await response.json()
    } catch (error) {
      lastError = error
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 3000))
      }
    }
  }
  throw lastError
}

function barsFrom(result) {
  const timestamps = result?.timestamp ?? []
  const quote = result?.indicators?.quote?.[0] ?? {}
  const opens = quote.open ?? []
  const highs = quote.high ?? []
  const lows = quote.low ?? []
  const closes = quote.close ?? []
  const bars = []
  for (let index = 0; index < timestamps.length; index += 1) {
    const close = closes[index]
    if (close == null || !Number.isFinite(close) || close <= 0) continue
    const date = new Date(timestamps[index] * 1000).toISOString().slice(0, 10)
    const pick = (value) =>
      value == null || !Number.isFinite(value) ? null : value
    bars.push({
      date,
      open: pick(opens[index]),
      high: pick(highs[index]),
      low: pick(lows[index]),
      close,
    })
  }
  const deduped = new Map()
  for (const bar of bars) deduped.set(bar.date, bar)
  return [...deduped.values()].sort((left, right) =>
    left.date.localeCompare(right.date),
  )
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const from = args.from ?? '2026-01-01'
  const to = args.to ?? '2026-05-22'
  const dataDir = path.resolve(
    process.cwd(),
    args['data-dir'] ?? 'data/replay/hf-nifty-1m',
  )
  fs.mkdirSync(dataDir, { recursive: true })

  const period1 = Math.floor(
    Date.parse(`${shiftDate(from, -30)}T00:00:00.000Z`) / 1000,
  )
  const period2 = Math.floor(
    Date.parse(`${shiftDate(to, 2)}T00:00:00.000Z`) / 1000,
  )

  const symbols = {}
  for (const symbol of SYMBOLS) {
    const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
      symbol.key,
    )}?period1=${period1}&period2=${period2}&interval=1d&events=div%2Csplits`
    process.stdout.write(`  ${symbol.label} (${symbol.key}) ... `)
    try {
      const payload = await fetchJson(url)
      await new Promise((resolve) => setTimeout(resolve, 800))
      const result = payload?.chart?.result?.[0]
      if (!result) {
        throw new Error(payload?.chart?.error?.description ?? 'no result')
      }
      const bars = barsFrom(result)
      if (!bars.length) throw new Error('no usable daily bars')
      symbols[symbol.key] = { label: symbol.label, bars }
      console.log(`${bars.length} bars (${bars[0].date} .. ${bars[bars.length - 1].date})`)
    } catch (error) {
      console.log(`FAILED: ${error instanceof Error ? error.message : error}`)
    }
  }

  if (!Object.keys(symbols).length) {
    throw new Error('No macro symbols downloaded')
  }

  const output = {
    source: 'Yahoo Finance daily chart API (proxy, not MoneyControl live ratings)',
    fetchedAt: new Date().toISOString(),
    requestedFrom: from,
    requestedTo: to,
    symbols,
  }
  const destination = path.join(dataDir, 'macro.json')
  fs.writeFileSync(destination, `${JSON.stringify(output, null, 2)}\n`)
  console.log(`Macro file: ${destination}`)
  console.log(
    `Downloaded ${Object.keys(symbols).length}/${SYMBOLS.length} symbols.`,
  )
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error)
  process.exitCode = 1
})
