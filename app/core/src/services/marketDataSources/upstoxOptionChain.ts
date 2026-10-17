// REST option-chain primitives for the live feed path.
//
// The WebSocket V3 feed covers index ticks, but a tradeable option chain
// (strike rows with per-leg instrument keys / ltp / oi / greeks) still comes
// from the Upstox REST API. These helpers look up the nearest expiry once per
// IST day and fetch the chain itself on a short refresh cadence.

import type { OptionData, OptionGreeks } from '../../types'
import { getIndiaTime } from '../../utils/timeUtils'

export interface UpstoxOptionsRequest {
  /** REST base, e.g. https://api.upstox.com/v2 */
  restApiBaseUrl: string
  /** Master access token. */
  token: string
  /** Underlying instrument key, e.g. NSE_INDEX|Nifty 50 */
  instrumentKey: string
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, Accept: 'application/json' }
}

/**
 * Nearest non-past expiry (YYYY-MM-DD) among the active contracts of an underlying.
 * Returns null when the contract list has no upcoming expiry.
 */
export async function fetchNearestExpiry(opts: UpstoxOptionsRequest): Promise<string | null> {
  const res = await fetch(
    `${opts.restApiBaseUrl}/option/contract?instrument_key=${encodeURIComponent(opts.instrumentKey)}`,
    { headers: authHeaders(opts.token) },
  )
  if (!res.ok) throw new Error(`option/contract HTTP ${res.status}`)

  const payload = (await res.json()) as { data?: unknown }
  const rows = Array.isArray(payload?.data) ? payload.data : []
  const expiries = new Set<string>()
  for (const row of rows) {
    const expiry = (row as { expiry?: unknown })?.expiry
    if (typeof expiry === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(expiry)) expiries.add(expiry)
  }

  const today = getIndiaTime().dateString
  const upcoming = [...expiries].filter((expiry) => expiry >= today).sort()
  return upcoming[0] ?? null
}

/** Fetch and map one full option chain (all strikes for the given expiry). */
export async function fetchOptionChain(
  opts: UpstoxOptionsRequest & { expiry: string; fallbackSpotPrice: number },
): Promise<OptionData[]> {
  const res = await fetch(
    `${opts.restApiBaseUrl}/option/chain?instrument_key=${encodeURIComponent(opts.instrumentKey)}&expiry_date=${encodeURIComponent(opts.expiry)}`,
    { headers: authHeaders(opts.token) },
  )
  if (!res.ok) throw new Error(`option/chain HTTP ${res.status}`)

  const payload = (await res.json()) as { data?: unknown }
  const rows = Array.isArray(payload?.data) ? payload.data : []
  const chain: OptionData[] = []
  for (const row of rows) {
    const mapped = mapOptionChainRow(row, opts.expiry, opts.fallbackSpotPrice)
    if (mapped) chain.push(mapped)
  }
  return chain
}

function mapOptionChainRow(row: unknown, fallbackExpiry: string, fallbackSpotPrice: number): OptionData | null {
  const source = row as {
    strike_price?: unknown
    expiry?: unknown
    underlying_spot_price?: unknown
    call_options?: unknown
    put_options?: unknown
  }
  const strike = Number(source?.strike_price)
  if (!Number.isFinite(strike) || strike <= 0) return null

  const call = mapOptionLeg(source?.call_options)
  const put = mapOptionLeg(source?.put_options)
  if (!call || !put) return null

  const spot = Number(source?.underlying_spot_price)
  return {
    expiry: typeof source?.expiry === 'string' && source.expiry ? source.expiry : fallbackExpiry,
    strike_price: strike,
    underlying_spot_price: Number.isFinite(spot) && spot > 0 ? spot : fallbackSpotPrice,
    call_options: call,
    put_options: put,
  }
}

function mapOptionLeg(leg: unknown): OptionData['call_options'] | null {
  const source = leg as {
    instrument_key?: unknown
    trading_symbol?: unknown
    market_data?: unknown
    option_greeks?: unknown
  }
  const instrumentKey = source?.instrument_key
  if (typeof instrumentKey !== 'string' || !instrumentKey) return null

  const marketData = (source?.market_data ?? {}) as { ltp?: unknown; volume?: unknown; oi?: unknown }
  const mapped: OptionData['call_options'] = {
    instrument_key: instrumentKey,
    market_data: {
      ltp: numberOr(marketData.ltp),
      volume: numberOr(marketData.volume),
      oi: numberOr(marketData.oi),
    },
  }
  if (typeof source?.trading_symbol === 'string' && source.trading_symbol) {
    mapped.trading_symbol = source.trading_symbol
  }
  const greeks = mapGreeks(source?.option_greeks)
  if (greeks) mapped.option_greeks = greeks
  return mapped
}

function mapGreeks(raw: unknown): OptionGreeks | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const source = raw as { iv?: unknown; delta?: unknown; theta?: unknown; vega?: unknown; gamma?: unknown }
  return {
    iv: numberOr(source.iv),
    delta: numberOr(source.delta),
    theta: numberOr(source.theta),
    vega: numberOr(source.vega),
    gamma: numberOr(source.gamma),
  }
}

function numberOr(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}
