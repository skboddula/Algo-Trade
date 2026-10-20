import type {
  AllSignalData,
  OptionData,
  VrdData,
} from '../../../../packages/shared/src/types'
import { computeAllIndicators } from '../services/indicators'
import { computeV3Signal } from '../services/v3Sentiment'
import { evaluatePCR } from '../../../../packages/shared/src/v3Sentiment'
import type {
  ReplaySignalContext,
  ReplaySignalSource,
} from './types'

function optionWalls(
  chain: OptionData[],
  spot: number,
): { supportWall: number | null; resistanceWall: number | null } {
  let supportWall: number | null = null
  let supportOi = 0
  let resistanceWall: number | null = null
  let resistanceOi = 0
  for (const row of chain) {
    if (row.strike_price < spot) {
      const oi = row.put_options.market_data.oi ?? 0
      if (oi > supportOi) {
        supportOi = oi
        supportWall = row.strike_price
      }
    } else if (row.strike_price > spot) {
      const oi = row.call_options.market_data.oi ?? 0
      if (oi > resistanceOi) {
        resistanceOi = oi
        resistanceWall = row.strike_price
      }
    }
  }
  return { supportWall, resistanceWall }
}

/**
 * Reconstructs the exact `AllSignalData` shape consumed by `getFinalSignal`
 * from the data a historical replay actually has:
 *
 * - technical indicators from 1-minute spot (+ previous-session HTF seed)
 * - PCR from the actual option-chain OI
 * - global sentiment from the prior daily close
 * - India VIX from the daily open / previous close
 *
 * Breadth, FII, MMI, Nifty PE, straddle IV, GIFT Nifty and news are unavailable
 * historically and are passed as null/empty. That is intentional: the replay
 * reports which scoring layers were active instead of inventing neutral values
 * that look like real inputs.
 */
export function buildReconstructedData(
  context: ReplaySignalContext,
): AllSignalData {
  const indicators = computeAllIndicators(
    context.candles,
    context.chain,
    context.htfCandles,
  )
  let putOi = 0
  let callOi = 0
  for (const row of context.chain) {
    putOi += row.put_options.market_data.oi ?? 0
    callOi += row.call_options.market_data.oi ?? 0
  }

  const globalIndices = context.macro?.items ?? []
  const v3 = computeV3Signal(globalIndices, null, putOi, callOi)
  const pcrZone = evaluatePCR(indicators.pcrValue)
  const walls = optionWalls(context.chain, context.spot)

  const vrd: VrdData = {
    mmi: null,
    advancesDeclines: null,
    fiiLongShort: null,
    fiiPositioning: null,
    pcr: { value: indicators.pcrValue, zone: pcrZone },
    straddleIv: null,
    niftyPe: null,
    vix: context.macro?.vix ?? null,
    giftNifty: null,
    supportWall: walls.supportWall,
    resistanceWall: walls.resistanceWall,
    maxPain: null,
    newsAlerts: [],
    fetchedAt: context.timestamp,
  }

  return {
    v3,
    indicators,
    vrd,
    globalIndices,
  }
}

export class ReconstructedSignalSource implements ReplaySignalSource {
  buildData(context: ReplaySignalContext): AllSignalData {
    return buildReconstructedData(context)
  }
}
