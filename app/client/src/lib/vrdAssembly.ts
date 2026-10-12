/**
 * VRD sentiment assembly — the single source of truth for composing the
 * VrdData object the strategy engine consumes. Both runtimes call this
 * after fetching their own inputs (the browser via the Worker proxies,
 * the daemon via direct Upstox REST) — only the FETCHING differs, never
 * the composition.
 *
 * Canonical semantics (the validated browser-bot behaviour):
 *  - effectivePcr = official PCR ?? chain-derived PCR
 *  - support/resistance walls = max put-OI / max call-OI strikes
 *  - PCR zones: >=1.6 Overbought · >=1.0 Bullish · >0.7 Neutral · else Bearish
 *  - straddle IV elevated when >30% above VIX
 *  - breadth is dropped when advances is null (not merely absent)
 */
import type { IndicatorsResult, NewsAlert, OptionData, VrdData } from './types'
import {
  computeMMI,
  computeProxyValuation,
  computeStraddleIV,
} from './syntheticCalculators'

export interface VrdAssemblyInput {
  /** Symbol's live option chain (walls, LTP, straddle inputs). */
  optionChain: OptionData[]
  indicators: IndicatorsResult
  /** Live India VIX (null when the quote failed — both engines score null
   *  identically via the shared scorers). */
  vix: number | null
  /** NIFTY-50 market breadth, or null when the fetch failed. */
  breadth: {
    advances: number | null
    declines: number | null
    ratio: number | null
  } | null
  fiiLongShort: VrdData['fiiLongShort']
  fiiPositioning: VrdData['fiiPositioning']
  giftNifty: VrdData['giftNifty']
  /** Official exchange PCR when fetched, else null (falls back to chain OI). */
  officialPcr: number | null
  /** Official max-pain strike when fetched, else null. */
  maxPain: number | null
  /** DII net cash in ₹ Cr, or null when the fetch failed (display-only). */
  diiNetCashCr?: number | null
  newsAlerts: NewsAlert[]
}

export interface VrdAssemblyResult {
  vrd: VrdData
  /** Effective PCR after fallback — for logging surfaces. */
  effectivePcr: number
  /** Raw straddle-IV breakdown — for logging surfaces. */
  straddleIv: ReturnType<typeof computeStraddleIV>
  proxyPe: { pe: number; label: string }
  mmi: { score: number; label: string }
}

export function assembleVrdData(input: VrdAssemblyInput): VrdAssemblyResult {
  const effectivePcr = input.officialPcr ?? input.indicators.pcrValue

  // Support and resistance walls from option-chain open interest
  let supportWall: number | null = null
  let resistanceWall: number | null = null
  if (input.optionChain.length > 0) {
    let maxPutOi = -1
    let maxCallOi = -1
    for (const strike of input.optionChain) {
      const putOi = strike.put_options?.market_data?.oi ?? 0
      const callOi = strike.call_options?.market_data?.oi ?? 0
      if (putOi > maxPutOi) {
        maxPutOi = putOi
        supportWall = strike.strike_price
      }
      if (callOi > maxCallOi) {
        maxCallOi = callOi
        resistanceWall = strike.strike_price
      }
    }
  }

  const ltp = input.optionChain[0]?.underlying_spot_price ?? 0
  const straddleIv = computeStraddleIV(input.optionChain, ltp, input.vix)
  const adRatio = input.breadth?.ratio ?? null
  const proxyPe = computeProxyValuation(
    ltp,
    input.indicators,
    input.vix,
    adRatio,
  )
  const mmi = computeMMI(input.vix, input.indicators.rsi.value, effectivePcr)

  const vrd: VrdData = {
    mmi: { score: mmi.score, label: mmi.label },
    advancesDeclines:
      input.breadth !== null && input.breadth.advances !== null
        ? {
            advances: input.breadth.advances,
            declines: input.breadth.declines,
            ratio: input.breadth.ratio,
            label: null,
          }
        : null,
    fiiLongShort: input.fiiLongShort,
    fiiPositioning: input.fiiPositioning,
    pcr:
      effectivePcr > 0
        ? {
            value: parseFloat(effectivePcr.toFixed(3)),
            zone:
              effectivePcr >= 1.6
                ? 'Overbought'
                : effectivePcr >= 1.0
                  ? 'Bullish'
                  : effectivePcr > 0.7
                    ? 'Neutral'
                    : 'Bearish',
          }
        : null,
    straddleIv: {
      elevated:
        straddleIv.percentAboveAvg !== null && straddleIv.percentAboveAvg > 30,
      percentAboveAvg: straddleIv.percentAboveAvg,
    },
    niftyPe: { pe: proxyPe.pe, label: proxyPe.label },
    vix: input.vix,
    giftNifty: input.giftNifty,
    diiNetCashCr: input.diiNetCashCr ?? null,
    supportWall,
    resistanceWall,
    maxPain: input.maxPain,
    newsAlerts: input.newsAlerts,
    fetchedAt: new Date().toISOString(),
  }

  return { vrd, effectivePcr, straddleIv, proxyPe, mmi }
}
