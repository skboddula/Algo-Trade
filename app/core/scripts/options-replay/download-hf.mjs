#!/usr/bin/env node
/**
 * Downloads the free HF NIFTY 1-minute index + option dataset.
 *
 * Dataset: thetrademarkk/india-index-options-1m
 * License: CC-BY-NC-4.0 (research/non-commercial; attribute the dataset)
 *
 * Layout written:
 *   <data-dir>/index/NIFTY.parquet
 *   <data-dir>/options/NIFTY/<expiry>.parquet
 *   <data-dir>/manifest.json
 *
 * The option files are expiry-scoped: each file contains every contract for
 * that expiry, with `trading_day` + `expiry` columns. The replay picks the
 * nearest strictly-future expiry for each session.
 */
import fs from 'node:fs'
import path from 'node:path'

const DATASET = 'thetrademarkk/india-index-options-1m'
const BASE = `https://huggingface.co/datasets/${DATASET}/resolve/main`
const TREE = `https://huggingface.co/api/datasets/${DATASET}/tree/main/options/NIFTY`
const LICENSE = 'CC-BY-NC-4.0'

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

function addDays(date, days) {
  const parsed = new Date(`${date}T00:00:00.000Z`)
  parsed.setUTCDate(parsed.getUTCDate() + days)
  return parsed.toISOString().slice(0, 10)
}

async function fetchWithRetry(url, attempts = 3) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'algo-trade-replay/1.0' },
        redirect: 'follow',
      })
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`)
      }
      return response
    } catch (error) {
      lastError = error
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 1500))
      }
    }
  }
  throw lastError
}

async function downloadFile(url, destination, force) {
  if (!force && fs.existsSync(destination)) {
    const size = fs.statSync(destination).size
    console.log(`  = ${path.basename(destination)} (${(size / 1e6).toFixed(1)} MB)`)
    return size
  }
  process.stdout.write(`  ↓ ${path.basename(destination)} ... `)
  const response = await fetchWithRetry(url)
  const bytes = new Uint8Array(await response.arrayBuffer())
  fs.writeFileSync(destination, bytes)
  console.log(`${(bytes.length / 1e6).toFixed(1)} MB`)
  return bytes.length
}

async function listExpiries() {
  const response = await fetchWithRetry(TREE)
  const entries = await response.json()
  if (!Array.isArray(entries)) {
    throw new Error(`Unexpected HF tree response: ${JSON.stringify(entries).slice(0, 200)}`)
  }
  return entries
    .map((entry) => entry.path?.split('/').pop() ?? '')
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.parquet$/.test(name))
    .map((name) => name.replace(/\.parquet$/, ''))
    .sort()
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const from = args.from ?? '2026-01-01'
  const to = args.to ?? '2026-05-22'
  const dataDir = path.resolve(
    process.cwd(),
    args['data-dir'] ?? 'data/replay/hf-nifty-1m',
  )
  const force = args.force === 'true'
  fs.mkdirSync(path.join(dataDir, 'index'), { recursive: true })
  fs.mkdirSync(path.join(dataDir, 'options', 'NIFTY'), { recursive: true })

  console.log(`Dataset: ${DATASET} (${LICENSE})`)
  console.log(`Data dir: ${dataDir}`)
  console.log(`Window: ${from} .. ${to}`)

  const expiries = await listExpiries()
  const maxExpiry = addDays(to, 21)
  const wanted = expiries.filter((expiry) => expiry >= from && expiry <= maxExpiry)
  if (!wanted.length) {
    throw new Error(`No expiry files found between ${from} and ${maxExpiry}`)
  }
  console.log(
    `Expiry files: ${wanted.length} (${wanted[0]} .. ${wanted[wanted.length - 1]})`,
  )

  const files = []
  const indexPath = path.join(dataDir, 'index', 'NIFTY.parquet')
  console.log('Index:')
  const indexSize = await downloadFile(
    `${BASE}/index/NIFTY.parquet?download=true`,
    indexPath,
    force,
  )
  files.push({
    kind: 'index',
    path: path.relative(dataDir, indexPath),
    bytes: indexSize,
    url: `${BASE}/index/NIFTY.parquet`,
  })

  console.log('Options:')
  for (const expiry of wanted) {
    const dest = path.join(dataDir, 'options', 'NIFTY', `${expiry}.parquet`)
    const size = await downloadFile(
      `${BASE}/options/NIFTY/${expiry}.parquet?download=true`,
      dest,
      force,
    )
    files.push({
      kind: 'option-expiry',
      expiry,
      path: path.relative(dataDir, dest),
      bytes: size,
      url: `${BASE}/options/NIFTY/${expiry}.parquet`,
    })
  }

  const manifest = {
    dataset: DATASET,
    source: `https://huggingface.co/datasets/${DATASET}`,
    license: LICENSE,
    attribution:
      'NIFTY index and option 1-minute bars from thetrademarkk/india-index-options-1m on Hugging Face.',
    downloadedAt: new Date().toISOString(),
    requestedFrom: from,
    requestedTo: to,
    expiryFiles: wanted,
    files,
  }
  fs.writeFileSync(
    path.join(dataDir, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  )
  console.log(`Manifest: ${path.join(dataDir, 'manifest.json')}`)
  console.log('Done.')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error)
  process.exitCode = 1
})
