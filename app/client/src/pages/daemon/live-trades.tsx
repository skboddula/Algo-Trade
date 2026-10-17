import { useState } from 'react'
import {
  ArrowDownRight,
  ArrowUpRight,
  ExternalLink,
  Info,
  Power,
  RefreshCw,
} from 'lucide-react'
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
import type { DaemonController } from '@/hooks/useDaemon'
import type { DaemonPage } from '@/daemon/DaemonApp'
import type { UnderlyingSymbol } from '@/lib/types'
import { cn, getSensibullOptionChainUrl, getSensibullUrl } from '@/lib/utils'
import { getLotSizeForSymbol } from '@/utils/tradeUtils'
import {
  buildDaemonDataset,
  fmtCurrency,
  fmtPct,
  statusLabel,
  statusVariant,
  typeVariant,
  type DaemonDataset,
  type DaemonTradeRow,
  type StatCard,
  type TradeMode,
} from './live-trades-data'

// ─── Sub-components (cloud markup) ────────────────────────────────────────────

function StatCards({ stats }: { stats: StatCard[] }) {
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

function TradesTable({
  rows,
  onExit,
}: {
  rows: DaemonTradeRow[]
  onExit?: (row: DaemonTradeRow) => void
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
                      onClick={() => onExit(row)}
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

function TradesPanel({
  dataset,
  onExit,
}: {
  dataset: DaemonDataset
  onExit?: (row: DaemonTradeRow) => void
}) {
  const isPaper = dataset.mode === 'paper'
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>{isPaper ? 'Paper Trades' : 'Live Orders'}</CardTitle>
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
                No open {isPaper ? 'paper trades' : 'live orders'} right now.
              </p>
            )}
          </TabsContent>
          <TabsContent value="closed" className="mt-0">
            {dataset.closedRows.length > 0 ? (
              <TradesTable rows={dataset.closedRows} />
            ) : (
              <p className="px-5 pb-5 text-sm text-muted-foreground">
                {isPaper
                  ? 'No closed paper trades today.'
                  : 'Closed live orders live on the Upstox order book — the daemon tracks open positions only.'}
              </p>
            )}
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function DaemonLiveTradesPage({
  daemon,
  onNavigate,
}: {
  daemon: DaemonController
  onNavigate: (page: DaemonPage) => void
}) {
  const [mode, setMode] = useState<TradeMode>(
    () => daemon.status?.userState?.executionMode ?? 'paper',
  )

  const userState = daemon.status?.userState ?? null
  const feed = daemon.health?.feed
  const liveFeed = Boolean(feed && feed.source !== 'mock')
  const dataset = userState
    ? buildDaemonDataset({
        mode,
        userState,
        paperTrades: daemon.status?.paperTrades ?? [],
        liveFeed,
      })
    : null

  const state = userState?.state ?? 'IDLE'
  const running = state === 'RUNNING' || state === 'ORDERED'

  const handleForceExit = (row: DaemonTradeRow) => {
    if (!confirm(`Force exit ${row.displaySymbol ?? row.symbol}?`)) return
    void daemon.exitPosition(
      row.symbol as UnderlyingSymbol,
      'Manual Force Exit',
    )
  }

  return (
    <div className="flex flex-col flex-1 h-full max-h-screen overflow-hidden bg-background">
      <header className="flex-none border-b bg-muted/40 p-4 pb-2">
        <div className="flex flex-col gap-4 max-w-6xl mx-auto">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <h1 className="text-xl font-semibold tracking-tight text-foreground">
                Live Trades
              </h1>
              <p className="text-sm text-muted-foreground mt-0.5">
                Today's open positions and executed orders
              </p>
            </div>
            <div className="flex items-center gap-2">
              <a
                href={getSensibullOptionChainUrl(
                  userState?.config?.underlyingMode,
                )}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-primary bg-primary/10 hover:bg-primary/20 border border-primary/20 rounded-md transition-colors"
                title="Open the option chain in Sensibull"
              >
                <ExternalLink size={13} />
                Option Chain
              </a>
              {/* Mode toggle */}
              <div className="flex rounded-md border border-border overflow-hidden text-sm">
                <button
                  className={cn(
                    'px-3 py-1.5 transition-colors',
                    mode === 'paper'
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:text-foreground hover:bg-sidebar-accent/50',
                  )}
                  onClick={() => setMode('paper')}
                >
                  Paper
                </button>
                <button
                  className={cn(
                    'px-3 py-1.5 transition-colors',
                    mode === 'live'
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:text-foreground hover:bg-sidebar-accent/50',
                  )}
                  onClick={() => setMode('live')}
                >
                  Live
                </button>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => daemon.refresh()}
              >
                <RefreshCw size={14} />
                <span className="ml-1.5">Refresh</span>
              </Button>
            </div>
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-6xl mx-auto flex flex-col gap-6">
          {/* Bot Status Banner */}
          {running ? (
            <div className="rounded-md border border-primary/20 bg-primary/5 px-4 py-3 flex items-center justify-between gap-3 text-sm text-foreground max-w-full">
              <div className="flex items-center gap-2">
                <span className="inline-block w-2 h-2 rounded-full bg-success animate-pulse" />
                <span>
                  Strategy engine is actively running in{' '}
                  <span className="font-semibold uppercase">
                    {userState?.executionMode ?? 'paper'}
                  </span>{' '}
                  mode.
                </span>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="h-8"
                onClick={() => onNavigate('strategies')}
              >
                Manage Strategy
              </Button>
            </div>
          ) : (
            <div className="rounded-md border border-warning/40 bg-warning/10 px-4 py-3 flex items-center justify-between gap-3 text-sm text-foreground max-w-full">
              <div className="flex items-center gap-2">
                <Info size={16} className="text-warning" />
                <span>
                  Automated trading is currently stopped. No live or paper
                  trades are being executed.
                </span>
              </div>
              <Button
                variant="default"
                size="sm"
                className="h-8 bg-warning hover:bg-warning/90 text-warning-foreground"
                onClick={() =>
                  void daemon.start(userState?.executionMode ?? 'paper')
                }
              >
                <Power size={14} className="mr-1.5" />
                Start Strategies
              </Button>
            </div>
          )}

          {/* No token warning (live view without a real feed) */}
          {mode === 'live' && !liveFeed && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive max-w-2xl">
              The daemon is running a mock feed — live orders are not possible.
              Refresh the Upstox token from the Brokers page to go live.
            </div>
          )}

          {/* Daemon error */}
          {userState?.error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive max-w-2xl">
              {userState.error}
            </div>
          )}

          {/* Loading skeleton */}
          {!dataset && (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
              {[0, 1, 2, 3].map((i) => (
                <Card key={i} className="animate-pulse">
                  <CardHeader>
                    <div className="h-4 w-28 rounded bg-muted" />
                  </CardHeader>
                  <CardContent>
                    <div className="h-7 w-24 rounded bg-muted mb-2" />
                    <div className="h-3 w-36 rounded bg-muted" />
                  </CardContent>
                </Card>
              ))}
            </div>
          )}

          {/* Data */}
          {dataset && (
            <>
              <StatCards stats={dataset.stats} />

              {/* Day P&L summary bar */}
              <div
                className={cn(
                  'rounded-md border px-4 py-3 flex items-center justify-between gap-4 text-sm',
                  dataset.pnlTotal >= 0
                    ? 'border-success/30 bg-success/5'
                    : 'border-destructive/30 bg-destructive/5',
                )}
              >
                <div className="flex items-center gap-2">
                  {dataset.pnlTotal >= 0 ? (
                    <ArrowUpRight size={16} className="text-success" />
                  ) : (
                    <ArrowDownRight size={16} className="text-destructive" />
                  )}
                  <span
                    className={cn(
                      'font-semibold',
                      dataset.pnlTotal >= 0
                        ? 'text-success'
                        : 'text-destructive',
                    )}
                  >
                    {fmtCurrency(dataset.pnlTotal, true)}
                  </span>
                  <span className="text-muted-foreground">realized today</span>
                </div>
                <span className="text-xs text-muted-foreground">
                  {dataset.sourceNote}
                </span>
              </div>

              <div className="flex flex-col gap-6 lg:gap-8 pb-12">
                <TradesPanel dataset={dataset} onExit={handleForceExit} />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
