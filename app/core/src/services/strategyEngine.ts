import {
  scoreMMI,
  scoreADRatio,
  scoreFiiLongShort,
  scoreVix,
} from './vrdSignals'
import {
  SIGNAL_BUY_CE,
  SIGNAL_BUY_PE,
  SIGNAL_NO_TRADE,
  SIGNAL_BUY,
  SIGNAL_SELL,
  SIGNAL_HOLD,
  ORDER_TYPE_BUY,
  ORDER_TYPE_SELL,
  CONFIDENCE_STRONG,
  CONFIDENCE_MODERATE,
  CONFIDENCE_WEAK,
  CONFIDENCE_NONE,
  POSITION_SIZE_FULL,
  POSITION_SIZE_HALF,
} from '../constants'

import type {
  IndicatorsResult,
  SignalType,
  StrategyConfig,
  ScoreBreakdown,
  ScoreResult,
  FinalSignal,
  AllSignalData,
  ActivePosition,
} from '../types'

export function getV4Signal(indicators: IndicatorsResult): SignalType {
  let buyCount = 0
  let sellCount = 0
  if (indicators.ema === SIGNAL_BUY) buyCount++
  if (indicators.ema === SIGNAL_SELL) sellCount++
  if (indicators.adx === SIGNAL_BUY) buyCount++
  if (indicators.adx === SIGNAL_SELL) sellCount++
  if (indicators.stochastic.signal === SIGNAL_BUY) buyCount++
  if (indicators.stochastic.signal === SIGNAL_SELL) sellCount++
  if (indicators.bollinger.signal === SIGNAL_BUY) buyCount++
  if (indicators.bollinger.signal === SIGNAL_SELL) sellCount++
  if (indicators.pcr === SIGNAL_BUY) buyCount++
  if (indicators.pcr === SIGNAL_SELL) sellCount++

  if (buyCount >= 3 && buyCount > sellCount) return SIGNAL_BUY
  if (sellCount >= 3 && sellCount > buyCount) return SIGNAL_SELL
  return SIGNAL_HOLD
}

export function scoreBullish(
  data: AllSignalData,
  _config?: Partial<StrategyConfig>,
): ScoreResult {
  const breakdown: ScoreBreakdown[] = []
  let totalScore = 0

  // 1. Technical Indicators Layer (Max 30 pts)
  const ind = data.indicators
  if (ind.ema === SIGNAL_BUY) {
    totalScore += 8
    breakdown.push({ layer: 'Technical', indicator: 'EMA 10/42', condition: 'Fast > Slow', points: 8, max: 8 })
  }
  if (ind.adx === SIGNAL_BUY) {
    totalScore += 6
    breakdown.push({ layer: 'Technical', indicator: 'ADX +DI/-DI', condition: '+DI > -DI Strong Trend', points: 6, max: 6 })
  }
  if (ind.rsi.value > 45 && ind.rsi.value < 70) {
    totalScore += 6
    breakdown.push({ layer: 'Technical', indicator: 'RSI(14)', condition: `Bullish Momentum (${ind.rsi.value})`, points: 6, max: 6 })
  }
  if (ind.stochastic.signal === SIGNAL_BUY) {
    totalScore += 5
    breakdown.push({ layer: 'Technical', indicator: 'Stochastic', condition: 'Bullish %K > %D', points: 5, max: 5 })
  }
  if (ind.bollinger.signal === SIGNAL_BUY || ind.bollinger.trend === 'Up') {
    totalScore += 5
    breakdown.push({ layer: 'Technical', indicator: 'Bollinger Bands', condition: 'Upward Trend / Lower Bounce', points: 5, max: 5 })
  }

  // 2. Options Sentiment Layer (Max 15 pts)
  if (ind.pcrValue > 1.1) {
    const pts = ind.pcrValue > 1.3 ? 10 : 7
    totalScore += pts
    breakdown.push({ layer: 'Options', indicator: 'PCR OI', condition: `High Put Writing (${ind.pcrValue})`, points: pts, max: 10 })
  }
  if (data.vrd?.maxPain) {
    totalScore += 5
    breakdown.push({ layer: 'Options', indicator: 'Max Pain', condition: 'Above Max Pain Magnet', points: 5, max: 5 })
  }

  // 3. Institutional Flows & Breadth Layer (Max 20 pts)
  if (data.vrd) {
    const mmi = scoreMMI(data.vrd.mmi?.score ?? null)
    if (mmi.direction === 'BULL') {
      totalScore += mmi.score
      breakdown.push({ layer: 'Institutional', indicator: 'MMI Sentiment', condition: mmi.label, points: mmi.score, max: 3 })
    }

    const ad = scoreADRatio(data.vrd.advancesDeclines?.advances ?? null, data.vrd.advancesDeclines?.declines ?? null, data.vrd.advancesDeclines?.ratio ?? null)
    if (ad.direction === 'BULL') {
      totalScore += ad.score
      breakdown.push({ layer: 'Breadth', indicator: 'A/D Ratio', condition: ad.label, points: ad.score, max: 3 })
    }

    const fii = scoreFiiLongShort(data.vrd.fiiLongShort?.longPct ?? null, data.vrd.fiiLongShort?.shortPct ?? null, data.vrd.fiiLongShort?.shortPctTrend)
    if (fii.direction === 'BULL') {
      totalScore += Math.max(0, fii.score)
      breakdown.push({ layer: 'Institutional', indicator: 'FII Futures Long', condition: fii.label, points: Math.max(0, fii.score), max: 3 })
    }

    const vix = scoreVix(data.vrd.vix)
    if (vix.direction === 'BULL') {
      totalScore += vix.score
      breakdown.push({ layer: 'Volatility', indicator: 'India VIX', condition: vix.label, points: vix.score, max: 2 })
    }
  }

  return { score: totalScore, max: 65, breakdown }
}

export function scoreBearish(
  data: AllSignalData,
  _config?: Partial<StrategyConfig>,
): ScoreResult {
  const breakdown: ScoreBreakdown[] = []
  let totalScore = 0

  // 1. Technical Indicators Layer (Max 30 pts)
  const ind = data.indicators
  if (ind.ema === SIGNAL_SELL) {
    totalScore += 8
    breakdown.push({ layer: 'Technical', indicator: 'EMA 10/42', condition: 'Fast < Slow', points: 8, max: 8 })
  }
  if (ind.adx === SIGNAL_SELL) {
    totalScore += 6
    breakdown.push({ layer: 'Technical', indicator: 'ADX +DI/-DI', condition: '-DI > +DI Strong Downtrend', points: 6, max: 6 })
  }
  if (ind.rsi.value < 55 && ind.rsi.value > 30) {
    totalScore += 6
    breakdown.push({ layer: 'Technical', indicator: 'RSI(14)', condition: `Bearish Momentum (${ind.rsi.value})`, points: 6, max: 6 })
  }
  if (ind.stochastic.signal === SIGNAL_SELL) {
    totalScore += 5
    breakdown.push({ layer: 'Technical', indicator: 'Stochastic', condition: 'Bearish %K < %D', points: 5, max: 5 })
  }
  if (ind.bollinger.signal === SIGNAL_SELL || ind.bollinger.trend === 'Down') {
    totalScore += 5
    breakdown.push({ layer: 'Technical', indicator: 'Bollinger Bands', condition: 'Downward Trend / Upper Rejection', points: 5, max: 5 })
  }

  // 2. Options Sentiment Layer (Max 15 pts)
  if (ind.pcrValue < 0.85) {
    const pts = ind.pcrValue < 0.65 ? 10 : 7
    totalScore += pts
    breakdown.push({ layer: 'Options', indicator: 'PCR OI', condition: `Heavy Call Writing (${ind.pcrValue})`, points: pts, max: 10 })
  }
  if (data.vrd?.maxPain) {
    totalScore += 5
    breakdown.push({ layer: 'Options', indicator: 'Max Pain', condition: 'Below Max Pain Magnet', points: 5, max: 5 })
  }

  // 3. Institutional Flows & Breadth Layer (Max 20 pts)
  if (data.vrd) {
    const mmi = scoreMMI(data.vrd.mmi?.score ?? null)
    if (mmi.direction === 'BEAR') {
      totalScore += Math.abs(mmi.score)
      breakdown.push({ layer: 'Institutional', indicator: 'MMI Sentiment', condition: mmi.label, points: Math.abs(mmi.score), max: 3 })
    }

    const ad = scoreADRatio(data.vrd.advancesDeclines?.advances ?? null, data.vrd.advancesDeclines?.declines ?? null, data.vrd.advancesDeclines?.ratio ?? null)
    if (ad.direction === 'BEAR') {
      totalScore += Math.abs(ad.score)
      breakdown.push({ layer: 'Breadth', indicator: 'A/D Ratio', condition: ad.label, points: Math.abs(ad.score), max: 3 })
    }

    const fii = scoreFiiLongShort(data.vrd.fiiLongShort?.longPct ?? null, data.vrd.fiiLongShort?.shortPct ?? null, data.vrd.fiiLongShort?.shortPctTrend)
    if (fii.direction === 'BEAR') {
      totalScore += Math.abs(fii.score)
      breakdown.push({ layer: 'Institutional', indicator: 'FII Futures Short', condition: fii.label, points: Math.abs(fii.score), max: 3 })
    }

    const vix = scoreVix(data.vrd.vix)
    if (vix.direction === 'BEAR') {
      totalScore += Math.abs(vix.score)
      breakdown.push({ layer: 'Volatility', indicator: 'India VIX', condition: vix.label, points: Math.abs(vix.score), max: 2 })
    }
  }

  return { score: totalScore, max: 65, breakdown }
}

export function getFinalSignal(
  data: AllSignalData,
  config: Partial<StrategyConfig>,
): FinalSignal {
  const bull = scoreBullish(data, config)
  const bear = scoreBearish(data, config)
  const v4 = getV4Signal(data.indicators)
  const gap = Math.abs(bull.score - bear.score)
  const top = Math.max(bull.score, bear.score)
  const dominant =
    bull.score > bear.score
      ? 'bull'
      : bear.score > bull.score
        ? 'bear'
        : CONFIDENCE_NONE
  const scoreMax = Math.max(bull.max, bear.max, 1)

  const ratio = scoreMax > 0 ? top / scoreMax : 0
  let confidence: 'strong' | 'moderate' | 'weak' | 'none' = CONFIDENCE_NONE

  const strongThreshold = config.strongThreshold ?? 14
  const moderateThreshold = config.moderateThreshold ?? 10
  const strongGap = config.strongGap ?? 6
  const moderateGap = config.moderateGap ?? 3

  const satisfiesStrong =
    top >= strongThreshold || (ratio >= 0.7 && top >= Math.max(strongThreshold, 10))
  const satisfiesModerate =
    top >= moderateThreshold || (ratio >= 0.5 && top >= Math.max(moderateThreshold, 6))

  if (satisfiesStrong && gap >= strongGap) confidence = CONFIDENCE_STRONG
  else if (satisfiesModerate && gap >= moderateGap) confidence = CONFIDENCE_MODERATE
  else if (satisfiesModerate) confidence = CONFIDENCE_WEAK

  const minConf = config.minConfidence ?? CONFIDENCE_MODERATE
  const shouldTrade =
    confidence === CONFIDENCE_STRONG ||
    (minConf === CONFIDENCE_MODERATE && confidence === CONFIDENCE_MODERATE)

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
    }
  }

  const signal = dominant === 'bull' ? SIGNAL_BUY_CE : SIGNAL_BUY_PE
  const positionSize =
    confidence === CONFIDENCE_STRONG ? POSITION_SIZE_FULL : POSITION_SIZE_HALF

  // Multi-timeframe confluence filter: block counter-trend entries where the
  // 1-min signal disagrees with the 5-min resampled EMA 10/42 trend.
  // Prevents buying calls during a higher-timeframe downtrend (and vice versa).
  // Neutral ('Hold') or undefined higherTimeframeTrend does not block.
  if (config.useMultiTimeframe !== false && data.indicators) {
    const htTrend = data.indicators.higherTimeframeTrend
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
      }
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
      }
    }
  }

  // Immediate exit check: prevent entering counter-trend trap
  const isBullishBias = signal === SIGNAL_BUY_CE
  const adRatio = data.vrd?.advancesDeclines?.ratio
  const isImmediateExit = isBullishBias
    ? v4 === SIGNAL_SELL || data.v3 === ORDER_TYPE_SELL || (adRatio != null && adRatio < 0.8)
    : v4 === SIGNAL_BUY || data.v3 === ORDER_TYPE_BUY || (adRatio != null && adRatio > 1.5)

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
    }
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
  }
}

export function runHardStopChecks(
  position: ActivePosition,
  _data: AllSignalData,
  config: StrategyConfig,
): { triggered: boolean; reason?: string } {
  // Check max loss %
  if (position.unrealizedPnl != null && position.entryPrice > 0 && position.quantity > 0) {
    const entryValue = position.entryPrice * position.quantity
    const lossPct = (-position.unrealizedPnl / entryValue) * 100
    if (lossPct >= config.maxLossPct) {
      return { triggered: true, reason: `Max loss % reached: -${lossPct.toFixed(1)}%` }
    }
  }

  // Check Take Profit %
  if (position.unrealizedPnl != null && position.entryPrice > 0 && position.quantity > 0) {
    const entryValue = position.entryPrice * position.quantity
    const profitPct = (position.unrealizedPnl / entryValue) * 100
    if (profitPct >= config.maxProfitPct) {
      return { triggered: true, reason: `Take profit % reached: +${profitPct.toFixed(1)}%` }
    }
  }

  // Trailing Stop Loss: configurable trail percentage from peak favorable price.
  // Activates when the position is in profit (peak > entry for buying, peak < entry for selling).
  // Uses config.trailPct (default 5% if not set).
  if (position.peakFavorablePrice && position.currentPrice && position.entryPrice > 0) {
    const isCE = position.direction === 'CE'
    const isSelling = position.tradeType === 'selling'
    const peak = position.peakFavorablePrice
    const current = position.currentPrice
    const trailPct = config.trailPct ?? 5

    // For buying CE or selling PE: favorable = price goes up → peak tracks max
    // For buying PE or selling CE: favorable = price goes down → peak tracks min
    // The peak already tracks the favorable direction (set in TenantManager)
    const isInProfit = isSelling
      ? peak < position.entryPrice // selling: lower price is favorable
      : peak > position.entryPrice // buying: higher price is favorable

    if (isInProfit) {
      const drawdownFromPeak = isCE
        ? ((peak - current) / peak) * 100
        : ((current - peak) / peak) * 100

      if (drawdownFromPeak >= trailPct) {
        return {
          triggered: true,
          reason: `Trailing stop — price dropped ${drawdownFromPeak.toFixed(1)}% from peak (trail: ${trailPct}%)`,
        }
      }
    }
  }

  return { triggered: false }
}
