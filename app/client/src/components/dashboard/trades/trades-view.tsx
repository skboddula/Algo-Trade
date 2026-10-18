// Presentational Live Trades components shared by the cloud dashboard and
// the daemon window. Both pages feed them `LiveTradesDataset` values built
// from their own data sources (see `trades-model.ts`).
import { ArrowDownRight, ArrowUpRight } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn, getSensibullUrl } from '@/lib/utils'
import { getLotSizeForSymbol } from '@/utils/tradeUtils'
import {
  fmtCurrency,
  fmtPct,
  statusLabel,
  statusVariant,
  typeVariant,
  type LiveTradesDataset,
  type StatCard,
  type TradeRow,
} from './trades-model'

export function StatCards({ stats }: { stats: StatCard[] }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
      {stats.map((stat) => (
        <Card key={stat.title} className="relative overflow-hidden">
          <CardHeader>
            <CardTitle>{stat.title}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-end justify-between gap-3">
              <div>
                <p
                  className={cn(
                    'text-2xl font-bold tracking-tight',
                    stat.title === 'Day P&L'
                      ? stat.changeUp
                        ? 'text-success'
                        : 'text-destructive'
                      : 'text-foreground',
                  )}
                >
                  {stat.value}
                </p>
                {stat.subValue && (
                  <p className="text-xs text-muted-foreground mt-1">
                    {stat.subValue}
                  </p>
                )}
                {stat.change && (
                  <div
                    className={cn(
                      'flex items-center gap-0.5 mt-2 text-xs font-medium',
                      stat.changeUp ? 'text-success' : 'text-destructive',
                    )}
                  >
                    {stat.changeUp ? (
                      <ArrowUpRight size={12} />
                    ) : (
                      <ArrowDownRight size={12} />
                    )}
                    {stat.change}
                  </div>
                )}
              </div>
              <div
                className={cn(
                  'flex items-center justify-center w-10 h-10 rounded-lg shrink-0',
                  stat.iconClassName,
                )}
              >
                {stat.icon}
              </div>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

export function TradesTable({
  rows,
  onExit,
}: {
  rows: TradeRow[]
  onExit?: (row: TradeRow) => void | Promise<void>
}) {
  if (rows.length === 0) return null
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Symbol</TableHead>
          <TableHead>Type</TableHead>
          <TableHead className="text-right">Qty</TableHead>
          <TableHead className="text-right">Entry</TableHead>
          <TableHead className="text-right">LTP</TableHead>
          <TableHead className="text-right">P&amp;L</TableHead>
          <TableHead className="text-right">Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          const sensibullUrl = getSensibullUrl(
            row.displaySymbol ?? row.tradingSymbol,
            row.underlyingSymbol,
          )
          return (
            <TableRow key={row.id}>
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
                      {row.displaySymbol ?? row.symbol}
                    </a>
                  ) : (
                    <p>{row.displaySymbol ?? row.symbol}</p>
                  )}
                </div>
                <p className="text-xs text-muted-foreground font-mono">
                  {row.metaInfo ?? `${row.side} · ${row.entryTime}`}
                  {row.displaySymbol && row.displaySymbol !== row.symbol && (
                    <span className="ml-1.5 opacity-70">({row.symbol})</span>
                  )}
                </p>
              </TableCell>
              <TableCell>
                <Badge variant={typeVariant[row.type]}>{row.type}</Badge>
              </TableCell>
              <TableCell className="text-right font-mono text-sm">
                <div>
                  <span>{row.qty}</span>
                  {(() => {
                    const lotSize = getLotSizeForSymbol(row.symbol)
                    if (lotSize > 1 && row.type !== 'EQ') {
                      const lots = Math.round(row.qty / lotSize)
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
                {row.entryPrice === null ? '—' : fmtCurrency(row.entryPrice)}
              </TableCell>
              <TableCell className="text-right font-mono text-sm">
                {row.ltp === null ? '—' : fmtCurrency(row.ltp)}
              </TableCell>
              <TableCell className="text-right">
                {row.pnl === null ? (
                  <span className="text-xs text-muted-foreground">
                    {row.status === 'ACTIVE' ? 'MTM pending' : '—'}
                  </span>
                ) : (
                  <div>
                    <p
                      className={cn(
                        'font-mono text-sm font-medium',
                        row.pnl >= 0 ? 'text-success' : 'text-destructive',
                      )}
                    >
                      {fmtCurrency(row.pnl, true)}
                    </p>
                    {row.pnlPct !== null && (
                      <p
                        className={cn(
                          'text-xs',
                          row.pnl >= 0
                            ? 'text-success/70'
                            : 'text-destructive/70',
                        )}
                      >
                        {fmtPct(row.pnlPct)}
                      </p>
                    )}
                  </div>
                )}
              </TableCell>
              <TableCell className="text-right">
                <div className="flex flex-col items-end gap-2">
                  <Badge variant={statusVariant[row.status]}>
                    {statusLabel[row.status]}
                  </Badge>
                  {row.status === 'ACTIVE' && row.isPaper && onExit && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 text-[10px] px-2 text-destructive border-destructive/20 hover:bg-destructive/10 hover:text-destructive"
                      onClick={() => {
                        void onExit(row)
                      }}
                    >
                      Force Exit
                    </Button>
                  )}
                </div>
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}

export function TradesPanel({
  dataset,
  onExit,
}: {
  dataset: LiveTradesDataset
  onExit?: (row: TradeRow) => void | Promise<void>
}) {
  const label = dataset.mode === 'paper' ? 'paper trades' : 'live orders'
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>
            {dataset.mode === 'paper' ? 'Paper Trades' : 'Live Orders'}
          </CardTitle>
          <span className="text-xs text-muted-foreground">
            {dataset.tradesTodayLabel} today
          </span>
        </div>
      </CardHeader>
      <CardContent className="pt-0 px-0">
        <Tabs defaultValue="open">
          <div className="px-5 mb-2">
            <TabsList>
              <TabsTrigger value="open">
                Open
                <span className="ml-1.5 rounded-full bg-primary/20 px-1.5 py-0.5 text-xs text-primary">
                  {dataset.openRows.length}
                </span>
              </TabsTrigger>
              <TabsTrigger value="closed">
                Closed
                <span className="ml-1.5 rounded-full bg-secondary px-1.5 py-0.5 text-xs text-muted-foreground">
                  {dataset.closedRows.length}
                </span>
              </TabsTrigger>
            </TabsList>
          </div>
          <TabsContent value="open" className="mt-0">
            {dataset.openRows.length > 0 ? (
              <TradesTable rows={dataset.openRows} onExit={onExit} />
            ) : (
              <p className="px-5 pb-5 text-sm text-muted-foreground">
                No open {label} right now.
              </p>
            )}
          </TabsContent>
          <TabsContent value="closed" className="mt-0">
            {dataset.closedRows.length > 0 ? (
              <TradesTable rows={dataset.closedRows} />
            ) : (
              <p className="px-5 pb-5 text-sm text-muted-foreground">
                No closed {label} today.
              </p>
            )}
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  )
}
