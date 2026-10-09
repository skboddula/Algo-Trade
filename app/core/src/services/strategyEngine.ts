import {
  scoreMMI,
  scoreADRatio,
  scoreFiiLongShort,
  scoreFiiPositioning,
  scoreNiftyPE,
  scoreStraddleIV,
  scoreVix,
} from "./vrdSignals";
import {
  SIGNAL_BUY_CE,
  SIGNAL_BUY_PE,
  SIGNAL_NO_TRADE,
  SIGNAL_BUY,
  SIGNAL_SELL,
  SIGNAL_HOLD,
  ORDER_TYPE_BUY,
  ORDER_TYPE_SELL,
  ORDER_TYPE_HOLD,
  CONFIDENCE_STRONG,
  CONFIDENCE_MODERATE,
  CONFIDENCE_WEAK,
  CONFIDENCE_NONE,
  POSITION_SIZE_FULL,
  POSITION_SIZE_HALF,
  LEG_DIRECTION_PE,
} from "../constants";

import type {
  IndicatorsResult,
  SignalType,
  StrategyConfig,
  VrdData,
  ScoreBreakdown,
  ScoreResult,
  FinalSignal,
  AllSignalData,
  ActivePosition,
} from "../types";

export function getV4Signal(indicators: IndicatorsResult): SignalType {
  let buyCount = 0;
  let sellCount = 0;
  if (indicators.ema === SIGNAL_BUY) buyCount++;
  if (indicators.ema === SIGNAL_SELL) sellCount++;
  if (indicators.adx === SIGNAL_BUY) buyCount++;
  if (indicators.adx === SIGNAL_SELL) sellCount++;
  if (indicators.stochastic.signal === SIGNAL_BUY) buyCount++;
  if (indicators.stochastic.signal === SIGNAL_SELL) sellCount++;
  if (indicators.bollinger.signal === SIGNAL_BUY) buyCount++;
  if (indicators.bollinger.signal === SIGNAL_SELL) sellCount++;
  if (indicators.pcr === SIGNAL_BUY) buyCount++;
  if (indicators.pcr === SIGNAL_SELL) sellCount++;

  if (buyCount >= 3 && buyCount > sellCount) return SIGNAL_BUY;
  if (sellCount >= 3 && sellCount > buyCount) return SIGNAL_SELL;
  return SIGNAL_HOLD;
}

function addScore(
  breakdown: ScoreBreakdown[],
  layer: string,
  indicator: string,
  condition: string,
  points: number,
  max: number,
): number {
  breakdown.push({ layer, indicator, condition, points, max });
  return points;
}

// ─── Bullish scoring (browser parity — validated 5-layer weights) ───────────
export function scoreBullish(
  data: AllSignalData,
  config?: Partial<StrategyConfig>,
): ScoreResult {
  const bd: ScoreBreakdown[] = [];
  let score = 0;
  let max = 0;
  const v4 = getV4Signal(data.indicators);

  // V3 (4 pts)
  const v3p =
    data.v3 === ORDER_TYPE_BUY ? 4 : data.v3 === ORDER_TYPE_HOLD ? 0 : -2;
  score += addScore(bd, "V3", "Macro Signal", data.v3, v3p, 4);
  max += 4;

  // V4 (5 pts)
  const v4p = v4 === SIGNAL_BUY ? 5 : v4 === SIGNAL_HOLD ? 0 : -3;
  score += addScore(bd, "V4", "Price Action", v4, v4p, 5);
  max += 5;

  // EMA (3 pts)
  const emap =
    data.indicators.ema === SIGNAL_BUY
      ? 3
      : data.indicators.ema === SIGNAL_HOLD
        ? 0
        : -1;
  score += addScore(bd, "V4", "EMA Crossover", data.indicators.ema, emap, 3);
  max += 3;

  // RSI (2 pts)
  const rsip =
    data.indicators.rsi.signal === "Oversold"
      ? 2
      : data.indicators.rsi.signal === SIGNAL_HOLD
        ? 1
        : -1;
  score += addScore(
    bd,
    "V4",
    `RSI ${data.indicators.rsi.value.toFixed(1)}`,
    data.indicators.rsi.signal,
    rsip,
    2,
  );
  max += 2;

  // ATR (penalty only)
  if (data.indicators.atr.level === "Low") {
    score += addScore(bd, "V4", "ATR", "Low volatility", -2, 0);
  }

  // VRD signals
  if (data.vrd) {
    const mmi = scoreMMI(data.vrd.mmi?.score ?? null);
    if (mmi.direction === "BULL") {
      max += mmi.max;
      score += addScore(bd, "L2", "MMI", mmi.label, mmi.score, mmi.max);
    }

    const ad = data.vrd.advancesDeclines;
    const adS = scoreADRatio(
      ad?.advances ?? null,
      ad?.declines ?? null,
      ad?.ratio ?? null,
    );
    if (adS.direction === "BULL") {
      max += adS.max;
      score += addScore(bd, "L3", "A/D Ratio", adS.label, adS.score, adS.max);
    }

    const fii = data.vrd.fiiLongShort;
    const fiiS = scoreFiiLongShort(fii?.longPct ?? null, fii?.shortPct ?? null);
    if (fiiS.direction === "BULL" || fiiS.contrarian) {
      max += fiiS.max;
      score += addScore(bd, "L2", "FII L/S", fiiS.label, fiiS.score, fiiS.max);
    }

    const pos = data.vrd.fiiPositioning;
    const posS = scoreFiiPositioning(
      pos?.netPosition ?? null,
      pos?.consecutiveShortDays ?? null,
    );
    if (posS.score > 0) {
      max += posS.max;
      score += addScore(
        bd,
        "L2",
        "FII Positioning",
        posS.label,
        posS.score,
        posS.max,
      );
    }

    const pe = scoreNiftyPE(data.vrd.niftyPe?.pe ?? null);
    if (pe.bias !== LEG_DIRECTION_PE) {
      max += pe.max;
      score += addScore(bd, "L2", "Nifty PE", pe.label, pe.score, pe.max);
    }

    const iv = scoreStraddleIV(data.vrd.straddleIv?.percentAboveAvg ?? null);
    if (iv.preferBuy) {
      max += iv.max;
      score += addScore(bd, "L3", "Straddle IV", iv.label, iv.score, iv.max);
    }
  }

  // Brent Crude Overhang Penalty (Commodities)
  if (data.globalIndices) {
    const brent = data.globalIndices.find(
      (item) => item.symbol.toLowerCase() === "brent oil",
    );
    const brentPrice = brent?.last_price ? Number(brent.last_price) : null;
    const brentOverhangThreshold = config?.brentCrudeOverhangThreshold ?? 88;
    const brentExtremeThreshold = config?.brentCrudeExtremeThreshold ?? 125;
    if (brentPrice !== null) {
      if (brentPrice >= brentExtremeThreshold) {
        score += addScore(
          bd,
          "Macro",
          "Brent Crude Extreme Risk",
          `Oil at $${brentPrice} >= $${brentExtremeThreshold} (severe penalty)`,
          -4,
          0,
        );
      } else if (brentPrice >= brentOverhangThreshold) {
        score += addScore(
          bd,
          "Macro",
          "Brent Crude Overhang",
          `Oil at $${brentPrice} >= $${brentOverhangThreshold} (penalty)`,
          -2,
          0,
        );
      }
    }
  }

  // News Alerts Macro / Earnings Guard Penalty
  if (data.vrd?.newsAlerts) {
    const macroAlerts = data.vrd.newsAlerts.filter(
      (alert) =>
        alert.type === "MACRO" &&
        (alert.severity === "HIGH" || alert.severity === "MEDIUM"),
    );
    const earningsAlerts = data.vrd.newsAlerts.filter(
      (alert) =>
        alert.type === "EARNINGS" &&
        (alert.severity === "HIGH" || alert.severity === "MEDIUM"),
    );
    if (macroAlerts.length > 0) {
      score += addScore(
        bd,
        "Macro",
        "Macro News Penalty",
        `Classified ${macroAlerts.length} risk events (penalty)`,
        -2 * macroAlerts.length,
        0,
      );
    }
    if (earningsAlerts.length > 0) {
      score += addScore(
        bd,
        "Macro",
        "Earnings News Penalty",
        `Classified ${earningsAlerts.length} earnings events (penalty)`,
        -1 * earningsAlerts.length,
        0,
      );
    }
  }

  return { score: Math.max(0, score), max, breakdown: bd };
}

// ─── Bearish scoring (browser parity — validated 5-layer weights) ────────────
export function scoreBearish(
  data: AllSignalData,
  config?: Partial<StrategyConfig>,
): ScoreResult {
  const bd: ScoreBreakdown[] = [];
  let score = 0;
  let max = 0;
  const v4 = getV4Signal(data.indicators);

  const v3p =
    data.v3 === ORDER_TYPE_SELL ? 4 : data.v3 === ORDER_TYPE_HOLD ? 0 : -2;
  score += addScore(bd, "V3", "Macro Signal", data.v3, v3p, 4);
  max += 4;

  const v4p = v4 === SIGNAL_SELL ? 5 : v4 === SIGNAL_HOLD ? 0 : -3;
  score += addScore(bd, "V4", "Price Action", v4, v4p, 5);
  max += 5;

  const emap =
    data.indicators.ema === SIGNAL_SELL
      ? 3
      : data.indicators.ema === SIGNAL_HOLD
        ? 0
        : -1;
  score += addScore(bd, "V4", "EMA Crossover", data.indicators.ema, emap, 3);
  max += 3;

  const rsip =
    data.indicators.rsi.signal === "Overbought"
      ? 2
      : data.indicators.rsi.signal === SIGNAL_HOLD
        ? 1
        : -1;
  score += addScore(
    bd,
    "V4",
    `RSI ${data.indicators.rsi.value.toFixed(1)}`,
    data.indicators.rsi.signal,
    rsip,
    2,
  );
  max += 2;

  if (data.indicators.atr.level === "Low") {
    score += addScore(bd, "V4", "ATR", "Low volatility", -2, 0);
  }

  if (data.vrd) {
    const mmi = scoreMMI(data.vrd.mmi?.score ?? null);
    if (mmi.direction === "BEAR") {
      max += mmi.max;
      const pts = Math.abs(mmi.score);
      score += addScore(bd, "L2", "MMI", mmi.label, pts, mmi.max);
    }

    const ad = data.vrd.advancesDeclines;
    const adS = scoreADRatio(
      ad?.advances ?? null,
      ad?.declines ?? null,
      ad?.ratio ?? null,
    );
    if (adS.direction === "BEAR") {
      max += adS.max;
      score += addScore(
        bd,
        "L3",
        "A/D Ratio",
        adS.label,
        Math.abs(adS.score),
        adS.max,
      );
    }

    // FII L/S — momentum-short scoring (shortPct 60–79%)
    const fiiLs = data.vrd.fiiLongShort;
    const fiiLsS = scoreFiiLongShort(
      fiiLs?.longPct ?? null,
      fiiLs?.shortPct ?? null,
    );
    if (fiiLsS.direction === "BEAR") {
      max += fiiLsS.max;
      score += addScore(
        bd,
        "L2",
        "FII L/S",
        fiiLsS.label,
        Math.abs(fiiLsS.score),
        fiiLsS.max,
      );
    }

    // FII Net Positioning — negative net = FII net short = bearish confirmation
    const fiiPos = data.vrd.fiiPositioning;
    const fiiPosS = scoreFiiPositioning(
      fiiPos?.netPosition ?? null,
      fiiPos?.consecutiveShortDays ?? null,
    );
    if (fiiPosS.score < 0) {
      max += fiiPosS.max;
      score += addScore(
        bd,
        "L2",
        "FII Positioning",
        fiiPosS.label,
        Math.abs(fiiPosS.score),
        fiiPosS.max,
      );
    }

    const pe = scoreNiftyPE(data.vrd.niftyPe?.pe ?? null);
    if (pe.bias === LEG_DIRECTION_PE) {
      max += pe.max;
      score += addScore(
        bd,
        "L2",
        "Nifty PE",
        pe.label,
        Math.abs(pe.score),
        pe.max,
      );
    }

    const iv = scoreStraddleIV(data.vrd.straddleIv?.percentAboveAvg ?? null);
    if (!iv.preferBuy && iv.score < 0) {
      max += iv.max;
      score += addScore(
        bd,
        "L3",
        "Straddle IV",
        iv.label,
        Math.abs(iv.score),
        iv.max,
      );
    }
  }

  // Brent Crude Overhang Bonus (Commodities)
  if (data.globalIndices) {
    const brent = data.globalIndices.find(
      (item) => item.symbol.toLowerCase() === "brent oil",
    );
    const brentPrice = brent?.last_price ? Number(brent.last_price) : null;
    const brentOverhangThreshold = config?.brentCrudeOverhangThreshold ?? 88;
    const brentExtremeThreshold = config?.brentCrudeExtremeThreshold ?? 125;
    if (brentPrice !== null) {
      if (brentPrice >= brentExtremeThreshold) {
        max += 2;
        score += addScore(
          bd,
          "Macro",
          "Brent Crude Extreme Risk",
          `Oil at $${brentPrice} >= $${brentExtremeThreshold} (strong bearish catalyst)`,
          2,
          2,
        );
      } else if (brentPrice >= brentOverhangThreshold) {
        max += 1;
        score += addScore(
          bd,
          "Macro",
          "Brent Crude Overhang",
          `Oil at $${brentPrice} >= $${brentOverhangThreshold} (bearish catalyst)`,
          1,
          1,
        );
      }
    }
  }

  // News Alerts Macro / Earnings Guard confirmation & penalty
  if (data.vrd?.newsAlerts) {
    const macroAlerts = data.vrd.newsAlerts.filter(
      (alert) =>
        alert.type === "MACRO" &&
        (alert.severity === "HIGH" || alert.severity === "MEDIUM"),
    );
    const earningsAlerts = data.vrd.newsAlerts.filter(
      (alert) =>
        alert.type === "EARNINGS" &&
        (alert.severity === "HIGH" || alert.severity === "MEDIUM"),
    );
    if (macroAlerts.length > 0) {
      const pts = Math.min(2, macroAlerts.length);
      score += addScore(
        bd,
        "Macro",
        "Macro News Confirmation",
        `Classified ${macroAlerts.length} risk events (bearish catalyst)`,
        pts,
        2,
      );
    }
    if (earningsAlerts.length > 0) {
      score += addScore(
        bd,
        "Macro",
        "Earnings News Penalty",
        `Classified ${earningsAlerts.length} earnings events (penalty)`,
        -1 * earningsAlerts.length,
        0,
      );
    }
  }

  return { score: Math.max(0, score), max, breakdown: bd };
}

export function getFinalSignal(
  data: AllSignalData,
  config: Partial<StrategyConfig>,
): FinalSignal {
  const bull = scoreBullish(data, config);
  const bear = scoreBearish(data, config);
  const v4 = getV4Signal(data.indicators);
  const gap = Math.abs(bull.score - bear.score);
  const top = Math.max(bull.score, bear.score);
  const dominant =
    bull.score > bear.score
      ? "bull"
      : bear.score > bull.score
        ? "bear"
        : CONFIDENCE_NONE;
  const scoreMax = Math.max(bull.max, bear.max, 1);

  const ratio = scoreMax > 0 ? top / scoreMax : 0;
  let confidence: "strong" | "moderate" | "weak" | "none" = CONFIDENCE_NONE;

  const strongThreshold = config.strongThreshold ?? 14;
  const moderateThreshold = config.moderateThreshold ?? 10;
  const strongGap = config.strongGap ?? 6;
  const moderateGap = config.moderateGap ?? 3;

  const satisfiesStrong =
    top >= strongThreshold ||
    (ratio >= 0.7 && top >= Math.max(strongThreshold, 10));
  const satisfiesModerate =
    top >= moderateThreshold ||
    (ratio >= 0.5 && top >= Math.max(moderateThreshold, 6));

  if (satisfiesStrong && gap >= strongGap) confidence = CONFIDENCE_STRONG;
  else if (satisfiesModerate && gap >= moderateGap)
    confidence = CONFIDENCE_MODERATE;
  else if (satisfiesModerate) confidence = CONFIDENCE_WEAK;

  const minConf = config.minConfidence ?? CONFIDENCE_MODERATE;
  const shouldTrade =
    confidence === CONFIDENCE_STRONG ||
    (minConf === CONFIDENCE_MODERATE && confidence === CONFIDENCE_MODERATE);

  if (!shouldTrade || dominant === CONFIDENCE_NONE) {
    return {
      signal: SIGNAL_NO_TRADE,
      confidence,
      positionSize: CONFIDENCE_NONE,
      v3: data.v3,
      v4,
      bullScore: bull.score,
      bearScore: bear.score,
      scoreMax,
    };
  }

  const signal = dominant === "bull" ? SIGNAL_BUY_CE : SIGNAL_BUY_PE;
  const positionSize =
    confidence === CONFIDENCE_STRONG ? POSITION_SIZE_FULL : POSITION_SIZE_HALF;

  // Multi-timeframe confluence filter: block counter-trend entries where the
  // 1-min signal disagrees with the 5-min resampled EMA 10/42 trend.
  // Prevents buying calls during a higher-timeframe downtrend (and vice versa).
  // Neutral ('Hold') or undefined higherTimeframeTrend does not block.
  if (config.useMultiTimeframe !== false && data.indicators) {
    const htTrend = data.indicators.higherTimeframeTrend;
    if (signal === SIGNAL_BUY_CE && htTrend === SIGNAL_SELL) {
      return {
        signal: SIGNAL_NO_TRADE,
        confidence,
        positionSize: CONFIDENCE_NONE,
        v3: data.v3,
        v4,
        bullScore: bull.score,
        bearScore: bear.score,
        scoreMax,
      };
    }
    if (signal === SIGNAL_BUY_PE && htTrend === SIGNAL_BUY) {
      return {
        signal: SIGNAL_NO_TRADE,
        confidence,
        positionSize: CONFIDENCE_NONE,
        v3: data.v3,
        v4,
        bullScore: bull.score,
        bearScore: bear.score,
        scoreMax,
      };
    }
  }

  // Immediate exit check: prevent entering counter-trend trap
  const isBullishBias = signal === SIGNAL_BUY_CE;
  const adRatio = data.vrd?.advancesDeclines?.ratio;
  const isImmediateExit = isBullishBias
    ? v4 === SIGNAL_SELL ||
      data.v3 === ORDER_TYPE_SELL ||
      (adRatio != null && adRatio < 0.8)
    : v4 === SIGNAL_BUY ||
      data.v3 === ORDER_TYPE_BUY ||
      (adRatio != null && adRatio > 1.5);

  if (isImmediateExit) {
    return {
      signal: SIGNAL_NO_TRADE,
      confidence: CONFIDENCE_WEAK,
      positionSize: CONFIDENCE_NONE,
      v3: data.v3,
      v4,
      bullScore: bull.score,
      bearScore: bear.score,
      scoreMax,
    };
  }

  return {
    signal,
    confidence,
    positionSize,
    v3: data.v3,
    v4,
    bullScore: bull.score,
    bearScore: bear.score,
    scoreMax,
  };
}

/**
 * Exit supervision — full parity with the browser's shouldExit():
 *  1. Take-profit % (maxProfitPct)
 *  2. Stop-loss % (maxLossPct)
 *  3. Trailing stop from peak favorable premium (trailPct, only in profit;
 *     direction-agnostic — the peak tracks premium extremes for buyers and
 *     sellers alike)
 *  4. V4 composite signal reversal
 *  5. V3 macro signal reversal
 *  6. Breadth (A/D ratio) reversal against the position bias
 */
export function runHardStopChecks(
  position: ActivePosition,
  data: AllSignalData,
  config: Pick<StrategyConfig, "maxProfitPct" | "maxLossPct" | "trailPct">,
): { triggered: boolean; reason?: string } {
  const currentPrice = position.currentPrice ?? position.entryPrice;
  const entryPrice = position.entryPrice || 1;
  const isSelling = position.tradeType === "selling";
  const pct = isSelling
    ? ((position.entryPrice - currentPrice) / entryPrice) * 100
    : ((currentPrice - position.entryPrice) / entryPrice) * 100;

  if (pct >= config.maxProfitPct)
    return { triggered: true, reason: `Profit +${pct.toFixed(1)}% reached` };
  if (pct <= -config.maxLossPct)
    return {
      triggered: true,
      reason: `Stop loss -${Math.abs(pct).toFixed(1)}% triggered`,
    };

  // Trailing stop: exit when the price retraces trailPct% from the peak
  // favorable price, but only when the position is in profit.
  const trailPct = config.trailPct;
  const peak = position.peakFavorablePrice;
  if (trailPct !== undefined && trailPct > 0 && peak !== undefined) {
    if (isSelling && peak < position.entryPrice) {
      const trailPrice = peak * (1 + trailPct / 100);
      if (currentPrice >= trailPrice) {
        return {
          triggered: true,
          reason: `Trailing stop — price ${currentPrice.toFixed(2)} rose ${trailPct}% from peak ${peak.toFixed(2)}`,
        };
      }
    } else if (!isSelling && peak > position.entryPrice) {
      const trailPrice = peak * (1 - trailPct / 100);
      if (currentPrice <= trailPrice) {
        return {
          triggered: true,
          reason: `Trailing stop — price ${currentPrice.toFixed(2)} dropped ${trailPct}% from peak ${peak.toFixed(2)}`,
        };
      }
    }
  }

  // V4 / V3 signal reversal exits
  const v4 = getV4Signal(data.indicators);
  const isBullishBias = isSelling
    ? position.direction === "PE"
    : position.direction === "CE";

  const reversal = isBullishBias ? SIGNAL_SELL : SIGNAL_BUY;
  if (v4 === reversal)
    return { triggered: true, reason: `V4 signal reversed to ${v4}` };

  const v3Reversal = isBullishBias ? ORDER_TYPE_SELL : ORDER_TYPE_BUY;
  if (data.v3 === v3Reversal)
    return { triggered: true, reason: `V3 signal reversed to ${data.v3}` };

  // Breadth reversal exit
  const ad = data.vrd?.advancesDeclines;
  if (ad?.ratio != null) {
    if (isBullishBias && ad.ratio < 0.8)
      return { triggered: true, reason: "Breadth turned bearish" };
    if (!isBullishBias && ad.ratio > 1.5)
      return { triggered: true, reason: "Breadth turned bullish" };
  }

  return { triggered: false };
}

/**
 * Entry hard-stop gate — browser parity with runHardStopChecks(vrd).
 * Blocks NEW entries (both directions) when:
 *  - VIX is outside the tradeable band (> 25 or < 10), or
 *  - a HIGH-severity MACRO news alert is active.
 */
export function checkEntryHardStops(vrd: VrdData | null): {
  blocked: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];
  if (!vrd) return { blocked: false, reasons };

  // Only VIX is a reliable hard stop (real Upstox data). Nifty PE is
  // synthetic and is penalised through scoring instead.
  const vixCheck = scoreVix(vrd.vix);
  if (!vixCheck.tradeable) {
    reasons.push(vixCheck.label);
  }

  if (vrd.newsAlerts) {
    const highMacro = vrd.newsAlerts.find(
      (alert) => alert.type === "MACRO" && alert.severity === "HIGH",
    );
    if (highMacro) {
      reasons.push(`Macro Guard: High Risk Event - ${highMacro.headline}`);
    }
  }

  return { blocked: reasons.length > 0, reasons };
}
