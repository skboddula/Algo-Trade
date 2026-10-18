import type { ActivePosition, PaperTradeRecord } from '@/lib/types'
import type {
  HistoryStatementRow,
  HistoryTradeRow,
} from '@/components/dashboard/history/history-view'
import { getLotSizeForSymbol } from '@/utils/tradeUtils'
import { getSensibullUrl } from '@/lib/utils'
import { formatPaise, formatPrice } from './format'

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

function stamp(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    day: '2-digit',
    month: 'short',
  })
}

export interface DaemonHistoryData {
  balanceLabel: string
  openCount: number
  statementRows: HistoryStatementRow[]
  tradeRows: HistoryTradeRow[]
}

/** Convert the daemon ledger into the shared History view model. */
export function buildDaemonHistoryData(
  trades: PaperTradeRecord[],
  positions: Record<string, ActivePosition | null>,
  balancePaise: number,
): DaemonHistoryData {
  const openTrades = trades.filter((t) => t.status === 'OPEN')
  const closedTrades = trades
    .filter((t) => t.status === 'CLOSED' || t.status === 'CANCELLED')
    .sort((a, b) => (b.closedAt ?? '').localeCompare(a.closedAt ?? ''))
  const sorted = [...openTrades]
    .sort((a, b) => b.openedAt.localeCompare(a.openedAt))
    .concat(closedTrades)

  const statementRows: HistoryStatementRow[] = buildStatementRows(
    closedTrades,
    balancePaise,
  ).map((entry) => ({
    id: entry.id,
    timeLabel: new Date(entry.createdAt).toLocaleString('en-IN'),
    type: entry.type,
    amountLabel: signedPaise(entry.amount),
    amountPositive: entry.amount >= 0,
    balanceLabel: formatPaise(entry.balanceAfter),
    note: entry.note,
  }))

  const currentMtmPrice = (trade: PaperTradeRecord): number | null => {
    for (const position of Object.values(positions)) {
      if (!position) continue
      const legs = position.legs ?? []
      const leg = legs.find((l) => l.instrumentKey === trade.instrumentKey)
      if (leg?.currentPrice !== undefined) return leg.currentPrice
      if (
        legs.length === 0 &&
        position.instrumentKey === trade.instrumentKey &&
        position.currentPrice !== undefined
      ) {
        return position.currentPrice
      }
    }
    return null
  }

  const tradeRows: HistoryTradeRow[] = sorted.map((trade) => {
    const { displaySymbol, underlyingSymbol } = tradeDisplay(trade)
    const realized = trade.realizedPnl
    const isOpen = trade.status === 'OPEN'
    const mtmPrice = isOpen ? currentMtmPrice(trade) : null
    const sellSide = metaString(trade.metadata, 'tradeType') === 'selling'
    // Position quotes are rupees; ledger trade prices are paise.
    const mtmPnlRupees =
      mtmPrice !== null
        ? (sellSide
            ? trade.entryPrice / 100 - mtmPrice
            : mtmPrice - trade.entryPrice / 100) * trade.quantity
        : null
    const sensibullUrl = getSensibullUrl(displaySymbol, underlyingSymbol)

    let pnlView: HistoryTradeRow['pnl'] = null
    if (realized !== undefined && realized !== null) {
      pnlView = {
        label: signedPaise(realized),
        positive: realized >= 0,
        mtm: false,
      }
    } else if (mtmPnlRupees !== null) {
      pnlView = {
        label: signedPaise(Math.round(mtmPnlRupees * 100)),
        positive: mtmPnlRupees >= 0,
        mtm: true,
      }
    }

    const exitRupees =
      trade.exitPrice !== undefined ? trade.exitPrice / 100 : null
    return {
      id: trade.id,
      displaySymbol,
      subtext: trade.instrumentKey,
      sensibullUrl: sensibullUrl ?? null,
      direction: trade.direction,
      quantity: trade.quantity,
      lotSize: getLotSizeForSymbol(displaySymbol),
      entryLabel: formatPrice(trade.entryPrice / 100),
      exitLabel:
        exitRupees !== null
          ? formatPrice(exitRupees)
          : mtmPrice !== null
            ? formatPrice(mtmPrice)
            : '—',
      pnl: pnlView,
      status: trade.status,
      openedLabel: stamp(trade.openedAt),
      closedLabel: trade.closedAt ? stamp(trade.closedAt) : '—',
    }
  })

  return {
    balanceLabel: formatPaise(balancePaise),
    openCount: openTrades.length,
    statementRows,
    tradeRows,
  }
}
