import { API_NOTIFY_TELEGRAM } from './constants'

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
  confidence: string
  executionMode: 'paper' | 'live'
  strikePrice?: number
  expiry?: string
  legs: TelegramAlertLeg[]
  maxProfitPct: number
  maxLossPct: number
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
  const lines: string[] = [
    `${icon} ALGO TRADE — ${mode} ENTRY [${alert.symbol}]`,
  ]

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

  lines.push(`Signal: ${alert.signal} · ${alert.confidence} confidence`)
  return lines.join('\n')
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
  const lots =
    alert.lotSize > 0 ? Math.round(alert.quantity / alert.lotSize) : 0
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

/**
 * Sends a trade alert through the Worker's Telegram proxy
 * (`/api/notify/telegram`). Best-effort: resolves to false instead of
 * throwing when the endpoint is unconfigured, unreachable, or rejects the
 * message — callers should log, never block trading on this.
 */
export async function sendTelegramAlert(message: string): Promise<boolean> {
  if (typeof fetch === 'undefined') return false
  try {
    const response = await fetch(API_NOTIFY_TELEGRAM, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    })
    if (!response.ok) return false
    const data = (await response.json().catch(() => null)) as {
      notified?: boolean
    } | null
    return data?.notified === true
  } catch {
    return false
  }
}
