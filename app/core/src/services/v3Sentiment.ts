/**
 * V3 macro sentiment — direct port of the client's lib/v3Sentiment.ts.
 *
 * V3 is a three-input macro signal (NOT the EMA):
 *   1. Global sentiment  — direction of world indices/brent/gold/USDINR
 *   2. Nifty sentiment   — breadth (advances count of NIFTY 50 constituents)
 *   3. PCR zone          — total put/call OI ratio of the symbol's chain
 * combined through the shared globalNiftyMapping + marketStrategyMapping
 * tables (the same tables the browser client uses).
 */
import type {
  GlobalSentiment,
  NiftySentiment,
  PcrZone,
  V3OrderType,
  McMarketItem,
} from "../types";
import {
  SKIP_SYMBOLS,
  globalNiftyMapping,
  marketStrategyMapping,
} from "../types";
import { ORDER_TYPE_BUY, ORDER_TYPE_HOLD, ORDER_TYPE_SELL } from "../constants";
import { evaluateNiftySentimentFromAdvanceCount } from "./syntheticCalculators";

export function evaluateGlobalSentiment(
  marketData: McMarketItem[],
): GlobalSentiment {
  let score = 0;
  for (const item of marketData) {
    if (SKIP_SYMBOLS.includes(item.symbol)) continue;
    // Global indices feed does not double-weight GIFT Nifty
    const isSgx = false;
    const m = isSgx ? 2 : 1;

    // Inversely correlated with Indian equities (rising = bearish for Nifty)
    const upperSym = item.symbol.toUpperCase();
    const isIndicator =
      upperSym === "USD/INR" || upperSym === "BRENT OIL" || upperSym === "GOLD";
    const directionMultiplier = isIndicator ? -1 : 1;

    if (item.technical_rating) {
      switch (item.technical_rating) {
        case "Very Bullish":
          score += 2 * m * directionMultiplier;
          break;
        case "Bullish":
          score += 1 * m * directionMultiplier;
          break;
        case "Very Bearish":
          score -= 2 * m * directionMultiplier;
          break;
        case "Bearish":
          score -= 1 * m * directionMultiplier;
          break;
      }
    } else if (typeof item.change_per === "number") {
      const pct = item.change_per;
      if (pct >= 0.8) {
        score += 2 * m * directionMultiplier;
      } else if (pct >= 0.2) {
        score += 1 * m * directionMultiplier;
      } else if (pct <= -0.8) {
        score -= 2 * m * directionMultiplier;
      } else if (pct <= -0.2) {
        score -= 1 * m * directionMultiplier;
      }
    }
  }
  // With 13 instruments (max ~±26 range), require clear directional consensus
  if (score <= -5) return "bearish";
  if (score >= 5) return "bullish";
  return "neutral";
}

export function evaluatePCR(pcr: number): PcrZone {
  if (pcr >= 1.6) return "overbought";
  if (pcr > 1) return ORDER_TYPE_BUY;
  if (pcr <= 0.6) return "oversold";
  if (pcr < 1) return ORDER_TYPE_SELL;
  return "neutral";
}

export function getV3Signal(
  globalSentiment: GlobalSentiment,
  niftySentiment: NiftySentiment,
  pcr: PcrZone,
): V3OrderType {
  const globalMap = globalNiftyMapping.find(
    (v) =>
      v.globalSentiment === globalSentiment &&
      v.marketSentiment === niftySentiment,
  );
  if (!globalMap?.canTrade) return ORDER_TYPE_HOLD;
  const strategyMap = marketStrategyMapping.find(
    (v) =>
      v.marketSentiment === niftySentiment &&
      v.putCallRatio === pcr &&
      v.orderType !== null,
  );
  return (strategyMap?.orderType as V3OrderType) ?? ORDER_TYPE_HOLD;
}

/**
 * Assembles the V3 macro signal exactly as the browser's fetchMarket does:
 * breadth → Nifty sentiment, chain OI → PCR zone, global indices → global
 * sentiment, then the mapping tables. Returns 'hold' when inputs are
 * unavailable (parity with the client's default).
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
