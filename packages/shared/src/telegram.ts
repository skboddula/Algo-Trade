/**
 * Telegram alert message builders — the single source of truth for alert
 * wording, shared by the daemon (and available to any other runtime).
 *
 * Ported from the always-on-daemon branch (which kept them in the client);
 * the wording is intentionally identical so both runtimes emit the same
 * texts. Only the transport is daemon-specific — see
 * app/core/src/services/notifier.ts.
 */

export interface TelegramAlertLeg {
  direction: 'CE' | 'PE'
  entryPrice: number
  quantity: number
  lotSize: number
  tradeType: 'buying' | 'selling'
}

export interface TelegramEntryAlert {
  symbol: string
  signal: string
  /** Optional — omitted from the message when unknown. */
  confidence?: string
  executionMode: 'paper' | 'live'
  strikePrice?: number
  expiry?: string
  legs: TelegramAlertLeg[]
  maxProfitPct: number
  maxLossPct: number
  /** Trailing stop context shown in the entry alert, when configured. */
  trailPct?: number
}

export interface TelegramExitAlert {
  symbol: string
  direction: 'CE' | 'PE'
  executionMode: 'paper' | 'live'
  entryPrice: number
  exitPrice: number
  quantity: number
  lotSize: number
  tradeType: 'buying' | 'selling'
  reason: string
  entryTime: string
  exitTime: string
  strikePrice?: number
  expiry?: string
}

export interface TelegramVixAlert {
  vix: number
  threshold: number
}

export interface TelegramDailySummary {
  date: string
  totalTrades: number
  wins: number
  losses: number
  /** ALL MONEY VALUES IN RUPEES (convert paise before calling). */
  realizedPnl: number
  paperBalance: number
  bestTrade?: { symbol: string; direction: string; pnl: number }
  worstTrade?: { symbol: string; direction: string; pnl: number }
  vixLast?: number
}

export interface TelegramDailyLossAlert {
  /** ALL MONEY VALUES IN RUPEES (convert paise before calling). */
  dayPnl: number
  dayStartEquity: number
  limitPct: number
  source: string
}

function fmtNum(value: number): string {
  return value.toFixed(2).replace(/\.00$/, '')
}

/**
 * Builds a copy-ready trade alert message containing every detail needed to
 * mirror the order in any other trading app: instrument, side, strike,
 * entry premium, expiry, quantity, and SL/target levels derived from the
 * configured maxProfitPct / maxLossPct.
 */
export function buildEntryAlertMessage(alert: TelegramEntryAlert): string {
  const mode = alert.executionMode === 'live' ? 'LIVE' : 'PAPER'
  const icon = alert.executionMode === 'live' ? '🔴' : '🟢'
  const lines: string[] = [`${icon} ALGO TRADE — ${mode} ENTRY [${alert.symbol}]`]

  const first = alert.legs[0]
  if (first) {
    const side = first.tradeType === 'selling' ? 'SELL' : 'BUY'
    const name = alert.strikePrice
      ? `${alert.symbol} ${alert.strikePrice} ${first.direction}`
      : first.direction
    lines.push(`${side} ${name} @ ${fmtNum(first.entryPrice)}`)
  }

  for (const leg of alert.legs) {
    const lots = leg.lotSize > 0 ? Math.round(leg.quantity / leg.lotSize) : 0
    lines.push(
      `${leg.direction}: qty ${leg.quantity}${lots > 0 ? ` (${lots} lot${lots > 1 ? 's' : ''})` : ''}`,
    )
  }
  if (alert.expiry) lines.push(`Expiry: ${alert.expiry}`)

  if (first) {
    const selling = first.tradeType === 'selling'
    const sl = selling
      ? first.entryPrice * (1 + alert.maxLossPct / 100)
      : first.entryPrice * (1 - alert.maxLossPct / 100)
    const target = selling
      ? first.entryPrice * (1 - alert.maxProfitPct / 100)
      : first.entryPrice * (1 + alert.maxProfitPct / 100)
    lines.push(
      `SL ≈ ${fmtNum(sl)} (${selling ? '+' : '−'}${fmtNum(alert.maxLossPct)}%) · Target ≈ ${fmtNum(target)} (${selling ? '−' : '+'}${fmtNum(alert.maxProfitPct)}%)`,
    )
  }
  if (alert.trailPct && alert.trailPct > 0) {
    lines.push(`Trail: ${fmtNum(alert.trailPct)}% from peak`)
  }

  lines.push(
    `Signal: ${alert.signal}${alert.confidence ? ` · ${alert.confidence} confidence` : ''}`,
  )
  return lines.join('\n')
}

/** VIX early warning — fired when the critical threshold is crossed. */
export function buildVixAlertMessage(alert: TelegramVixAlert): string {
  return [
    `⚠️ VIX ALERT — India VIX at ${alert.vix.toFixed(1)}`,
    `Hard stop threshold is ${alert.threshold} — entries will be blocked soon.`,
    `Manage your open positions accordingly.`,
  ].join('\n')
}

/** End-of-day summary — all money values must already be in RUPEES. */
export function buildDailySummaryMessage(data: TelegramDailySummary): string {
  const fmt = (v: number) => `${v >= 0 ? '+' : '−'}₹${Math.abs(v).toFixed(2)}`

  const lines = [
    `📊 DAILY SUMMARY — ${data.date}`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `Trades: ${data.totalTrades} | Wins: ${data.wins} | Losses: ${data.losses}`,
    `Realized PnL: ${fmt(data.realizedPnl)}`,
    `Paper Balance: ₹${data.paperBalance.toFixed(2)}`,
  ]
  if (data.bestTrade) {
    lines.push(
      `Best: ${data.bestTrade.symbol} ${data.bestTrade.direction} ${fmt(data.bestTrade.pnl)}`,
    )
  }
  if (data.worstTrade) {
    lines.push(
      `Worst: ${data.worstTrade.symbol} ${data.worstTrade.direction} ${fmt(data.worstTrade.pnl)}`,
    )
  }
  lines.push(`━━━━━━━━━━━━━━━━━━━━`)
  if (data.vixLast !== undefined) {
    lines.push(`VIX (last): ${data.vixLast.toFixed(1)}`)
  }
  return lines.join('\n')
}

/** Daily loss kill switch — new entries are blocked for the rest of the day. */
export function buildDailyLossAlertMessage(alert: TelegramDailyLossAlert): string {
  const lossPct =
    alert.dayStartEquity > 0
      ? Math.abs(alert.dayPnl / alert.dayStartEquity) * 100
      : 0
  return [
    `🛑 DAILY LOSS LIMIT — entries blocked for the rest of the day`,
    `Day P&L: −₹${Math.abs(alert.dayPnl).toFixed(2)} (${lossPct.toFixed(2)}%) · limit −${fmtNum(alert.limitPct)}%`,
    `Base: ₹${alert.dayStartEquity.toFixed(2)} (${alert.source})`,
    `Open positions keep their stops. No new entries until the next trading day.`,
  ].join('\n')
}

/**
 * Builds an exit alert message with realized PnL, exit reason, and duration
 * so the mirrored position in the other trading app can be closed manually.
 */
export function buildExitAlertMessage(alert: TelegramExitAlert): string {
  const mode = alert.executionMode === 'live' ? 'LIVE' : 'PAPER'
  const selling = alert.tradeType === 'selling'
  const pnl = selling
    ? (alert.entryPrice - alert.exitPrice) * alert.quantity
    : (alert.exitPrice - alert.entryPrice) * alert.quantity
  const entryValue = alert.entryPrice * alert.quantity
  const pnlPct = entryValue > 0 ? (pnl / entryValue) * 100 : 0
  const isProfit = pnl >= 0

  const entryMs = new Date(alert.entryTime).getTime()
  const exitMs = new Date(alert.exitTime).getTime()
  const durationMin =
    Number.isFinite(entryMs) && Number.isFinite(exitMs)
      ? Math.max(0, Math.round((exitMs - entryMs) / 60000))
      : null

  const side = selling ? 'BUY (cover)' : 'SELL'
  const lots = alert.lotSize > 0 ? Math.round(alert.quantity / alert.lotSize) : 0
  const instrument = alert.strikePrice
    ? `${alert.symbol} ${alert.strikePrice} ${alert.direction}`
    : `${alert.symbol} ${alert.direction}`

  const lines: string[] = [
    `${isProfit ? '🟢' : '🔴'} ALGO TRADE — ${mode} EXIT [${alert.symbol}]`,
    `${side} ${instrument} @ ${fmtNum(alert.exitPrice)}`,
    `Entry: ${fmtNum(alert.entryPrice)} · Exit: ${fmtNum(alert.exitPrice)}`,
    `Qty ${alert.quantity}${lots > 0 ? ` (${lots} lot${lots > 1 ? 's' : ''})` : ''}`,
  ]
  if (alert.expiry) lines.push(`Expiry: ${alert.expiry}`)
  if (durationMin !== null) {
    lines.push(
      `Duration: ${durationMin < 60 ? `${durationMin} min` : `${Math.floor(durationMin / 60)}h ${durationMin % 60}m`}`,
    )
  }
  lines.push(
    `PnL: ${isProfit ? '+' : '−'}₹${fmtNum(Math.abs(pnl))} (${isProfit ? '+' : '−'}${Math.abs(pnlPct).toFixed(1)}%)`,
  )
  lines.push(`Reason: ${alert.reason}`)
  if (isProfit) {
    lines.push(`✅ Close your mirrored position in the other app.`)
  } else {
    lines.push(`⚠️ Close your mirrored position in the other app.`)
  }
  return lines.join('\n')
}
