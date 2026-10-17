import { Clock, TrendingDown, TrendingUp, Wallet } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import type { DaemonController } from '@/hooks/useDaemon'
import type { PaperTradeRecord } from '@/lib/types'
import { formatDateTime, formatPaise, isToday } from './format'

function tradeSymbol(trade: PaperTradeRecord): string {
  const value = trade.metadata?.underlyingSymbol
  return typeof value === 'string' ? value : '—'
}

function tradeExitReason(trade: PaperTradeRecord): string {
  const value = trade.metadata?.exitReason
  return typeof value === 'string' ? value : '—'
}

export function DaemonHistoryPage({ daemon }: { daemon: DaemonController }) {
  const user = daemon.status?.userState
  const trades = [...(daemon.status?.paperTrades ?? [])].sort((a, b) =>
    b.openedAt.localeCompare(a.openedAt),
  )

  const closed = trades.filter((t) => t.status === 'CLOSED')
  const wins = closed.filter((t) => (t.realizedPnl ?? 0) > 0).length
  const realizedTotalPaise = closed.reduce(
    (sum, t) => sum + (t.realizedPnl ?? 0),
    0,
  )
  const realizedTodayPaise = closed
    .filter((t) => isToday(t.closedAt))
    .reduce((sum, t) => sum + (t.realizedPnl ?? 0), 0)
  const winRate = closed.length > 0 ? (wins / closed.length) * 100 : null

  return (
    <div className="p-4 space-y-4 max-w-[1600px] mx-auto">
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <SummaryCard
          icon={<Wallet size={14} className="text-primary" />}
          label="Paper balance"
          value={formatPaise(user?.paperBalance)}
          sub={`${trades.length} ledger records`}
        />
        <SummaryCard
          icon={<TrendingUp size={14} className="text-primary" />}
          label="Realized (all time)"
          value={formatPaise(realizedTotalPaise)}
          valueClass={
            realizedTotalPaise >= 0 ? 'text-success' : 'text-destructive'
          }
          sub={`today ${formatPaise(realizedTodayPaise)}`}
        />
        <SummaryCard
          icon={<Clock size={14} className="text-primary" />}
          label="Closed trades"
          value={String(closed.length)}
          sub={`${trades.length} total records`}
        />
        <SummaryCard
          icon={<TrendingDown size={14} className="text-primary" />}
          label="Win rate"
          value={winRate === null ? '—' : `${winRate.toFixed(1)}%`}
          sub={
            closed.length > 0
              ? `${wins} win / ${closed.length - wins} loss`
              : 'no closed trades yet'
          }
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <Clock size={14} className="text-primary" />
            Paper Ledger — daemon SQLite
            <span className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
              {trades.length}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Opened</TableHead>
                <TableHead>Closed</TableHead>
                <TableHead>Symbol</TableHead>
                <TableHead>Side</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">Entry ₹</TableHead>
                <TableHead className="text-right">Exit ₹</TableHead>
                <TableHead className="text-right">P&L</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Exit reason</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {trades.map((trade) => {
                const pnl = trade.realizedPnl
                return (
                  <TableRow key={trade.id}>
                    <TableCell className="text-xs tabular-nums whitespace-nowrap">
                      {formatDateTime(trade.openedAt)}
                    </TableCell>
                    <TableCell className="text-xs tabular-nums whitespace-nowrap">
                      {trade.closedAt ? formatDateTime(trade.closedAt) : '—'}
                    </TableCell>
                    <TableCell className="text-xs">
                      {tradeSymbol(trade)}
                    </TableCell>
                    <TableCell className="text-xs">
                      <span
                        className={`rounded-full border px-2 py-0.5 text-[11px] ${
                          trade.direction === 'CE'
                            ? 'border-success/40 text-success'
                            : 'border-destructive/40 text-destructive'
                        }`}
                      >
                        {trade.direction}
                      </span>
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums">
                      {trade.quantity}
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums">
                      {formatPaise(trade.entryPrice)}
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums">
                      {trade.exitPrice !== undefined
                        ? formatPaise(trade.exitPrice)
                        : '—'}
                    </TableCell>
                    <TableCell
                      className={`text-right text-xs font-semibold tabular-nums ${
                        (pnl ?? 0) >= 0 ? 'text-success' : 'text-destructive'
                      }`}
                    >
                      {pnl !== undefined ? formatPaise(pnl) : '—'}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {trade.status}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {tradeExitReason(trade)}
                    </TableCell>
                  </TableRow>
                )
              })}
              {trades.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={10}
                    className="py-8 text-center text-xs text-muted-foreground"
                  >
                    No paper trades recorded yet — start the daemon in paper
                    mode.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}

function SummaryCard({
  icon,
  label,
  value,
  sub,
  valueClass = '',
}: {
  icon: React.ReactNode
  label: string
  value: string
  sub?: string
  valueClass?: string
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm flex items-center gap-2">
          {icon}
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <p className={`text-lg font-semibold tabular-nums ${valueClass}`}>
          {value}
        </p>
        {sub && (
          <p className="text-[11px] text-muted-foreground tabular-nums">
            {sub}
          </p>
        )}
      </CardContent>
    </Card>
  )
}
