import { useState } from 'react'
import {
  Activity,
  AlertTriangle,
  Play,
  RotateCcw,
  Square,
  TrendingDown,
  TrendingUp,
} from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { ScorePanel } from '@/components/dashboard/strategy/score-panel'
import { IndicatorsPanel } from '@/components/dashboard/strategy/indicators-panel'
import { SimpleChartWidget } from '@/components/dashboard/strategy/simple-chart-widget'
import { LogPanel } from '@/components/dashboard/strategy/log-panel'
import type { DaemonController } from '@/hooks/useDaemon'
import { DAEMON_SYMBOLS } from '@/lib/daemon'
import { DEFAULT_CONFIG } from '@/lib/types'
import type {
  ActivePosition,
  AllSignalData,
  MarketSnapshot,
  PaperTradeRecord,
  StrategyConfig,
  UnderlyingSymbol,
} from '@/lib/types'
import {
  formatAge,
  formatClock,
  formatPaise,
  formatPrice,
  formatRupees,
  isToday,
} from './format'

export function DaemonWindowPage({ daemon }: { daemon: DaemonController }) {
  const [activeSymbol, setActiveSymbol] = useState<UnderlyingSymbol>('NIFTY 50')
  const user = daemon.status?.userState
  const config: StrategyConfig = user?.config ?? DEFAULT_CONFIG
  const snapshots = daemon.status?.snapshots

  const openPositions = user
    ? (Object.entries(user.positions).filter(([, p]) => p !== null) as [
        UnderlyingSymbol,
        ActivePosition,
      ][])
    : []

  const trades = [...(daemon.status?.paperTrades ?? [])].sort((a, b) =>
    b.openedAt.localeCompare(a.openedAt),
  )
  const realizedTodayPaise = trades
    .filter((t) => t.status === 'CLOSED' && isToday(t.closedAt))
    .reduce((sum, t) => sum + (t.realizedPnl ?? 0), 0)

  return (
    <div className="p-4 space-y-4 max-w-[1600px] mx-auto">
      <div className="grid grid-cols-1 xl:grid-cols-4 gap-4">
        <ControlCard daemon={daemon} />
        <AccountCard
          balancePaise={user?.paperBalance}
          realizedTodayPaise={realizedTodayPaise}
          tradesToday={user?.tradesCountToday ?? 0}
          openPositions={openPositions.length}
        />
        <FeedCard daemon={daemon} />
      </div>

      <PositionsCard daemon={daemon} positions={openPositions} />

      <Tabs
        value={activeSymbol}
        onValueChange={(value) => setActiveSymbol(value as UnderlyingSymbol)}
        className="w-full space-y-3"
      >
        <TabsList className="grid w-full grid-cols-3 max-w-md">
          {DAEMON_SYMBOLS.map((symbol) => (
            <TabsTrigger
              key={symbol}
              value={symbol}
              className="flex items-center gap-1.5 text-xs"
            >
              {symbol}
            </TabsTrigger>
          ))}
        </TabsList>
        {DAEMON_SYMBOLS.map((symbol) => (
          <TabsContent
            key={symbol}
            value={symbol}
            className="space-y-3 focus-visible:outline-none"
          >
            <SymbolWorkspace
              symbol={symbol}
              snapshot={snapshots?.[symbol]}
              config={config}
            />
          </TabsContent>
        ))}
      </Tabs>

      <TradesCard trades={trades} />

      <div className="max-h-[420px] overflow-y-auto">
        <LogPanel logs={daemon.logs} onClear={daemon.clearLogs} />
      </div>
    </div>
  )
}

// ── Control + account + feed cards ──────────────────────────────────────────

function ControlCard({ daemon }: { daemon: DaemonController }) {
  const [startMode, setStartMode] = useState<'paper' | 'live'>('paper')
  const user = daemon.status?.userState
  const state = user?.state ?? 'IDLE'

  const stateStyles: Record<string, string> = {
    RUNNING: 'bg-success/15 text-success border-success/40',
    ORDERED: 'bg-warning/15 text-warning border-warning/40',
    IDLE: 'bg-muted text-muted-foreground border-border',
    STOPPED: 'bg-destructive/15 text-destructive border-destructive/40',
  }

  const onReset = () => {
    if (
      window.confirm(
        'Reset the paper account to its starting balance and cancel open paper trades?',
      )
    ) {
      void daemon.resetPaper()
    }
  }

  return (
    <Card className="xl:col-span-2">
      <CardHeader>
        <CardTitle className="text-sm flex items-center gap-2">
          <Activity size={14} className="text-primary" />
          Daemon Control
          <span
            className={`ml-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${stateStyles[state] ?? stateStyles.IDLE}`}
          >
            {state}
          </span>
          <span className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
            {user?.executionMode ?? '—'}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-md border border-border overflow-hidden">
            {(['paper', 'live'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setStartMode(mode)}
                className={`px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer ${
                  startMode === mode
                    ? 'bg-primary/20 text-primary'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {mode}
              </button>
            ))}
          </div>
          <button
            type="button"
            disabled={daemon.busy}
            onClick={() => void daemon.start(startMode)}
            className="flex items-center gap-1.5 rounded-md border border-success/40 bg-success/15 px-3 py-1.5 text-xs font-medium text-success hover:bg-success/25 transition-colors cursor-pointer disabled:opacity-50"
          >
            <Play size={13} />
            Start
          </button>
          <button
            type="button"
            disabled={daemon.busy}
            onClick={() => void daemon.stop()}
            className="flex items-center gap-1.5 rounded-md border border-destructive/40 bg-destructive/15 px-3 py-1.5 text-xs font-medium text-destructive hover:bg-destructive/25 transition-colors cursor-pointer disabled:opacity-50"
          >
            <Square size={13} />
            Stop
          </button>
          <button
            type="button"
            disabled={daemon.busy}
            onClick={onReset}
            className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-accent transition-colors cursor-pointer disabled:opacity-50"
          >
            <RotateCcw size={13} />
            Reset paper
          </button>
        </div>
        {!daemon.connected && (
          <p className="flex items-center gap-1.5 text-[11px] text-warning">
            <AlertTriangle size={12} />
            Daemon link down — commands will fail until it reconnects.
          </p>
        )}
        <p className="text-[11px] text-muted-foreground">
          Token refresh happens in the header (browser OAuth) · daily expiry
          ~03:30 IST. Start (live) places real orders on the Upstox account.
        </p>
      </CardContent>
    </Card>
  )
}

function AccountCard({
  balancePaise,
  realizedTodayPaise,
  tradesToday,
  openPositions,
}: {
  balancePaise: number | undefined
  realizedTodayPaise: number
  tradesToday: number
  openPositions: number
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm flex items-center gap-2">
          <TrendingUp size={14} className="text-primary" />
          Paper Account
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0 space-y-2">
        <div className="flex items-baseline justify-between">
          <span className="text-xs text-muted-foreground">Balance</span>
          <span className="text-sm font-semibold tabular-nums">
            {formatPaise(balancePaise)}
          </span>
        </div>
        <div className="flex items-baseline justify-between">
          <span className="text-xs text-muted-foreground">Realized today</span>
          <span
            className={`text-sm font-semibold tabular-nums ${
              realizedTodayPaise >= 0 ? 'text-success' : 'text-destructive'
            }`}
          >
            {formatPaise(realizedTodayPaise)}
          </span>
        </div>
        <div className="flex items-baseline justify-between">
          <span className="text-xs text-muted-foreground">Trades today</span>
          <span className="text-xs font-medium tabular-nums">
            {tradesToday}
          </span>
        </div>
        <div className="flex items-baseline justify-between">
          <span className="text-xs text-muted-foreground">Open positions</span>
          <span className="text-xs font-medium tabular-nums">
            {openPositions}
          </span>
        </div>
      </CardContent>
    </Card>
  )
}

function FeedCard({ daemon }: { daemon: DaemonController }) {
  const feed = daemon.health?.feed
  const ws = feed?.ws

  const row = (label: string, value: string) => (
    <div className="flex items-baseline justify-between">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-xs font-medium tabular-nums">{value}</span>
    </div>
  )

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm flex items-center gap-2">
          <Activity size={14} className="text-primary" />
          Live Feed
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0 space-y-2">
        {row('Transport', feed?.source ?? '—')}
        {row('Socket state', ws?.state ?? '—')}
        {row('Last message', formatAge(ws?.lastMessageAgeMs))}
        {row('Reconnects', String(ws?.reconnects ?? '—'))}
        {row(
          'Ticks idx / opt',
          `${ws?.ticks.index ?? '—'} / ${ws?.ticks.option ?? '—'}`,
        )}
        {row(
          'Chain calls / fails',
          `${ws?.chain.calls ?? '—'} / ${ws?.chain.failures ?? '—'}`,
        )}
        {row(
          'Option keys',
          ws ? `${ws.optionKeys.current} (peak ${ws.optionKeys.peak})` : '—',
        )}
      </CardContent>
    </Card>
  )
}

// ── Positions ───────────────────────────────────────────────────────────────

function PositionsCard({
  daemon,
  positions,
}: {
  daemon: DaemonController
  positions: [UnderlyingSymbol, ActivePosition][]
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm flex items-center gap-2">
          <TrendingDown size={14} className="text-primary" />
          Open Positions
          <span className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
            {positions.length}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Symbol</TableHead>
              <TableHead>Side</TableHead>
              <TableHead className="text-right">Qty</TableHead>
              <TableHead className="text-right">Entry ₹</TableHead>
              <TableHead className="text-right">Current ₹</TableHead>
              <TableHead className="text-right">Unrealized P&L</TableHead>
              <TableHead className="text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {positions.map(([symbol, pos]) => {
              const pnl = pos.unrealizedPnl ?? 0
              return (
                <TableRow key={symbol}>
                  <TableCell className="text-xs font-medium">
                    {symbol}
                  </TableCell>
                  <TableCell className="text-xs">
                    <span
                      className={`rounded-full border px-2 py-0.5 text-[11px] ${
                        pos.direction === 'CE'
                          ? 'border-success/40 text-success'
                          : 'border-destructive/40 text-destructive'
                      }`}
                    >
                      {pos.direction}
                    </span>
                    <span className="ml-2 text-muted-foreground">
                      {pos.tradeType ?? 'buying'}
                    </span>
                  </TableCell>
                  <TableCell className="text-right text-xs tabular-nums">
                    {pos.quantity}
                  </TableCell>
                  <TableCell className="text-right text-xs tabular-nums">
                    {formatPrice(pos.entryPrice)}
                  </TableCell>
                  <TableCell className="text-right text-xs tabular-nums">
                    {formatPrice(pos.currentPrice ?? pos.entryPrice)}
                  </TableCell>
                  <TableCell
                    className={`text-right text-xs font-semibold tabular-nums ${
                      pnl >= 0 ? 'text-success' : 'text-destructive'
                    }`}
                  >
                    {formatRupees(pnl)}
                  </TableCell>
                  <TableCell className="text-right">
                    <button
                      type="button"
                      disabled={daemon.busy}
                      onClick={() => void daemon.exitPosition(symbol)}
                      className="rounded-md border border-border px-2.5 py-1 text-[11px] text-muted-foreground hover:text-foreground hover:bg-accent transition-colors cursor-pointer disabled:opacity-50"
                    >
                      Exit
                    </button>
                  </TableCell>
                </TableRow>
              )
            })}
            {positions.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={7}
                  className="py-6 text-center text-xs text-muted-foreground"
                >
                  No open positions
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

// ── Per-symbol workspace ────────────────────────────────────────────────────

function SymbolWorkspace({
  symbol,
  snapshot,
  config,
}: {
  symbol: UnderlyingSymbol
  snapshot: MarketSnapshot | undefined
  config: StrategyConfig
}) {
  const indicators = snapshot?.indicators ?? null
  const finalSignal = snapshot?.signal ?? null

  const allSignalData: AllSignalData | null = indicators
    ? {
        v3:
          indicators.ema === 'Buy'
            ? 'buy'
            : indicators.ema === 'Sell'
              ? 'sell'
              : 'hold',
        indicators,
        vrd: snapshot?.vrdData ?? null,
      }
    : null

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Card>
          <CardContent className="pt-4">
            <p className="text-[11px] text-muted-foreground">{symbol} spot</p>
            <p className="text-xl font-semibold tabular-nums">
              {formatPrice(snapshot?.spotPrice)}
            </p>
            <p className="text-[11px] text-muted-foreground mt-1">
              last tick {formatClock(snapshot?.timestamp)}
            </p>
          </CardContent>
        </Card>
        <SignalCard snapshot={snapshot} />
        <Card>
          <CardContent className="pt-4 space-y-1.5">
            <p className="text-[11px] text-muted-foreground">
              Option chain rows
            </p>
            <p className="text-xl font-semibold tabular-nums">
              {snapshot?.optionChain?.length ?? 0}
            </p>
            <p className="text-[11px] text-muted-foreground">
              strikes streamed around ATM (WS window)
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 items-start">
        <ScorePanel
          allSignalData={allSignalData}
          finalSignal={finalSignal}
          config={config}
        />
        <SimpleChartWidget candles={snapshot?.candles ?? []} />
      </div>

      <IndicatorsPanel indicators={indicators} />
      <ChainTable snapshot={snapshot} />
    </div>
  )
}

function SignalCard({ snapshot }: { snapshot: MarketSnapshot | undefined }) {
  const signal = snapshot?.signal
  const styles: Record<string, string> = {
    BUY_CE: 'border-success/40 bg-success/10 text-success',
    BUY_PE: 'border-destructive/40 bg-destructive/10 text-destructive',
    WAIT: 'border-warning/40 bg-warning/10 text-warning',
    NO_TRADE: 'border-border bg-muted/40 text-muted-foreground',
  }

  return (
    <Card
      className={`border ${signal ? styles[signal.signal] : styles.NO_TRADE}`}
    >
      <CardContent className="pt-4 space-y-1">
        <p className="text-[11px] opacity-80">Daemon signal</p>
        <p className="text-xl font-semibold">
          {signal ? signal.signal.replace('_', ' ') : '—'}
        </p>
        {signal && (
          <>
            <p className="text-xs opacity-90">
              confidence:{' '}
              <span className="font-medium">{signal.confidence}</span>
            </p>
            <p className="text-[11px] opacity-80 tabular-nums">
              bull {signal.bullScore} · bear {signal.bearScore} · max{' '}
              {signal.scoreMax}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  )
}

function ChainTable({ snapshot }: { snapshot: MarketSnapshot | undefined }) {
  const chain = snapshot?.optionChain ?? []
  if (chain.length === 0) return null

  const sorted = [...chain].sort((a, b) => a.strike_price - b.strike_price)
  const spot = snapshot?.spotPrice ?? sorted[0]?.underlying_spot_price ?? 0
  let atmIdx = 0
  let best = Infinity
  sorted.forEach((row, i) => {
    const dist = Math.abs(row.strike_price - spot)
    if (dist < best) {
      best = dist
      atmIdx = i
    }
  })
  const window = sorted.slice(Math.max(0, atmIdx - 4), atmIdx + 5)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">
          Option Chain — {splitExpiry(chain[0]?.expiry)} (ATM ± 4)
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="text-right">Strike</TableHead>
              <TableHead className="text-right">CE LTP</TableHead>
              <TableHead className="text-right">CE OI</TableHead>
              <TableHead className="text-right">PE LTP</TableHead>
              <TableHead className="text-right">PE OI</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {window.map((row, i) => {
              const isAtm = Math.max(0, atmIdx - 4) + i === atmIdx
              return (
                <TableRow key={row.strike_price}>
                  <TableCell
                    className={`text-right text-xs tabular-nums ${
                      isAtm ? 'font-semibold text-primary' : ''
                    }`}
                  >
                    {formatPrice(row.strike_price)}
                  </TableCell>
                  <TableCell className="text-right text-xs tabular-nums text-success/90">
                    {formatPrice(row.call_options?.market_data?.ltp)}
                  </TableCell>
                  <TableCell className="text-right text-xs tabular-nums text-muted-foreground">
                    {formatCompact(row.call_options?.market_data?.oi)}
                  </TableCell>
                  <TableCell className="text-right text-xs tabular-nums text-destructive/90">
                    {formatPrice(row.put_options?.market_data?.ltp)}
                  </TableCell>
                  <TableCell className="text-right text-xs tabular-nums text-muted-foreground">
                    {formatCompact(row.put_options?.market_data?.oi)}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

function splitExpiry(expiry: string | undefined): string {
  if (!expiry) return 'front expiry'
  const d = new Date(expiry)
  if (Number.isNaN(d.getTime())) return expiry
  return d.toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: '2-digit',
  })
}

function formatCompact(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '—'
  if (value >= 10_000_000) return `${(value / 10_000_000).toFixed(2)} Cr`
  if (value >= 100_000) return `${(value / 100_000).toFixed(2)} L`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)} K`
  return String(value)
}

// ── Trades ──────────────────────────────────────────────────────────────────

function tradeSymbol(trade: PaperTradeRecord): string {
  const value = trade.metadata?.underlyingSymbol
  return typeof value === 'string' ? value : '—'
}

function TradesCard({ trades }: { trades: PaperTradeRecord[] }) {
  const recent = trades.slice(0, 25)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm flex items-center gap-2">
          <Activity size={14} className="text-primary" />
          Recent Paper Trades
          <span className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
            {trades.length} total
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Opened</TableHead>
              <TableHead>Symbol</TableHead>
              <TableHead>Dir</TableHead>
              <TableHead className="text-right">Qty</TableHead>
              <TableHead className="text-right">Entry ₹</TableHead>
              <TableHead className="text-right">Exit ₹</TableHead>
              <TableHead className="text-right">P&L</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {recent.map((trade) => {
              const pnl = trade.realizedPnl
              return (
                <TableRow key={trade.id}>
                  <TableCell className="text-xs tabular-nums">
                    {formatClock(trade.openedAt)}
                  </TableCell>
                  <TableCell className="text-xs">
                    {tradeSymbol(trade)}
                  </TableCell>
                  <TableCell className="text-xs">{trade.direction}</TableCell>
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
                </TableRow>
              )
            })}
            {recent.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={8}
                  className="py-6 text-center text-xs text-muted-foreground"
                >
                  No paper trades yet
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}
