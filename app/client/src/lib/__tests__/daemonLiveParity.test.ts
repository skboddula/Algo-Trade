/**
 * LIVE daemon↔browser parity — the real-data complement to
 * daemonParity.test.ts's synthetic fixtures.
 *
 * Pulls the daemon's current market snapshots (real candles, option chains,
 * VRD sentiment, global indices — whatever it is currently trading on) and
 * re-runs the BROWSER engine on those exact inputs, asserting bit-for-bit
 * equality with what the daemon computed and published:
 *
 *   1. computeAllIndicators(candles, chain) → identical IndicatorsResult
 *   2. getFinalSignal(signalData, defaults) → identical FinalSignal
 *   3. The V3 macro signal → identical v3
 *
 * Any difference in shared math, candle/chain handling, or VRD composition
 * that only manifests on real data fails here before it changes trading.
 *
 * Self-skipping: without a reachable daemon (CI, other machines) the suite
 * is skipped rather than failed.
 */
import { describe, it, expect, beforeAll } from 'vitest'

import { computeAllIndicators } from '@/lib/indicators'
import { getFinalSignal } from '@/lib/strategyEngine'
import {
  evaluateGlobalSentiment,
  evaluatePCR,
  getV3Signal,
} from '@/lib/v3Sentiment'
import { evaluateNiftySentimentFromAdvanceCount } from '@/lib/syntheticCalculators'
import { DEFAULT_STRATEGY_CONFIG } from '@/lib/constants'
import type {
  AllSignalData,
  MarketSnapshot,
  UnderlyingSymbol,
  VrdData,
} from '@/lib/types'

const DAEMON_URL =
  (import.meta.env.VITE_DAEMON_URL as string | undefined) ??
  'http://127.0.0.1:3000'

let daemonReachable: boolean
try {
  const res = await fetch(`${DAEMON_URL}/health`)
  daemonReachable = res.ok
} catch {
  daemonReachable = false
}

const SYMBOLS: UnderlyingSymbol[] = ['NIFTY 50', 'BANKNIFTY', 'FINNIFTY']

/** Reassembles the V3 macro signal exactly as the browser's fetchMarket does. */
function browserV3(snapshot: MarketSnapshot): AllSignalData['v3'] {
  const breadthAdvances = snapshot.vrdData?.advancesDeclines?.advances ?? null
  let niftySentimentFetched = false
  type NiftySentiment = ReturnType<
    typeof evaluateNiftySentimentFromAdvanceCount
  >
  let niftySentiment: NiftySentiment = 'neutral'
  if (breadthAdvances !== null) {
    niftySentiment = evaluateNiftySentimentFromAdvanceCount(breadthAdvances)
    niftySentimentFetched = true
  }

  let chainPutOi = 0
  let chainCallOi = 0
  for (const row of snapshot.optionChain ?? []) {
    chainPutOi += row.put_options?.market_data?.oi ?? 0
    chainCallOi += row.call_options?.market_data?.oi ?? 0
  }
  let pcrZoneFetched = false
  let pcrZone: ReturnType<typeof evaluatePCR> = 'neutral'
  if (chainCallOi > 0) {
    pcrZone = evaluatePCR(chainPutOi / chainCallOi)
    pcrZoneFetched = true
  }

  const globalIndices = snapshot.globalIndices ?? []
  const globalSentiment = evaluateGlobalSentiment(globalIndices)
  const globalSentimentFetched = globalIndices.length > 0

  if (!globalSentimentFetched && !niftySentimentFetched && !pcrZoneFetched) {
    return 'hold'
  }
  return getV3Signal(globalSentiment, niftySentiment, pcrZone)
}

describe.skipIf(!daemonReachable)(
  'LIVE daemon↔browser parity (real daemon snapshot data)',
  () => {
    let snapshots: Partial<Record<UnderlyingSymbol, MarketSnapshot>>

    beforeAll(async () => {
      const res = await fetch(
        `${DAEMON_URL}/api/bot/status?userId=default_user`,
      )
      interface StatusResponse {
        snapshots: Record<string, MarketSnapshot>
      }
      const status: StatusResponse = await res.json()
      snapshots = status.snapshots ?? {}
    })

    for (const symbol of SYMBOLS) {
      describe(`${symbol}`, () => {
        it('browser engine reproduces the daemon indicators bit-for-bit', () => {
          const snap = snapshots[symbol]
          if (!snap?.indicators) {
            console.warn(
              `[${symbol}] no snapshot indicators — skipping live input`,
            )
            return
          }
          const browser = computeAllIndicators(
            snap.candles,
            snap.optionChain ?? [],
          )
          // Deep equality on floats is exact: both engines run the same V8
          // arithmetic on identical JSON-round-tripped inputs.
          expect(browser).toEqual(snap.indicators)
        })

        it('browser engine reproduces the daemon final signal', () => {
          const snap = snapshots[symbol]
          if (!snap?.signal || !snap?.indicators) {
            console.warn(`[${symbol}] no snapshot signal — skipping live input`)
            return
          }
          const signalData: AllSignalData = {
            v3: browserV3(snap),
            indicators: snap.indicators,
            vrd: snap.vrdData ?? null,
            globalIndices: snap.globalIndices ?? [],
          }
          const browser = getFinalSignal(signalData, DEFAULT_STRATEGY_CONFIG)
          expect(browser).toEqual(snap.signal)
        })

        it('V3 macro signal matches on live sentiment data', () => {
          const snap = snapshots[symbol]
          if (!snap?.signal) return
          expect(browserV3(snap)).toBe(snap.signal.v3)
        })

        it('daemon VRD data satisfies the shape the browser engine expects', () => {
          const snap = snapshots[symbol]
          const vrd = snap?.vrdData as VrdData | null | undefined
          if (!vrd) return
          // The VRD layers the scorers consume must all be present and typed
          // the way the browser's fetchSymbolSentiment would have built them.
          expect(typeof vrd.mmi?.score).toBe('number')
          // VrdData.vix is `number | null` by contract — null simply means
          // the latest VIX quote failed; both engines score it identically.
          expect(vrd.vix === null || typeof vrd.vix === 'number').toBe(true)
          if (vrd.advancesDeclines) {
            expect(vrd.advancesDeclines.advances).not.toBeNull()
            expect(vrd.advancesDeclines.ratio).not.toBeNull()
          }
          if (vrd.fiiLongShort) {
            expect(typeof vrd.fiiLongShort.longPct).toBe('number')
            expect(typeof vrd.fiiLongShort.shortPct).toBe('number')
          }
          if (vrd.pcr) expect(typeof vrd.pcr.value).toBe('number')
        })
      })
    }
  },
)
