/**
 * V3 macro sentiment — the browser client's evaluators, re-exported, plus
 * the daemon-side assembly wrapper.
 *
 * The client assembles the V3 signal inline inside fetchMarket(); the daemon
 * assembles it here — from the SAME evaluators, with the SAME logic —
 * because its market data arrives through the sentiment ingestor instead of
 * a browser fetch cycle.
 */
export {
  evaluateGlobalSentiment,
  evaluatePCR,
  getV3Signal,
} from "../../../client/src/lib/v3Sentiment";

import {
  evaluateGlobalSentiment,
  evaluatePCR,
  getV3Signal,
} from "../../../client/src/lib/v3Sentiment";
import { evaluateNiftySentimentFromAdvanceCount } from "../../../client/src/lib/syntheticCalculators";
import { ORDER_TYPE_HOLD } from "../constants";
import type {
  McMarketItem,
  NiftySentiment,
  PcrZone,
  V3OrderType,
} from "../types";

/**
 * Assembles the V3 macro signal exactly as the browser's fetchMarket does:
 * breadth → Nifty sentiment, chain OI → PCR zone, global indices → global
 * sentiment, then the shared mapping tables. Returns 'hold' when inputs
 * are unavailable (parity with the client's default).
 */
export function computeV3Signal(
  globalIndices: McMarketItem[],
  breadthAdvances: number | null,
  optionChainPutOi: number,
  optionChainCallOi: number,
): V3OrderType {
  let v3: V3OrderType = ORDER_TYPE_HOLD;

  let niftySentiment: NiftySentiment = "neutral";
  let pcrZone: PcrZone = "neutral";
  let niftySentimentFetched = false;
  let pcrZoneFetched = false;

  if (breadthAdvances !== null) {
    niftySentiment = evaluateNiftySentimentFromAdvanceCount(breadthAdvances);
    niftySentimentFetched = true;
  }

  if (optionChainCallOi > 0) {
    pcrZone = evaluatePCR(optionChainPutOi / optionChainCallOi);
    pcrZoneFetched = true;
  }

  const globalSentiment = evaluateGlobalSentiment(globalIndices);
  const globalSentimentFetched = globalIndices.length > 0;

  if (globalSentimentFetched || niftySentimentFetched || pcrZoneFetched) {
    v3 = getV3Signal(globalSentiment, niftySentiment, pcrZone);
  }
  return v3;
}
