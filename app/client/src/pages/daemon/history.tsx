import type { ActivePosition, PaperTradeRecord } from '@/lib/types'
import { Clock3, Wallet, BarChart3 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
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
import { getLotSizeForSymbol } from '@/utils/tradeUtils'
import { getSensibullUrl } from '@/lib/utils'
import { formatPaise, formatPrice } from './format'
import {
  buildStatementRows,
  metaString,
  signedPaise,
  tradeDisplay,
} from './history-data'

export function DaemonHistoryPage({ daemon }: { daemon: DaemonController }) {
  const userState = daemon.status?.userState
  const trades = daemon.status?.paperTrades ?? []
  const positions = (userState?.positions ?? {}) as Record<
    string,
    ActivePosition | null
  >

  const openTrades = trades.filter((t) => t.status === 'OPEN')
  const closedTrades = trades
    .filter((t) => t.status === 'CLOSED' || t.status === 'CANCELLED')
    .sort((a, b) => (b.closedAt ?? '').localeCompare(a.closedAt ?? ''))
  const sorted = [...openTrades]
    .sort((a, b) => b.openedAt.localeCompare(a.openedAt))
    .concat(closedTrades)

  const balance = userState?.paperBalance ?? 0
  const statementRows = buildStatementRows(closedTrades, balance)

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

  return (
    <div className="flex flex-col gap-5 p-6 min-w-0">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          Trade History
        </h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Daemon paper trading ledger and simulated trade statement
        </p>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <Wallet size={14} className="text-primary" />
              Paper Credit
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0 space-y-2">
            <p className="text-2xl font-semibold tabular-nums text-foreground">
              {formatPaise(balance)}
            </p>
            <p className="text-xs text-muted-foreground">
              Open simulated trades: {openTrades.length}
            </p>
          </CardContent>
        </Card>

        <Card className="xl:col-span-2">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <Clock3 size={14} className="text-primary" />
              Recent Statement
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Balance</TableHead>
                  <TableHead>Note</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {statementRows.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={5}
                      className="text-center text-sm text-muted-foreground py-6"
                    >
                      No settled trades yet
                    </TableCell>
                  </TableRow>
                ) : (
                  statementRows.map((entry) => (
                    <TableRow key={entry.id}>
                      <TableCell className="text-xs text-muted-foreground">
                        {new Date(entry.createdAt).toLocaleString('en-IN')}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="text-xs">
                          {entry.type}
                        </Badge>
                      </TableCell>
                      <TableCell
                        className={`text-xs font-mono ${entry.amount >= 0 ? 'text-success' : 'text-destructive'}`}
                      >
                        {signedPaise(entry.amount)}
                      </TableCell>
                      <TableCell className="text-xs font-mono">
                        {formatPaise(entry.balanceAfter)}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {entry.note}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm flex items-center gap-2">
              <BarChart3 size={14} className="text-primary" />
              Completed Trades
            </CardTitle>
            <span className="text-xs text-muted-foreground">
              {sorted.length} trades
            </span>
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Symbol</TableHead>
                <TableHead>Direction</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">Entry</TableHead>
                <TableHead className="text-right">Exit / MTM</TableHead>
                <TableHead className="text-right">P&amp;L</TableHead>
                <TableHead className="text-right">Status</TableHead>
                <TableHead className="text-right">Opened</TableHead>
                <TableHead className="text-right">Closed</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={9}
                    className="text-center text-sm text-muted-foreground py-6"
                  >
                    No trades found
                  </TableCell>
                </TableRow>
              ) : (
                sorted.map((trade) => {
                  const { displaySymbol, underlyingSymbol } =
                    tradeDisplay(trade)
                  const pnl = trade.realizedPnl
                  const isOpen = trade.status === 'OPEN'
                  const mtmPrice = isOpen ? currentMtmPrice(trade) : null
                  const sellSide =
                    metaString(trade.metadata, 'tradeType') === 'selling'
                  const mtmPnl =
                    mtmPrice !== null
                      ? (sellSide
                          ? trade.entryPrice - mtmPrice
                          : mtmPrice - trade.entryPrice) * trade.quantity
                      : null
                  const sensibullUrl = getSensibullUrl(
                    displaySymbol,
                    underlyingSymbol,
                  )
                  const entryRupees = trade.entryPrice / 100
                  const exitRupees =
                    trade.exitPrice !== undefined ? trade.exitPrice / 100 : null
                  const mtmRupees = mtmPrice

                  return (
                    <TableRow key={trade.id}>
                      <TableCell>
                        <div className="font-medium text-sm">
                          {sensibullUrl ? (
                            <a
                              href={sensibullUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="hover:underline text-primary cursor-pointer text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
                              title="Open in Sensibull"
                            >
                              {displaySymbol}
                            </a>
                          ) : (
                            <p>{displaySymbol}</p>
                          )}
                        </div>
                        <p className="text-[11px] font-mono text-muted-foreground">
                          {trade.instrumentKey}
                        </p>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="text-xs">
                          {trade.direction}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm">
                        <div>
                          <span>{trade.quantity}</span>
                          {(() => {
                            const lotSize = getLotSizeForSymbol(displaySymbol)
                            if (lotSize > 1) {
                              const lots = Math.round(trade.quantity / lotSize)
                              return (
                                <span className="text-[10px] text-muted-foreground ml-1.5 font-normal">
                                  ({lots} {lots > 1 ? 'lots' : 'lot'})
                                </span>
                              )
                            }
                            return null
                          })()}
                        </div>
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm">
                        {formatPrice(entryRupees)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm">
                        {exitRupees !== null
                          ? formatPrice(exitRupees)
                          : mtmRupees !== null
                            ? formatPrice(mtmRupees)
                            : '—'}
                      </TableCell>
                      <TableCell className="text-right">
                        {pnl !== null && pnl !== undefined ? (
                          <span
                            className={`font-mono text-sm font-medium ${pnl >= 0 ? 'text-success' : 'text-destructive'}`}
                          >
                            {signedPaise(pnl)}
                          </span>
                        ) : mtmPnl !== null ? (
                          <div className="flex flex-col items-end">
                            <span
                              className={`font-mono text-sm font-medium ${mtmPnl >= 0 ? 'text-success' : 'text-destructive'}`}
                            >
                              {signedPaise(mtmPnl * 100)}
                            </span>
                            <span className="text-[10px] text-muted-foreground">
                              (MTM)
                            </span>
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            —
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <Badge
                          variant={
                            trade.status === 'CLOSED'
                              ? 'secondary'
                              : trade.status === 'OPEN'
                                ? 'default'
                                : 'outline'
                          }
                        >
                          {trade.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground">
                        {new Date(trade.openedAt).toLocaleString('en-IN', {
                          hour: '2-digit',
                          minute: '2-digit',
                          day: '2-digit',
                          month: 'short',
                        })}
                      </TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground">
                        {trade.closedAt
                          ? new Date(trade.closedAt).toLocaleString('en-IN', {
                              hour: '2-digit',
                              minute: '2-digit',
                              day: '2-digit',
                              month: 'short',
                            })
                          : '—'}
                      </TableCell>
                    </TableRow>
                  )
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
