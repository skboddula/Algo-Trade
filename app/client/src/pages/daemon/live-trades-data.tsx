// Daemon-side builder for the shared Live Trades view (`trades-view.tsx`).
// Converts the daemon ledger (paise) into the display-ready dataset.
import type {
  ActivePosition,
  PaperTradeRecord,
  TradeRowStatus,
  UserBotState,
} from '@/lib/types'
import { BarChart2, TrendingUp, Wallet, Zap } from 'lucide-react'
import {
  fmtCurrency,
  fmtPct,
  type LiveTradesDataset,
  type StatCard,
  type TradeMode,
  type TradeRow,
} from '@/components/dashboard/trades/trades-model'
import { isToday } from './format'

function timeLabel(isoLike: string | null | undefined) {
  if (!isoLike) return '—'
  const d = new Date(isoLike)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

function metaString(meta: Record<string, unknown> | undefined, key: string) {
  const value = meta?.[key]
  return typeof value === 'string' ? value : undefined
}

// ─── Dataset builders ─────────────────────────────────────────────────────────

function positionPnl(position: ActivePosition): {
  ltp: number | null
  pnl: number | null
  pnlPct: number | null
} {
  let entryValue = 0
  let currentValue = 0
  let pnl: number

  if (position.legs && position.legs.length > 0) {
    pnl = 0
    for (const leg of position.legs) {
      const legCurrent = leg.currentPrice ?? leg.entryPrice
      entryValue += leg.entryPrice * leg.quantity
      currentValue += legCurrent * leg.quantity
      pnl +=
        leg.tradeType === 'selling'
          ? (leg.entryPrice - legCurrent) * leg.quantity
          : (legCurrent - leg.entryPrice) * leg.quantity
    }
  } else {
    const current = position.currentPrice ?? position.entryPrice
    entryValue = position.entryPrice * position.quantity
    currentValue = current * position.quantity
    pnl =
      position.tradeType === 'selling'
        ? (position.entryPrice - current) * position.quantity
        : (current - position.entryPrice) * position.quantity
  }

  const finalPnl = position.unrealizedPnl ?? pnl
  const ltp =
    position.currentPrice ??
    (position.legs?.length
      ? currentValue / Math.max(1, position.quantity)
      : position.entryPrice)
  const pnlPct = entryValue > 0 ? (finalPnl / entryValue) * 100 : null
  return { ltp, pnl: finalPnl, pnlPct }
}

export function buildDaemonDataset({
  mode,
  userState,
  paperTrades,
  liveFeed,
}: {
  mode: TradeMode
  userState: UserBotState | null
  paperTrades: PaperTradeRecord[]
  /** True when the daemon runs a real (non-mock) market feed. */
  liveFeed: boolean
}): LiveTradesDataset {
  const positionEntries = Object.entries(userState?.positions ?? {}).filter(
    (entry): entry is [string, ActivePosition] => entry[1] !== null,
  )

  let committed = 0
  let unrealized = 0
  let openDirections: Record<string, number> = {}

  const openRows: TradeRow[] = positionEntries.map(([symbol, pos]) => {
    const { ltp, pnl, pnlPct } = positionPnl(pos)
    const entryValue = pos.entryPrice * pos.quantity
    committed += entryValue
    unrealized += pnl ?? 0
    openDirections = {
      ...openDirections,
      [pos.direction]: (openDirections[pos.direction] ?? 0) + 1,
    }
    const side: 'BUY' | 'SELL' = pos.tradeType === 'selling' ? 'SELL' : 'BUY'
    const tradeType =
      pos.tradeType === 'both'
        ? 'combo'
        : pos.tradeType === 'selling'
          ? 'selling'
          : 'buying'
    return {
      id: symbol,
      symbol,
      displaySymbol: `${symbol} ${pos.direction}`,
      metaInfo: `${side} · ${timeLabel(pos.entryTime)} · ${tradeType}`,
      type: pos.direction,
      side,
      qty: pos.quantity,
      entryPrice: pos.entryPrice,
      ltp,
      pnl,
      pnlPct,
      status: 'ACTIVE',
      entryTime: timeLabel(pos.entryTime),
      underlyingSymbol: symbol,
      isPaper: mode === 'paper',
    } satisfies TradeRow
  })

  const closedTrades = paperTrades.filter(
    (t) =>
      (t.status === 'CLOSED' || t.status === 'CANCELLED') &&
      isToday(t.closedAt),
  )
  const realizedToday =
    closedTrades.reduce((sum, t) => sum + (t.realizedPnl ?? 0), 0) / 100

  const closedRows: TradeRow[] = closedTrades
    .map((trade) => {
      const meta = trade.metadata
      const underlying = metaString(meta, 'underlyingSymbol') ?? 'NIFTY'
      const tradeType = metaString(meta, 'tradeType') ?? 'buying'
      const entryPrice = (trade.entryPrice ?? 0) / 100
      const exitPrice =
        trade.exitPrice !== undefined ? trade.exitPrice / 100 : null
      const pnl =
        trade.realizedPnl !== undefined ? trade.realizedPnl / 100 : null
      const pnlPct =
        trade.entryValue > 0 && trade.realizedPnl !== undefined
          ? (trade.realizedPnl / trade.entryValue) * 100
          : null
      const status: TradeRowStatus =
        trade.status === 'CANCELLED'
          ? 'CANCELLED'
          : pnl !== null && pnl > 0
            ? 'TARGET_HIT'
            : pnl !== null && pnl < 0
              ? 'SL_HIT'
              : 'CLOSED'
      return {
        id: trade.id,
        symbol: trade.instrumentKey,
        displaySymbol: `${underlying} ${trade.direction}`,
        metaInfo: `${tradeType === 'selling' ? 'SELL' : 'BUY'} · ${timeLabel(trade.openedAt)} · closed ${timeLabel(trade.closedAt)}`,
        type: trade.direction,
        side: tradeType === 'selling' ? 'SELL' : 'BUY',
        qty: trade.quantity,
        entryPrice,
        ltp: exitPrice,
        pnl,
        pnlPct,
        status,
        entryTime: timeLabel(trade.openedAt),
        underlyingSymbol: underlying,
      } satisfies TradeRow
    })
    .sort((a, b) => (b.entryTime > a.entryTime ? 1 : -1))

  const balance = (userState?.paperBalance ?? 0) / 100
  const dayPnl = realizedToday + unrealized
  const portfolioValue = balance + committed + unrealized

  const wins = closedTrades.filter((t) => (t.realizedPnl ?? 0) > 0).length
  const losses = closedTrades.filter((t) => (t.realizedPnl ?? 0) < 0).length
  const winRate =
    closedTrades.length > 0 ? (wins / closedTrades.length) * 100 : 0

  const directionBreakdown = Object.entries(openDirections)
    .map(([d, c]) => `${c} ${d}`)
    .join(' · ')

  const positionCard: StatCard =
    mode === 'live'
      ? {
          title: 'Open Orders',
          value: String(openRows.length),
          subValue:
            openRows.length > 0
              ? `${openRows.reduce((s, r) => s + r.qty, 0)} qty active now`
              : 'No open live orders',
          change: directionBreakdown,
          changeUp: true,
          icon: <Zap size={18} />,
          iconClassName: 'text-warning bg-warning/15',
        }
      : {
          title: 'Open Positions',
          value: String(openRows.length),
          subValue:
            committed > 0
              ? `At cost: ${fmtCurrency(committed)}`
              : 'No open paper trades',
          change: directionBreakdown || 'Waiting for paper entries',
          changeUp: true,
          icon: <Zap size={18} />,
          iconClassName: 'text-warning bg-warning/15',
        }

  const fourthCard: StatCard =
    mode === 'live'
      ? {
          title: 'Trades Today',
          value: String(userState?.tradesCountToday ?? 0),
          subValue: `${closedTrades.length} closed today`,
          change:
            closedTrades.length > 0
              ? `${wins}W · ${losses}L`
              : 'No closed trades today',
          changeUp: winRate >= 50,
          icon: <BarChart2 size={18} />,
          iconClassName: 'text-primary bg-primary/15',
        }
      : {
          title: 'Win Rate',
          value: closedTrades.length > 0 ? `${winRate.toFixed(1)}%` : '—',
          subValue: `${closedTrades.length} closed today`,
          change: closedTrades.length > 0 ? `${wins}W · ${losses}L` : '',
          changeUp: winRate >= 50,
          icon: <BarChart2 size={18} />,
          iconClassName: 'text-primary bg-primary/15',
        }

  return {
    mode,
    stats: [
      {
        title: 'Portfolio Value',
        value: fmtCurrency(portfolioValue),
        subValue: `Available: ${fmtCurrency(balance)}`,
        change:
          committed > 0
            ? `Committed: ${fmtCurrency(committed)}`
            : 'No open capital committed',
        changeUp: true,
        icon: <Wallet size={18} />,
        iconClassName: 'text-primary bg-primary/15',
      },
      {
        title: 'Day P&L',
        value: fmtCurrency(dayPnl, true),
        subValue: `Realised: ${fmtCurrency(realizedToday, true)}`,
        change:
          portfolioValue > 0
            ? `${fmtPct((dayPnl / portfolioValue) * 100)} of portfolio`
            : '',
        changeUp: dayPnl >= 0,
        icon: <TrendingUp size={18} />,
        iconClassName:
          dayPnl >= 0
            ? 'text-success bg-success/15'
            : 'text-destructive bg-destructive/15',
      },
      positionCard,
      fourthCard,
    ],
    openRows,
    closedRows: mode === 'live' ? [] : closedRows,
    pnlTotal: dayPnl,
    tradesTodayLabel:
      mode === 'live'
        ? `${openRows.length} live position${openRows.length === 1 ? '' : 's'}`
        : `${openRows.length + closedTrades.length} paper trades`,
    sourceNote: liveFeed
      ? 'Daemon ledger (SQLite), marked to market from the live feed. Live order history lives on Upstox.'
      : 'Daemon ledger (SQLite) in mock mode. Live order history lives on Upstox.',
  }
}
