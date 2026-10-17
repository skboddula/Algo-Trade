// Upstox live-feed preflight — safe to run outside market hours.
//
// Verifies, in order:
//   1. V3 WebSocket authorize endpoint with your token
//   2. WebSocket handshake + subscription + protobuf decode (live wire check)
//   3. REST market quotes for the three tracked indices
//   4. REST option chain (nearest expiry + full chain through the production
//      mapping) and one full UpstoxFeedV3Source.acquire() snapshot
//
// Outside market hours the feed sends no price ticks; this checks auth,
// plumbing and last-session data instead. Re-run during market hours to watch
// live ticks flow.
//
// Usage:
//   cd app/core
//   # put PRIMARY_UPSTOX_TOKEN=... in app/core/.env (or export it)
//   yarn feed-check
//   # optional: FEED_CHECK_SECONDS=30 yarn feed-check

import 'dotenv/config'
import WebSocket, { type RawData } from 'ws'
import { UNDERLYING_INSTRUMENT_KEYS, type UnderlyingSymbol } from '../src/types'
import { RestMarketDataSource } from '../src/services/marketDataSources/restMarketDataSource'
import { UpstoxFeedV3Source } from '../src/services/marketDataSources/upstoxFeedV3Source'
import { decodeFeedResponse } from '../src/services/marketDataSources/upstoxFeedV3Proto'
import { fetchNearestExpiry, fetchOptionChain } from '../src/services/marketDataSources/upstoxOptionChain'

const TOKEN = (process.env.PRIMARY_UPSTOX_TOKEN || '').trim()
const API_BASE = (process.env.UPSTOX_API_URL || 'https://api.upstox.com/v2').replace(/\/+$/, '')
const FEED_API_BASE = 'https://api.upstox.com/v3'
const FEED_WSS_DIRECT = 'wss://api.upstox.com/v3/feed/market-data-feed'
const WIRE_CHECK_SECONDS = Math.max(5, Number(process.env.FEED_CHECK_SECONDS || '20') || 20)
const VERBOSE = process.env.FEED_CHECK_VERBOSE === '1'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data
  if (Array.isArray(data)) return Buffer.concat(data)
  return Buffer.from(data)
}

interface WireCheckResult {
  connected: boolean
  path: string
  frames: number
  byType: Record<string, number>
  feedKeys: string[]
}

async function wireCheck(authorizedWss: string | null): Promise<WireCheckResult> {
  const target = authorizedWss || FEED_WSS_DIRECT
  const path = authorizedWss ? 'authorized URI' : 'direct endpoint (redirect-following)'
  console.log(`[2/4] WebSocket wire check via ${path} (${WIRE_CHECK_SECONDS}s)…`)

  const result: WireCheckResult = { connected: false, path, frames: 0, byType: {}, feedKeys: [] }

  return await new Promise<WireCheckResult>((resolve) => {
    let settled = false
    const timer = setTimeout(() => finish(), WIRE_CHECK_SECONDS * 1000)
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.removeAllListeners()
      socket.on('error', () => {})
      try {
        socket.close()
      } catch {
        // already closed
      }
      resolve(result)
    }

    const socket = new WebSocket(target, {
      headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' },
      followRedirects: true,
    })

    socket.on('open', () => {
      result.connected = true
      console.log('      connected ✓ — subscribing to 3 index keys (mode full)')
      socket.send(
        Buffer.from(
          JSON.stringify({
            guid: Date.now().toString(36),
            method: 'sub',
            data: { mode: 'full', instrumentKeys: Object.values(UNDERLYING_INSTRUMENT_KEYS) },
          }),
        ),
      )
    })

    socket.on('message', (data) => {
      try {
        const decoded = decodeFeedResponse(toBuffer(data))
        result.frames += 1
        // proto3 omits enum value 0 (initial_feed), so a frame carrying feeds
        // with no explicit type is the subscription's initial snapshot.
        const type = decoded.type ?? (decoded.feeds ? 'initial_feed' : 'unknown')
        result.byType[type] = (result.byType[type] ?? 0) + 1
        for (const key of Object.keys(decoded.feeds ?? {})) {
          if (!result.feedKeys.includes(key)) result.feedKeys.push(key)
        }
        if (result.frames <= 2) {
          const keyCount = Object.keys(decoded.feeds ?? {}).length
          console.log(`      frame #${result.frames}: type=${type} keys=${keyCount}`)
          if (VERBOSE) console.log(`      ${JSON.stringify(decoded).slice(0, 1000)}`)
        }
      } catch (err) {
        result.byType.decode_error = (result.byType.decode_error ?? 0) + 1
        console.log(`      frame decode failed: ${(err as Error).message}`)
      }
    })

    socket.on('error', (err) => {
      console.log(`      socket error: ${err.message}`)
    })

    socket.on('close', (code) => {
      console.log(`      closed (code ${code})`)
      finish()
    })
  })
}

async function main(): Promise<void> {
  if (!TOKEN) {
    console.error('✗ PRIMARY_UPSTOX_TOKEN is not set.')
    console.error('  Add it to app/core/.env:  PRIMARY_UPSTOX_TOKEN=...')
    console.error('  (Upstox access tokens expire daily ~03:30 IST.)')
    process.exit(2)
  }

  console.log('═══ Algo-Trade · Upstox live-feed preflight ═══')
  console.log(`token loaded (${TOKEN.length} chars) · REST base ${API_BASE} · wire check ${WIRE_CHECK_SECONDS}s`)

  // ── 1. V3 authorize ────────────────────────────────────────────────────────
  let authorizedWss: string | null = null
  let authorizeOk = false
  try {
    const res = await fetch(`${FEED_API_BASE}/feed/market-data-feed/authorize`, {
      headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' },
    })
    const text = await res.text()
    try {
      const payload = JSON.parse(text) as { data?: { authorized_redirect_uri?: unknown; authorizedRedirectUri?: unknown } }
      const uri = payload?.data?.authorized_redirect_uri ?? payload?.data?.authorizedRedirectUri
      if (typeof uri === 'string' && uri.startsWith('wss://')) authorizedWss = uri
    } catch {
      // non-JSON response body — treated as failure below
    }
    authorizeOk = res.ok && authorizedWss !== null
    const detail = authorizeOk ? '✓ wss URI received' : `✗ HTTP ${res.status} ${text.slice(0, 160)}`
    console.log(`[1/4] V3 authorize: ${detail}`)
  } catch (err) {
    console.log(`[1/4] V3 authorize: ✗ ${(err as Error).message}`)
  }

  // ── 2. WebSocket wire check ────────────────────────────────────────────────
  const wire = await wireCheck(authorizedWss)
  console.log(
    `      result: connected=${wire.connected} · frames=${wire.frames} · ${JSON.stringify(wire.byType)}` +
      (wire.feedKeys.length ? ` · feed keys: ${wire.feedKeys.join(', ')}` : ''),
  )
  console.log('      note: no price ticks outside market hours — that is expected.')

  // ── 3. REST quotes ─────────────────────────────────────────────────────────
  console.log('[3/4] REST quotes (last session data):')
  const restSource = new RestMarketDataSource({ upstoxApiBaseUrl: API_BASE, getToken: () => TOKEN })
  let quoteOkCount = 0
  for (const symbol of ['NIFTY 50', 'BANKNIFTY', 'FINNIFTY'] as UnderlyingSymbol[]) {
    const acquired = await restSource.acquire({
      symbol,
      timestamp: new Date().toISOString(),
      candles: [],
      optionChain: [],
    })
    if (acquired.fetchFailed) {
      console.log(`      ${symbol.padEnd(9)} ✗ ${acquired.fetchError}`)
    } else {
      quoteOkCount += 1
      console.log(`      ${symbol.padEnd(9)} ₹${acquired.spotPrice}`)
    }
  }

  // ── 4. Option chain + full source snapshot ─────────────────────────────────
  console.log('[4/4] Option chain + full source snapshot:')
  let chainOk = false
  const instrumentKey = UNDERLYING_INSTRUMENT_KEYS['NIFTY 50']
  try {
    const expiry = await fetchNearestExpiry({ restApiBaseUrl: API_BASE, token: TOKEN, instrumentKey })
    console.log(`      nearest expiry: ${expiry ?? 'none found'}`)
    if (expiry) {
      const chain = await fetchOptionChain({
        restApiBaseUrl: API_BASE,
        token: TOKEN,
        instrumentKey,
        expiry,
        fallbackSpotPrice: 0,
      })
      chainOk = chain.length > 0
      const sample = chain[Math.floor(chain.length / 2)]
      console.log(
        `      chain rows: ${chain.length}` +
          (sample
            ? ` · sample strike ${sample.strike_price}: CE ₹${sample.call_options.market_data.ltp} / PE ₹${sample.put_options.market_data.ltp}`
            : ''),
      )
    }
  } catch (err) {
    console.log(`      option-chain check ✗ ${(err as Error).message}`)
  }

  const feedSource = new UpstoxFeedV3Source({
    restApiBaseUrl: API_BASE,
    getToken: () => TOKEN,
    isMarketOpen: () => true, // allow one chain refresh in this preflight even off-hours
    onLog: (message) => console.log(`      [source] ${message}`),
  })
  try {
    const req = { symbol: 'NIFTY 50' as const, timestamp: new Date().toISOString(), candles: [], optionChain: [] }
    const first = await feedSource.acquire(req)
    console.log(
      `      source acquire t+0.0s: spot ${first.spotPrice} · chain ${first.optionChain.length} · ` +
        `failed ${first.fetchFailed ? first.fetchError : 'no'}`,
    )
    // Give the socket a moment to deliver the initial-feed snapshot, then read
    // again: a warm cache proves the WS -> source path delivered real prices.
    // Like the engine, feed the previous result back in (the chain carries
    // through unchanged between refreshes).
    await sleep(2500)
    const acquired = await feedSource.acquire({ ...req, candles: first.candles, optionChain: first.optionChain })
    console.log(
      `      source acquire t+2.5s: spot ${acquired.spotPrice} · candles ${acquired.candles.length} · ` +
        `chain ${acquired.optionChain.length} · failed ${acquired.fetchFailed ? acquired.fetchError : 'no'}`,
    )
    if (!chainOk) chainOk = acquired.optionChain.length > 0
  } finally {
    feedSource.stop()
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  const ok = authorizeOk && wire.connected && quoteOkCount === 3 && chainOk
  console.log('\n─── summary ───')
  console.log(`authorize ${authorizeOk ? '✓' : '✗'} · ws connect ${wire.connected ? '✓' : '✗'} · quotes ${quoteOkCount}/3 · chain ${chainOk ? '✓' : '✗'}`)
  if (ok) {
    console.log('✓ preflight passed — MARKET_FEED_SOURCE=ws is safe to try.')
    console.log('  Re-run during market hours (09:15–15:30 IST) to watch live ticks flow.')
  } else {
    console.log('✗ preflight had failures — see the phases above.')
    if (!authorizeOk && !wire.connected) {
      console.log('  If the token was issued yesterday, it has expired (tokens die ~03:30 IST daily).')
      console.log('  Refresh it: ./scripts/refresh-token.sh "<NEW_TOKEN>"')
    }
  }
  process.exit(ok ? 0 : 1)
}

main().catch((err) => {
  console.error(`✗ preflight crashed: ${(err as Error).message}`)
  process.exit(1)
})
