import type { VrdScore } from '../types'

export function scoreMMI(
  score: number | null,
): VrdScore & { contrarian: boolean; direction: 'BULL' | 'BEAR' | 'NEUTRAL' } {
  if (score === null) {
    return {
      score: 0,
      max: 3,
      label: 'MMI unavailable',
      contrarian: false,
      direction: 'NEUTRAL',
    }
  }
  let points: number
  let label: string
  let direction: 'BULL' | 'BEAR' | 'NEUTRAL'
  let contrarian = false
  if (score < 30) {
    points = 3
    label = 'Extreme Fear — contrarian BUY'
    direction = 'BULL'
    contrarian = true
  } else if (score < 50) {
    points = 1
    label = 'Fear — moderate buy signal'
    direction = 'BULL'
  } else if (score < 70) {
    points = -1
    label = 'Greed — be cautious'
    direction = 'BEAR'
  } else {
    points = -3
    label = 'Extreme Greed — avoid entries'
    direction = 'BEAR'
    contrarian = true
  }
  return {
    score: points,
    max: 3,
    label,
    contrarian,
    direction,
    detail: `MMI: ${score}`,
  }
}

export function scoreADRatio(
  advances: number | null,
  declines: number | null,
  ratio: number | null,
): VrdScore & { direction: 'BULL' | 'BEAR' | 'NEUTRAL' } {
  if (ratio === null) {
    return { score: 0, max: 3, label: 'A/D unavailable', direction: 'NEUTRAL' }
  }
  let points: number
  let direction: 'BULL' | 'BEAR' | 'NEUTRAL'
  let label: string
  if (ratio >= 2.0) {
    points = 3
    direction = 'BULL'
    label = `Breadth Thrust A/D ${ratio.toFixed(1)}`
  } else if (ratio >= 1.2) {
    points = 2
    direction = 'BULL'
    label = `Healthy Breadth A/D ${ratio.toFixed(1)}`
  } else if (ratio >= 0.8) {
    points = 0
    direction = 'NEUTRAL'
    label = `Balanced A/D ${ratio.toFixed(1)}`
  } else if (ratio >= 0.5) {
    points = -2
    direction = 'BEAR'
    label = `Weak Breadth A/D ${ratio.toFixed(1)}`
  } else {
    points = -3
    direction = 'BEAR'
    label = `Persistent Weakness A/D ${ratio.toFixed(1)}`
  }
  const detail =
    advances !== null && declines !== null
      ? `${advances}↑ ${declines}↓`
      : undefined
  return { score: points, max: 3, label, direction, detail }
}

export function scoreFiiLongShort(
  longPct: number | null,
  shortPct: number | null,
  shortPctTrend?: 'Rising' | 'Falling' | 'Stable' | null,
): VrdScore & { contrarian: boolean; direction: 'BULL' | 'BEAR' | 'NEUTRAL' } {
  if (longPct === null || shortPct === null) {
    return {
      score: 0,
      max: 3,
      label: 'FII data unavailable',
      contrarian: false,
      direction: 'NEUTRAL',
    }
  }
  let points = 0
  let label = ''
  let direction: 'BULL' | 'BEAR' | 'NEUTRAL' = 'NEUTRAL'
  let contrarian = false

  if (longPct > 65) {
    points = 3
    label = `FII Heavily Long (${longPct.toFixed(0)}%)`
    direction = 'BULL'
  } else if (longPct > 55) {
    points = 1.5
    label = `FII Moderately Long (${longPct.toFixed(0)}%)`
    direction = 'BULL'
  } else if (shortPct > 65) {
    points = -3
    label = `FII Heavily Short (${shortPct.toFixed(0)}%)`
    direction = 'BEAR'
    contrarian = true
  } else if (shortPct > 55) {
    points = -1.5
    label = `FII Moderately Short (${shortPct.toFixed(0)}%)`
    direction = 'BEAR'
  } else {
    points = 0
    label = `FII Balanced (L:${longPct.toFixed(0)}% S:${shortPct.toFixed(0)}%)`
    direction = 'NEUTRAL'
  }

  if (shortPctTrend === 'Rising' && points > 0) points -= 1
  if (shortPctTrend === 'Falling' && points < 0) points += 1

  return {
    score: Math.max(-3, Math.min(3, points)),
    max: 3,
    label,
    contrarian,
    direction,
    detail: `L:${longPct.toFixed(0)}% S:${shortPct.toFixed(0)}%`,
  }
}

export function scoreFiiPositioning(
  netPosition: number | null,
  consecutiveShortDays: number | null,
): VrdScore & { direction: 'BULL' | 'BEAR' | 'NEUTRAL' } {
  if (netPosition === null) {
    return { score: 0, max: 2, label: 'FII flow unavailable', direction: 'NEUTRAL' }
  }
  let points = 0
  let direction: 'BULL' | 'BEAR' | 'NEUTRAL' = 'NEUTRAL'
  let label = ''

  if (netPosition > 1000) {
    points = 2
    direction = 'BULL'
    label = `FII Strong Buying (+₹${netPosition}Cr)`
  } else if (netPosition > 0) {
    points = 1
    direction = 'BULL'
    label = `FII Net Buyers (+₹${netPosition}Cr)`
  } else if (netPosition < -1000) {
    points = -2
    direction = 'BEAR'
    label = `FII Heavy Selling (-₹${Math.abs(netPosition)}Cr)`
  } else {
    points = -1
    direction = 'BEAR'
    label = `FII Net Sellers (-₹${Math.abs(netPosition)}Cr)`
  }

  if (consecutiveShortDays && consecutiveShortDays >= 5 && points < 0) {
    label += ` — ${consecutiveShortDays}d short streak`
  }

  return { score: points, max: 2, label, direction }
}

export function scoreNiftyPE(
  pe: number | null,
): VrdScore & { direction: 'BULL' | 'BEAR' | 'NEUTRAL' } {
  if (pe === null) {
    return { score: 0, max: 2, label: 'PE unavailable', direction: 'NEUTRAL' }
  }
  let points: number
  let direction: 'BULL' | 'BEAR' | 'NEUTRAL'
  let label: string
  if (pe < 18) {
    points = 2
    direction = 'BULL'
    label = `Undervalued PE ${pe.toFixed(1)}`
  } else if (pe < 22) {
    points = 1
    direction = 'BULL'
    label = `Fair Value PE ${pe.toFixed(1)}`
  } else if (pe < 25) {
    points = -1
    direction = 'BEAR'
    label = `Elevated PE ${pe.toFixed(1)}`
  } else {
    points = -2
    direction = 'BEAR'
    label = `Expensive PE ${pe.toFixed(1)}`
  }
  return { score: points, max: 2, label, direction, detail: `PE: ${pe.toFixed(1)}` }
}

export function scoreVix(
  vix: number | null,
): VrdScore & { regime: 'Low' | 'Moderate' | 'High' | 'Extreme'; direction: 'BULL' | 'BEAR' | 'NEUTRAL' } {
  if (vix === null) {
    return { score: 0, max: 2, label: 'VIX unavailable', regime: 'Moderate', direction: 'NEUTRAL' }
  }
  let points: number
  let regime: 'Low' | 'Moderate' | 'High' | 'Extreme'
  let direction: 'BULL' | 'BEAR' | 'NEUTRAL'
  let label: string

  if (vix < 13) {
    points = 1
    regime = 'Low'
    direction = 'BULL'
    label = `Low Volatility VIX ${vix.toFixed(1)}`
  } else if (vix <= 17) {
    points = 2
    regime = 'Moderate'
    direction = 'BULL'
    label = `Optimal Trading VIX ${vix.toFixed(1)}`
  } else if (vix <= 22) {
    points = -1
    regime = 'High'
    direction = 'BEAR'
    label = `Elevated Risk VIX ${vix.toFixed(1)}`
  } else {
    points = -2
    regime = 'Extreme'
    direction = 'BEAR'
    label = `Extreme Volatility VIX ${vix.toFixed(1)}`
  }
  return { score: points, max: 2, label, regime, direction, detail: `VIX: ${vix.toFixed(1)}` }
}

export function scoreStraddleIV(
  elevated: boolean | null,
  percentAboveAvg: number | null,
): VrdScore & { direction: 'BULL' | 'BEAR' | 'NEUTRAL' } {
  if (elevated === null) {
    return { score: 0, max: 1, label: 'Straddle IV unavailable', direction: 'NEUTRAL' }
  }
  if (elevated) {
    return {
      score: -1,
      max: 1,
      label: `Elevated Straddle IV (+${(percentAboveAvg ?? 0).toFixed(0)}%)`,
      direction: 'BEAR',
    }
  }
  return {
    score: 1,
    max: 1,
    label: 'Normal Straddle IV',
    direction: 'BULL',
  }
}
