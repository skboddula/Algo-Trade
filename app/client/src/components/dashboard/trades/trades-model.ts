// Shared Live Trades view model.
//
// Both the cloud dashboard (worker APIs, rupee amounts) and the daemon window
// (SQLite ledger, paise amounts) render the same presentational components
// from `trades-view.tsx`. Each runtime owns its dataset builder and maps its
// own units into this display-ready shape.
import type { ReactNode } from 'react'
import type { ExecutionMode, TradeRowStatus } from '@/lib/types'

export type TradeMode = ExecutionMode

export interface TradeRow {
  id: string
  symbol: string
  displaySymbol?: string
  metaInfo?: string
  type: 'CE' | 'PE' | 'EQ' | 'FUT'
  side: 'BUY' | 'SELL'
  qty: number
  entryPrice: number | null
  ltp: number | null
  pnl: number | null
  pnlPct: number | null
  status: TradeRowStatus
  entryTime: string
  tradingSymbol?: string
  underlyingSymbol?: string
  isPaper?: boolean
}

export interface StatCard {
  title: string
  value: string
  subValue?: string
  change?: string
  changeUp?: boolean
  icon: ReactNode
  iconClassName: string
}

export interface LiveTradesDataset {
  mode: TradeMode
  stats: StatCard[]
  openRows: TradeRow[]
  closedRows: TradeRow[]
  pnlTotal: number
  tradesTodayLabel: string
  sourceNote: string
}

export function fmtCurrency(value: number, signed = false) {
  const absolute = Math.abs(value).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
  if (!signed) return `₹${absolute}`
  if (value > 0) return `+₹${absolute}`
  if (value < 0) return `-₹${absolute}`
  return `₹${absolute}`
}

export function fmtPct(value: number) {
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`
}

export const typeVariant: Record<
  TradeRow['type'],
  'default' | 'destructive' | 'secondary' | 'warning'
> = { CE: 'default', PE: 'destructive', EQ: 'secondary', FUT: 'warning' }

export const statusVariant: Record<
  TradeRowStatus,
  'default' | 'destructive' | 'secondary' | 'success' | 'warning'
> = {
  ACTIVE: 'default',
  CLOSED: 'secondary',
  SL_HIT: 'destructive',
  TARGET_HIT: 'success',
  COMPLETED: 'success',
  CANCELLED: 'secondary',
  REJECTED: 'destructive',
}

export const statusLabel: Record<TradeRowStatus, string> = {
  ACTIVE: 'Active',
  CLOSED: 'Closed',
  SL_HIT: 'SL Hit',
  TARGET_HIT: 'Target',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
  REJECTED: 'Rejected',
}
