import type {
  NiftySentiment,
  OptionData,
  ActivePosition,
} from '../types'

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function evaluateNiftySentimentFromAdvanceCount(
  advances: number | null,
): NiftySentiment {
  if (advances === null || Number.isNaN(advances)) return 'neutral'
  if (advances >= 39) return 'very bullish'
  if (advances >= 29) return 'bullish'
  if (advances >= 23) return 'neutral'
  if (advances >= 13) return 'bearish'
  return 'very bearish'
}

export function isStaticIpRestrictionError(
  message: string | null | undefined,
): boolean {
  if (!message) return false
  const normalized = message.toLowerCase()
  return (
    normalized.includes('static ip restrictions') ||
    normalized.includes('no static ip has been configured')
  )
}

export function isPaperPosition(position: ActivePosition | null): boolean {
  return position?.executionMode === 'paper'
}

export function getLotSizeForSymbol(
  symbol: string,
  defaultHint?: number,
): number {
  if (defaultHint && defaultHint > 0) return defaultHint
  if (!symbol) return 1

  const upper = symbol.toUpperCase()

  // 1. Index Options & Futures
  if (upper.includes('BANKNIFTY') || upper.includes('NIFTY BANK')) return 30
  if (
    upper.includes('FINNIFTY') ||
    upper.includes('NIFTY FIN SERVICE') ||
    upper.includes('FIN SERVICE')
  )
    return 60
  if (
    upper.includes('MIDCPNIFTY') ||
    upper.includes('NIFTY MID SELECT') ||
    upper.includes('MIDCAP')
  )
    return 120
  if (upper.includes('NIFTYNXT50') || upper.includes('NEXT50')) return 10
  if (upper.includes('SENSEX') || upper.includes('BSX')) return 10
  if (upper.includes('BANKEX')) return 15
  if (upper.includes('NIFTY 50') || upper.includes('NIFTY')) return 65

  // 2. High-volume NSE Stock F&O Symbols
  if (upper.includes('RELIANCE')) return 250
  if (upper.includes('INFY') || upper.includes('INFOSYS')) return 400
  if (upper.includes('TCS')) return 175
  if (upper.includes('HDFCBANK')) return 550
  if (upper.includes('ICICIBANK')) return 700
  if (upper.includes('SBIN')) return 1500
  if (upper.includes('AXISBANK')) return 625
  if (upper.includes('KOTAKBANK')) return 400
  if (upper.includes('TATAMOTORS')) return 1425
  if (upper.includes('TATASTEEL')) return 5500
  if (upper.includes('BHARTIARTL')) return 475
  if (upper.includes('LT') || upper.includes('LARSEN')) return 300
  if (upper.includes('ITC')) return 1600
  if (upper.includes('MARUTI')) return 100
  if (upper.includes('BAJFINANCE')) return 125
  if (upper.includes('BAJAJFINSV')) return 500
  if (upper.includes('WIPRO')) return 1500
  if (upper.includes('HCLTECH')) return 700
  if (upper.includes('TECHM')) return 600
  if (upper.includes('SUNPHARMA')) return 700
  if (upper.includes('TITAN')) return 175
  if (upper.includes('ULTRACEMCO')) return 100
  if (upper.includes('ASIANPAINT')) return 200
  if (upper.includes('NESTLEIND')) return 250
  if (upper.includes('POWERGRID')) return 3600
  if (upper.includes('NTPC')) return 3000
  if (upper.includes('ONGC')) return 3850
  if (upper.includes('COALINDIA')) return 2100

  return defaultHint && defaultHint > 0 ? defaultHint : 1
}

export function computeMMI(
  vix: number | null,
  rsiValue: number,
  pcrValue: number,
): { score: number; label: string } {
  const vixScore =
    vix === null
      ? 50
      : vix > 25
        ? 10
        : vix > 20
          ? 25
          : vix > 16
            ? 40
            : vix > 13
              ? 55
              : vix > 10
                ? 70
                : 80

  const rsiScore =
    rsiValue < 30
      ? 15
      : rsiValue < 40
        ? 30
        : rsiValue < 50
          ? 45
          : rsiValue < 60
            ? 55
            : rsiValue < 70
              ? 65
              : 80

  const pcrScore =
    pcrValue > 1.5
      ? 20
      : pcrValue > 1.0
        ? 35
        : pcrValue > 0.8
          ? 55
          : pcrValue > 0.6
            ? 65
            : 80

  const score = Math.round(vixScore * 0.4 + rsiScore * 0.3 + pcrScore * 0.3)

  const label =
    score < 25
      ? 'Extreme Fear'
      : score < 40
        ? 'Fear'
        : score < 55
          ? 'Neutral'
          : score < 70
            ? 'Greed'
            : 'Extreme Greed'

  return { score, label }
}

export function pickBestOptionContract(
  chain: OptionData[],
  direction: 'CE' | 'PE',
  otmSkip = 0,
): {
  strike: number
  instrumentKey: string
  tradingSymbol: string
  price: number
  lotSize: number
} | null {
  if (!chain || chain.length === 0) return null

  const spot = chain[0]?.underlying_spot_price || 0
  if (spot === 0) return null

  // Sort by strike price ascending
  const sorted = [...chain].sort((a, b) => a.strike_price - b.strike_price)

  // Find ATM strike (closest to spot)
  let closestIdx = 0
  let minDiff = Infinity
  for (let i = 0; i < sorted.length; i++) {
    const diff = Math.abs(sorted[i].strike_price - spot)
    if (diff < minDiff) {
      minDiff = diff
      closestIdx = i
    }
  }

  // Calculate target index based on CE / PE and otmSkip
  let targetIdx = closestIdx
  if (direction === 'CE') {
    targetIdx = Math.min(sorted.length - 1, closestIdx + otmSkip)
  } else {
    targetIdx = Math.max(0, closestIdx - otmSkip)
  }

  const selectedRow = sorted[targetIdx]
  if (!selectedRow) return null

  const opt = direction === 'CE' ? selectedRow.call_options : selectedRow.put_options
  if (!opt || !opt.instrument_key) return null

  return {
    strike: selectedRow.strike_price,
    instrumentKey: opt.instrument_key,
    tradingSymbol: opt.trading_symbol || `${direction}_${selectedRow.strike_price}`,
    price: opt.market_data?.ltp || 0,
    lotSize: getLotSizeForSymbol('NIFTY 50'),
  }
}
