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
  // Seed with simple average of first period changes
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) avgGain += diff;
    else avgLoss -= diff;
  }
  avgGain /= period;
  avgLoss /= period;
  // Wilder's smoothing: EMA factor = 1/period
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff >= 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return { value: 100, signal: MOMENTUM_OVERBOUGHT };
  const rs = avgGain / avgLoss;
  const value = parseFloat((100 - 100 / (1 + rs)).toFixed(2));
  const signal: MomentumType =
    value >= overbought
      ? MOMENTUM_OVERBOUGHT
      : value <= oversold
        ? MOMENTUM_OVERSOLD
        : SIGNAL_HOLD;
  return { value, signal };
}

export function calcStochastic(
  candles: Candle[],
  period = 14,
  smoothing = 3,
): { k: number; d: number; signal: SignalType } {
  const needed = period + smoothing - 1;
  if (candles.length < needed) return { k: 50, d: 50, signal: SIGNAL_HOLD };
  const recent = candles.slice(-needed);
  const kValues: number[] = [];
  for (let i = period - 1; i < recent.length; i++) {
    const window = recent.slice(i - period + 1, i + 1);
    const high = Math.max(...window.map((c) => c[2]));
    const low = Math.min(...window.map((c) => c[3]));
    const close = recent[i][4];
    kValues.push(high === low ? 50 : ((close - low) / (high - low)) * 100);
  }
  const k = parseFloat((kValues[kValues.length - 1] ?? 50).toFixed(2));
  const dValues = kValues.slice(-smoothing);
  const d = parseFloat(
    (dValues.reduce((s, v) => s + v, 0) / dValues.length).toFixed(2),
  );
  let signal: SignalType = SIGNAL_HOLD;
  if (k > d && k < 20) signal = SIGNAL_BUY;
  else if (k < d && k > 80) signal = SIGNAL_SELL;
  return { k, d, signal };
}

export function calcBollingerBands(
  candles: Candle[],
  period = 20,
  mode: "breakout" | "reversion" = "breakout",
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
  const recent = candles.slice(-period);
  const closes = recent.map((c) => c[4]);
  const sma = closes.reduce((s, p) => s + p, 0) / period;
  const stdDev = Math.sqrt(
    closes.reduce((s, p) => s + Math.pow(p - sma, 2), 0) / period,
  );
  const upper = parseFloat((sma + 2 * stdDev).toFixed(2));
  const lower = parseFloat((sma - 2 * stdDev).toFixed(2));
  const middle = parseFloat(sma.toFixed(2));
  const currentPrice = candles[candles.length - 1][4];
  let signal: SignalType = SIGNAL_HOLD;
  if (mode === "breakout") {
    if (currentPrice > upper) signal = SIGNAL_BUY;
    else if (currentPrice < lower) signal = SIGNAL_SELL;
  } else {
    if (currentPrice > upper) signal = SIGNAL_SELL;
    else if (currentPrice < lower) signal = SIGNAL_BUY;
  }
  const trend: TrendType =
    currentPrice > middle ? "Up" : currentPrice < middle ? "Down" : "Neutral";
  return { upper, middle, lower, signal, trend };
}

export function calcATR(
  candles: Candle[],
  period = 14,
): { value: number; level: VolatilityLevel } {
  if (candles.length < period + 1) return { value: 0, level: "Low" };
  const recent = candles.slice(-(period + 1));
  let trSum = 0;
  for (let i = 1; i < recent.length; i++) {
    trSum += trueRange(recent[i], recent[i - 1][4]);
  }
  const atr = parseFloat((trSum / period).toFixed(2));
  const spot = candles[candles.length - 1][4];
  const pct = spot > 0 ? atr / spot : 0;
  const level: VolatilityLevel =
    pct >= 0.003 ? "High" : pct <= 0.001 ? "Low" : "Neutral";
  return { value: atr, level };
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
