// Presentational Trade History view shared by the cloud dashboard and the
// daemon window. Pages build display-ready rows from their own data sources.
import { BarChart3, Clock3, Wallet } from 'lucide-react'
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

export interface HistoryStatementRow {
  id: string
  timeLabel: string
  type: string
  amountLabel: string
  amountPositive: boolean
  balanceLabel: string
  note: string
}

export interface HistoryTradeRow {
  id: string
  displaySymbol: string
  /** Raw instrument line under the symbol; hidden when null. */
  subtext: string | null
  sensibullUrl: string | null
  direction: string
  quantity: number
  /** Contract lot size; lots are shown when greater than 1. */
  lotSize: number | null
  entryLabel: string
  exitLabel: string
  /** Realized or mark-to-market P&L cell; null renders an em dash. */
  pnl: { label: string; positive: boolean; mtm: boolean } | null
  status: string
  openedLabel: string
  closedLabel: string
}

export interface HistoryViewProps {
  subtitle: string
  error?: string | null
  balance: string
  openCount: number
  statementRows: HistoryStatementRow[]
  /** When set, shown in place of an empty statement table. */
  statementEmptyMessage?: string
  tradeRows: HistoryTradeRow[]
}

export function HistoryView({
  subtitle,
  error,
  balance,
  openCount,
  statementRows,
  statementEmptyMessage,
  tradeRows,
}: HistoryViewProps) {
  return (
    <div className="flex flex-col gap-5 p-6 min-w-0">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          Trade History
        </h1>
        <p className="text-sm text-muted-foreground mt-0.5">{subtitle}</p>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive max-w-2xl">
          {error}
        </div>
      )}

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
              {balance}
            </p>
            <p className="text-xs text-muted-foreground">
              Open simulated trades: {openCount}
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
                {statementRows.length === 0 && statementEmptyMessage ? (
                  <TableRow>
                    <TableCell
                      colSpan={5}
                      className="text-center text-sm text-muted-foreground py-6"
                    >
                      {statementEmptyMessage}
                    </TableCell>
                  </TableRow>
                ) : (
                  statementRows.map((entry) => (
                    <TableRow key={entry.id}>
                      <TableCell className="text-xs text-muted-foreground">
                        {entry.timeLabel}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="text-xs">
                          {entry.type}
                        </Badge>
                      </TableCell>
                      <TableCell
                        className={`text-xs font-mono ${entry.amountPositive ? 'text-success' : 'text-destructive'}`}
                      >
                        {entry.amountLabel}
                      </TableCell>
                      <TableCell className="text-xs font-mono">
                        {entry.balanceLabel}
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
              {tradeRows.length} trades
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
              {tradeRows.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={9}
                    className="text-center text-sm text-muted-foreground py-6"
                  >
                    No trades found
                  </TableCell>
                </TableRow>
              ) : (
                tradeRows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell>
                      <div className="font-medium text-sm">
                        {row.sensibullUrl ? (
                          <a
                            href={row.sensibullUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="hover:underline text-primary cursor-pointer text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
                            title="Open in Sensibull"
                          >
                            {row.displaySymbol}
                          </a>
                        ) : (
                          <p>{row.displaySymbol}</p>
                        )}
                      </div>
                      {row.subtext && (
                        <p className="text-[11px] font-mono text-muted-foreground">
                          {row.subtext}
                        </p>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-xs">
                        {row.direction}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">
                      <div>
                        <span>{row.quantity}</span>
                        {row.lotSize !== null &&
                          row.lotSize > 1 &&
                          (() => {
                            const lots = Math.round(row.quantity / row.lotSize)
                            return (
                              <span className="text-[10px] text-muted-foreground ml-1.5 font-normal">
                                ({lots} {lots > 1 ? 'lots' : 'lot'})
                              </span>
                            )
                          })()}
                      </div>
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">
                      {row.entryLabel}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">
                      {row.exitLabel}
                    </TableCell>
                    <TableCell className="text-right">
                      {row.pnl !== null ? (
                        row.pnl.mtm ? (
                          <div className="flex flex-col items-end">
                            <span
                              className={`font-mono text-sm font-medium ${row.pnl.positive ? 'text-success' : 'text-destructive'}`}
                            >
                              {row.pnl.label}
                            </span>
                            <span className="text-[10px] text-muted-foreground">
                              (MTM)
                            </span>
                          </div>
                        ) : (
                          <span
                            className={`font-mono text-sm font-medium ${row.pnl.positive ? 'text-success' : 'text-destructive'}`}
                          >
                            {row.pnl.label}
                          </span>
                        )
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <Badge
                        variant={
                          row.status === 'CLOSED'
                            ? 'secondary'
                            : row.status === 'OPEN'
                              ? 'default'
                              : 'outline'
                        }
                      >
                        {row.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground">
                      {row.openedLabel}
                    </TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground">
                      {row.closedLabel}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
