import type { PaperTradeRecord } from '@/lib/types'
import { formatPaise } from './format'

export function signedPaise(paise: number): string {
  const formatted = formatPaise(paise)
  return paise > 0 ? `+${formatted}` : formatted
}

export function metaString(
  meta: Record<string, unknown> | undefined,
  key: string,
) {
  const value = meta?.[key]
  return typeof value === 'string' ? value : undefined
}

export interface TradeDisplay {
  displaySymbol: string
  underlyingSymbol?: string
}

export function tradeDisplay(trade: PaperTradeRecord): TradeDisplay {
  const underlying = metaString(trade.metadata, 'underlyingSymbol')
  const tradingSymbol = metaString(trade.metadata, 'tradingSymbol')
  if (tradingSymbol) {
    return { displaySymbol: tradingSymbol, underlyingSymbol: underlying }
  }
  const compact = trade.instrumentKey.split('|').pop() ?? trade.instrumentKey
  return {
    displaySymbol: underlying
      ? `${underlying} ${trade.direction} (${compact})`
      : `${compact} ${trade.direction}`,
    underlyingSymbol: underlying,
  }
}

export interface StatementRow {
  id: string
  createdAt: string
  type: 'SETTLE' | 'CANCEL'
  amount: number
  balanceAfter: number
  note: string
}

/**
 * Running statement: walk closes newest → oldest, starting from the current
 * paper balance, so each row shows the balance right after that settlement.
 */
export function buildStatementRows(
  closedTrades: PaperTradeRecord[],
  balancePaise: number,
  limit = 15,
): StatementRow[] {
  let running = balancePaise
  return closedTrades.slice(0, limit).map((trade) => {
    const row: StatementRow = {
      id: trade.id,
      createdAt: trade.closedAt ?? trade.openedAt,
      type: trade.status === 'CANCELLED' ? 'CANCEL' : 'SETTLE',
      amount: trade.realizedPnl ?? 0,
      balanceAfter: running,
      note: `${tradeDisplay(trade).displaySymbol} · ${trade.direction}`,
    }
    running -= trade.realizedPnl ?? 0
    return row
  })
}
