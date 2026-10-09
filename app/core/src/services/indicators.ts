import type {
  Candle,
  SignalType,
  MomentumType,
  TrendType,
  VolatilityLevel,
  OptionData,
  IndicatorsResult,
} from "../types";
import {
  SIGNAL_BUY,
  SIGNAL_SELL,
  SIGNAL_HOLD,
  MOMENTUM_OVERBOUGHT,
  MOMENTUM_OVERSOLD,
} from "../constants";

function updateEMA(prev: number, price: number, k: number): number {
  return price * k + prev * (1 - k);
}

function computeEMAArray(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  const k = 2 / (period + 1);
  const result: number[] = [values[0]];
  for (let i = 1; i < values.length; i++) {
    result.push(updateEMA(result[i - 1], values[i], k));
  }
  return result;
}

export function calcEMACrossover(
  candles: Candle[],
  fastPeriod = 10,
  slowPeriod = 42,
): SignalType {
  if (candles.length < slowPeriod + 1) return SIGNAL_HOLD;
  const closes = candles.map((c) => c[4]);
  const fastK = 2 / (fastPeriod + 1);
  const slowK = 2 / (slowPeriod + 1);
  let fastEMA = closes[0];
  let slowEMA = closes[0];
  for (let i = 1; i < closes.length; i++) {
    fastEMA = updateEMA(fastEMA, closes[i], fastK);
    slowEMA = updateEMA(slowEMA, closes[i], slowK);
  }
  if (fastEMA > slowEMA) return SIGNAL_BUY;
  if (fastEMA < slowEMA) return SIGNAL_SELL;
  return SIGNAL_HOLD;
}

function trueRange(c: Candle, prevClose: number): number {
  return Math.max(
    c[2] - c[3],
    Math.abs(c[2] - prevClose),
    Math.abs(c[3] - prevClose),
  );
}

export function calcADX(candles: Candle[], period = 14): SignalType {
  if (candles.length < period * 2) return SIGNAL_HOLD;
  const recent = candles.slice(-(period * 2));
  const pdms = new Array<number>(recent.length).fill(0);
  const ndms = new Array<number>(recent.length).fill(0);
  const trs = new Array<number>(recent.length).fill(0);
  for (let i = 1; i < recent.length; i++) {
    const upMove = recent[i][2] - recent[i - 1][2];
    const downMove = recent[i - 1][3] - recent[i][3];
    pdms[i] = upMove > downMove && upMove > 0 ? upMove : 0;
    ndms[i] = downMove > upMove && downMove > 0 ? downMove : 0;
    trs[i] = trueRange(recent[i], recent[i - 1][4]);
  }
  const smoothedPdm = computeEMAArray(pdms, period);
  const smoothedNdm = computeEMAArray(ndms, period);
  const smoothedTr = computeEMAArray(trs, period);
  const plusDi = smoothedPdm.map((p, i) => {
    const t = smoothedTr[i];
    return t > 0 ? (p / t) * 100 : 0;
  });
  const minusDi = smoothedNdm.map((n, i) => {
    const t = smoothedTr[i];
    return t > 0 ? (n / t) * 100 : 0;
  });
  const dxs = plusDi.map((p, i) => {
    const n = minusDi[i];
    const div = p + n;
    return div !== 0 ? (Math.abs(p - n) / div) * 100 : 0;
  });
  const adxArr = computeEMAArray(dxs, period);
  const adx = adxArr[adxArr.length - 1] ?? 0;
  if (adx < 25) return SIGNAL_HOLD;
  const plusLast = plusDi[plusDi.length - 1] ?? 0;
  const minusLast = minusDi[minusDi.length - 1] ?? 0;
  return plusLast > minusLast ? SIGNAL_BUY : SIGNAL_SELL;
}

export function calcRSI(
  candles: Candle[],
  period = 14,
  overbought = 70,
  oversold = 30,
): { value: number; signal: MomentumType } {
  if (candles.length < period + 1) {
    return { value: 50, signal: SIGNAL_HOLD };
  }
  const closes = candles.map((c) => c[4]);
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) avgGain += diff;
    else avgLoss += Math.abs(diff);
  }
  avgGain /= period;
  avgLoss /= period;

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) {
      avgGain = (avgGain * (period - 1) + diff) / period;
      avgLoss = (avgLoss * (period - 1)) / period;
    } else {
      avgGain = (avgGain * (period - 1)) / period;
      avgLoss = (avgLoss * (period - 1) + Math.abs(diff)) / period;
    }
  }
  if (avgLoss === 0) return { value: 100, signal: MOMENTUM_OVERBOUGHT };
  const rs = avgGain / avgLoss;
  const rsi = Math.round((100 - 100 / (1 + rs)) * 100) / 100;
  let signal: MomentumType = SIGNAL_HOLD;
  if (rsi >= overbought) signal = MOMENTUM_OVERBOUGHT;
  else if (rsi <= oversold) signal = MOMENTUM_OVERSOLD;
  return { value: rsi, signal };
}

export function calcStochastic(
  candles: Candle[],
  kPeriod = 14,
  dPeriod = 3,
  overbought = 80,
  oversold = 20,
): { k: number; d: number; signal: SignalType } {
  if (candles.length < kPeriod + dPeriod) {
    return { k: 50, d: 50, signal: SIGNAL_HOLD };
  }
  const kValues: number[] = [];
  for (let i = kPeriod - 1; i < candles.length; i++) {
    const slice = candles.slice(i - kPeriod + 1, i + 1);
    const highestHigh = Math.max(...slice.map((c) => c[2]));
    const lowestLow = Math.min(...slice.map((c) => c[3]));
    const currentClose = candles[i][4];
    const range = highestHigh - lowestLow;
    const k = range === 0 ? 50 : ((currentClose - lowestLow) / range) * 100;
    kValues.push(k);
  }
  const dValues = computeEMAArray(kValues, dPeriod);
  const lastK = Math.round((kValues[kValues.length - 1] ?? 50) * 100) / 100;
  const lastD = Math.round((dValues[dValues.length - 1] ?? 50) * 100) / 100;
  let signal: SignalType = SIGNAL_HOLD;
  if (lastK > lastD && lastK < overbought) signal = SIGNAL_BUY;
  else if (lastK < lastD && lastK > oversold) signal = SIGNAL_SELL;
  return { k: lastK, d: lastD, signal };
}

export function calcBollingerBands(
  candles: Candle[],
  period = 20,
  stdDevMultiplier = 2,
): {
  upper: number;
  middle: number;
  lower: number;
  signal: SignalType;
  trend: TrendType;
} {
  if (candles.length < period) {
    const last = candles[candles.length - 1]?.[4] ?? 0;
    return {
      upper: last,
      middle: last,
      lower: last,
      signal: SIGNAL_HOLD,
      trend: "Neutral",
    };
  }
  const slice = candles.slice(-period);
  const closes = slice.map((c) => c[4]);
  const mean = closes.reduce((a, b) => a + b, 0) / period;
  const variance =
    closes.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / period;
  const stdDev = Math.sqrt(variance);
  const upper = Math.round((mean + stdDevMultiplier * stdDev) * 100) / 100;
  const lower = Math.round((mean - stdDevMultiplier * stdDev) * 100) / 100;
  const middle = Math.round(mean * 100) / 100;
  const current = closes[closes.length - 1];
  let signal: SignalType = SIGNAL_HOLD;
  if (current >= upper) signal = SIGNAL_SELL;
  else if (current <= lower) signal = SIGNAL_BUY;
  let trend: TrendType = "Neutral";
  if (current > middle) trend = "Up";
  else if (current < middle) trend = "Down";
  return { upper, middle, lower, signal, trend };
}

export function calcATR(
  candles: Candle[],
  period = 14,
): { value: number; level: VolatilityLevel } {
  if (candles.length < period + 1) {
    return { value: 0, level: "Neutral" };
  }
  const recent = candles.slice(-(period + 1));
  const trs: number[] = [];
  for (let i = 1; i < recent.length; i++) {
    trs.push(trueRange(recent[i], recent[i - 1][4]));
  }
  const atr = trs.reduce((a, b) => a + b, 0) / period;
  const lastClose = candles[candles.length - 1][4];
  const atrPct = lastClose > 0 ? (atr / lastClose) * 100 : 0;
  let level: VolatilityLevel = "Neutral";
  if (atrPct > 1.5) level = "High";
  else if (atrPct < 0.5) level = "Low";
  return { value: Math.round(atr * 100) / 100, level };
}

export function calcSupertrend(
  candles: Candle[],
  period = 10,
  multiplier = 3,
): { trend: "Up" | "Down"; value: number } {
  if (candles.length < period + 1) {
    return { trend: "Up", value: candles[candles.length - 1]?.[4] ?? 0 };
  }
  const trs: number[] = [0];
  for (let i = 1; i < candles.length; i++) {
    trs.push(trueRange(candles[i], candles[i - 1][4]));
  }
  const atrs = computeEMAArray(trs, period);
  let trend: "Up" | "Down" = "Up";
  let supertrendValue = 0;

  for (let i = period; i < candles.length; i++) {
    const hl2 = (candles[i][2] + candles[i][3]) / 2;
    const basicUpper = hl2 + multiplier * atrs[i];
    const basicLower = hl2 - multiplier * atrs[i];
    const close = candles[i][4];

    if (close > basicUpper && trend === "Down") {
      trend = "Up";
      supertrendValue = basicLower;
    } else if (close < basicLower && trend === "Up") {
      trend = "Down";
      supertrendValue = basicUpper;
    } else {
      supertrendValue = trend === "Up" ? basicLower : basicUpper;
    }
  }
  return { trend, value: Math.round(supertrendValue * 100) / 100 };
}

export function calcVWAP(candles: Candle[]): number {
  if (candles.length === 0) return 0;
  let totalPV = 0;
  let totalVolume = 0;
  for (const c of candles) {
    const typicalPrice = (c[2] + c[3] + c[4]) / 3;
    const volume = c[5] || 1;
    totalPV += typicalPrice * volume;
    totalVolume += volume;
  }
  return totalVolume > 0 ? Math.round((totalPV / totalVolume) * 100) / 100 : 0;
}

export function calcPCR(optionChain: OptionData[]): {
  pcr: number;
  signal: SignalType;
} {
  let totalPutOI = 0;
  let totalCallOI = 0;
  for (const o of optionChain) {
    totalPutOI += o.put_options.market_data.oi ?? 0;
    totalCallOI += o.call_options.market_data.oi ?? 0;
  }
  if (totalCallOI === 0) return { pcr: 0, signal: SIGNAL_HOLD };
  const pcr = parseFloat((totalPutOI / totalCallOI).toFixed(3));
  // PCR > 1.0: more puts = put writers active = support = bullish
  const signal: SignalType =
    pcr >= 1.0 ? SIGNAL_BUY : pcr <= 0.7 ? SIGNAL_SELL : SIGNAL_HOLD;
  return { pcr, signal };
}

// ─── Higher-Timeframe Resampling & Trend ─────────────────────────────────────

/**
 * Resamples 1-minute candles into higher-timeframe candles by aggregating
 * every `factor` consecutive bars into one (open=first, high=max, low=min,
 * close=last, volume=sum).
 */
export function resampleCandles(candles: Candle[], factor: number): Candle[] {
  if (factor <= 1 || candles.length === 0) return candles;
  const out: Candle[] = [];
  for (let i = 0; i < candles.length; i += factor) {
    const group = candles.slice(i, i + factor);
    if (group.length === 0) continue;
    const open = group[0][1];
    const high = Math.max(...group.map((c) => c[2]));
    const low = Math.min(...group.map((c) => c[3]));
    const close = group[group.length - 1][4];
    const volume = group.reduce((s, c) => s + (c[5] ?? 0), 0);
    out.push([group[0][0], open, high, low, close, volume, undefined]);
  }
  return out;
}

/**
 * Computes the EMA 10/42 trend on 5-minute resampled candles.
 * Used as a multi-timeframe confluence filter to block counter-trend entries.
 */
export function calcHigherTimeframeTrend(
  candles: Candle[],
  resampleFactor = 5,
  fastPeriod = 10,
  slowPeriod = 42,
): SignalType {
  const resampled = resampleCandles(candles, resampleFactor);
  if (resampled.length < slowPeriod + 1) return SIGNAL_HOLD;
  const closes = resampled.map((c) => c[4]);
  const fastK = 2 / (fastPeriod + 1);
  const slowK = 2 / (slowPeriod + 1);
  let fastEMA = closes[0];
  let slowEMA = closes[0];
  for (let i = 1; i < closes.length; i++) {
    fastEMA = fastEMA + (closes[i] - fastEMA) * fastK;
    slowEMA = slowEMA + (closes[i] - slowEMA) * slowK;
  }
  if (fastEMA > slowEMA) return SIGNAL_BUY;
  if (fastEMA < slowEMA) return SIGNAL_SELL;
  return SIGNAL_HOLD;
}

export function computeAllIndicators(
  candles: Candle[],
  optionChain?: OptionData[],
): IndicatorsResult {
  const ema = calcEMACrossover(candles);
  const adx = calcADX(candles);
  const rsi = calcRSI(candles);
  const stochastic = calcStochastic(candles);
  const bollinger = calcBollingerBands(candles);
  const atr = calcATR(candles);
  const pcrRes = optionChain?.length
    ? calcPCR(optionChain)
    : { pcr: 0, signal: SIGNAL_HOLD };

  return {
    ema,
    adx,
    rsi,
    stochastic,
    bollinger,
    atr,
    pcr: pcrRes.signal,
    pcrValue: pcrRes.pcr,
    higherTimeframeTrend: calcHigherTimeframeTrend(candles),
  };
}
