import { useState, useEffect, useMemo } from 'react'
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts'
import { TrendingUp, TrendingDown } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { InfoTooltip } from '@/components/ui/tooltip'
import { fetchPaperHistory } from '@/lib/paperTrading'
import type { PaperAccountSummary, PaperTrade } from '@/lib/types'

interface EquityPoint {
  time: string
  timeLabel: string
  balance: number
  cumulativePnl: number
  tradePnl: number
  direction: string
  symbol: string
}

interface EquityStats {
  startBalance: number
  currentBalance: number
  totalPnl: number
  totalPnlPct: number
  totalTrades: number
  wins: number
  losses: number
  winRatePct: number
  maxDrawdownPct: number
  peakBalance: number
  bestTrade: number
  worstTrade: number
}

// NOTE: all values in this component are RUPEES — the Worker API returns
// prices/balances already converted (toRupees), and the daemon-mode mapping
// in live-trades converts paise → rupees before passing them in.

function formatRupees(value: number): string {
  const abs = Math.abs(value)
  const sign = value < 0 ? '−' : ''
  if (abs >= 10000000) return `${sign}₹${(abs / 10000000).toFixed(2)}Cr`
  if (abs >= 100000) return `${sign}₹${(abs / 100000).toFixed(2)}L`
  if (abs >= 1000) return `${sign}₹${(abs / 1000).toFixed(1)}K`
  return `${sign}₹${abs.toFixed(0)}`
}

function formatPct(value: number): string {
  return `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(2)}%`
}

export function EquityCurveChart({
  summaryOverride,
}: {
  /** Daemon mode: pre-fetched account summary in rupees (skips the Worker fetch). */
  summaryOverride?: PaperAccountSummary | null
} = {}) {
  const [trades, setTrades] = useState<PaperTrade[]>([])
  const [accountBalance, setAccountBalance] = useState<number>(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (summaryOverride !== undefined) {
      // Daemon mode: pre-fetched, already in rupees
      setAccountBalance(summaryOverride?.account.balance ?? 0)
      setTrades(summaryOverride?.trades ?? [])
      setLoading(false)
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const summary = await fetchPaperHistory()
        if (cancelled) return
        // The Worker API returns the account balance in RUPEES (toRupees)
        setAccountBalance(summary.account.balance)
        setTrades(summary.trades ?? [])
      } catch (e) {
        if (!cancelled) setError((e as Error).message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [summaryOverride])

  const { equityData, stats } = useMemo(() => {
    const closed = trades
      .filter(
        (t) => t.status === 'CLOSED' && t.realized_pnl !== null && t.closed_at,
      )
      .sort(
        (a, b) =>
          new Date(a.closed_at!).getTime() - new Date(b.closed_at!).getTime(),
      )

    if (closed.length === 0) {
      return {
        equityData: [] as EquityPoint[],
        stats: null as EquityStats | null,
      }
    }

    // Reconstruct the starting balance: current balance minus all realized P&L
    const totalRealizedPnl = closed.reduce(
      (s, t) => s + (t.realized_pnl ?? 0),
      0,
    )
    const startBalance = accountBalance - totalRealizedPnl

    let running = startBalance
    let peak = running
    let maxDrawdownPct = 0
    let wins = 0
    let losses = 0
    let best = 0
    let worst = 0

    const points: EquityPoint[] = [
      {
        time: closed[0].closed_at!,
        timeLabel: 'Start',
        balance: Number(running.toFixed(2)),
        cumulativePnl: 0,
        tradePnl: 0,
        direction: '',
        symbol: '',
      },
    ]

    for (const t of closed) {
      const pnl = t.realized_pnl ?? 0
      running += pnl
      peak = Math.max(peak, running)
      const ddPct = peak > 0 ? ((peak - running) / peak) * 100 : 0
      maxDrawdownPct = Math.max(maxDrawdownPct, ddPct)
      if (pnl > 0) wins++
      else losses++
      best = Math.max(best, pnl)
      worst = Math.min(worst, pnl)

      let meta: { underlyingSymbol?: string } = {}
      try {
        meta = JSON.parse(t.metadata_json ?? '{}') as {
          underlyingSymbol?: string
        }
      } catch {
        // ignore
      }

      const d = new Date(t.closed_at!)
      points.push({
        time: t.closed_at!,
        timeLabel: d.toLocaleDateString('en-IN', {
          day: '2-digit',
          month: 'short',
          hour: '2-digit',
          minute: '2-digit',
        }),
        balance: Number(running.toFixed(2)),
        cumulativePnl: Number((running - startBalance).toFixed(2)),
        tradePnl: Number(pnl.toFixed(2)),
        direction: t.direction,
        symbol: meta.underlyingSymbol ?? '',
      })
    }

    const currentBalance = running
    const totalPnl = currentBalance - startBalance

    return {
      equityData: points,
      stats: {
        startBalance: Number(startBalance.toFixed(2)),
        currentBalance: Number(currentBalance.toFixed(2)),
        totalPnl: Number(totalPnl.toFixed(2)),
        totalPnlPct:
          startBalance > 0
            ? Number(((totalPnl / startBalance) * 100).toFixed(2))
            : 0,
        totalTrades: closed.length,
        wins,
        losses,
        winRatePct:
          closed.length > 0
            ? Number(((wins / closed.length) * 100).toFixed(1))
            : 0,
        maxDrawdownPct: Number(maxDrawdownPct.toFixed(2)),
        peakBalance: Number(peak.toFixed(2)),
        bestTrade: Number(best.toFixed(2)),
        worstTrade: Number(worst.toFixed(2)),
      } satisfies EquityStats,
    }
  }, [trades, accountBalance])

  if (loading) {
    return (
      <Card>
        <CardContent className="pt-6 text-center text-sm text-muted-foreground">
          Loading equity curve...
        </CardContent>
      </Card>
    )
  }

  if (error) {
    return (
      <Card>
        <CardContent className="pt-6 text-center text-sm text-destructive">
          {error}
        </CardContent>
      </Card>
    )
  }

  if (!stats || equityData.length < 2) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <TrendingUp size={14} className="text-primary" />
            Equity Curve
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0 text-center text-xs text-muted-foreground py-8">
          No completed trades yet — the equity curve appears once trades are
          entered and exited.
        </CardContent>
      </Card>
    )
  }

  const isProfitable = stats.totalPnl >= 0
  const areaColor = isProfitable ? '#22c55e' : '#ef4444'
  const startRef = stats.startBalance

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm flex items-center gap-2">
          <TrendingUp size={14} className="text-primary" />
          Equity Curve
          <InfoTooltip content="Cumulative paper account balance after each completed trade. A rising curve means the strategy is profitable; drawdowns (red zones) show losing streaks." />
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0 space-y-3">
        {/* Stats Grid */}
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-2 text-xs">
          <div className="rounded-md border border-border bg-card px-2 py-1.5">
            <p className="text-[9px] text-muted-foreground uppercase">
              Balance
            </p>
            <p className="text-sm font-mono font-semibold">
              {formatRupees(stats.currentBalance)}
            </p>
          </div>
          <div className="rounded-md border border-border bg-card px-2 py-1.5">
            <p className="text-[9px] text-muted-foreground uppercase">
              Total P&L
            </p>
            <p
              className={`text-sm font-mono font-semibold ${
                isProfitable ? 'text-success' : 'text-destructive'
              }`}
            >
              {formatRupees(stats.totalPnl)}
            </p>
          </div>
          <div className="rounded-md border border-border bg-card px-2 py-1.5">
            <p className="text-[9px] text-muted-foreground uppercase">Return</p>
            <p
              className={`text-sm font-mono font-semibold ${
                isProfitable ? 'text-success' : 'text-destructive'
              }`}
            >
              {formatPct(stats.totalPnlPct)}
            </p>
          </div>
          <div className="rounded-md border border-border bg-card px-2 py-1.5">
            <p className="text-[9px] text-muted-foreground uppercase">
              Win Rate
            </p>
            <p className="text-sm font-mono font-semibold">
              {stats.winRatePct}%
              <span className="text-[9px] text-muted-foreground ml-1">
                ({stats.wins}W {stats.losses}L)
              </span>
            </p>
          </div>
          <div className="rounded-md border border-border bg-card px-2 py-1.5">
            <p className="text-[9px] text-muted-foreground uppercase">Max DD</p>
            <p
              className={`text-sm font-mono font-semibold ${
                stats.maxDrawdownPct > 5 ? 'text-destructive' : ''
              }`}
            >
              −{stats.maxDrawdownPct}%
            </p>
          </div>
          <div className="rounded-md border border-border bg-card px-2 py-1.5">
            <p className="text-[9px] text-muted-foreground uppercase">Trades</p>
            <p className="text-sm font-mono font-semibold">
              {stats.totalTrades}
            </p>
          </div>
        </div>

        {/* Chart */}
        <div className="h-48 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart
              data={equityData}
              margin={{ top: 4, right: 8, left: 0, bottom: 0 }}
            >
              <defs>
                <linearGradient id="equityGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={areaColor} stopOpacity={0.3} />
                  <stop
                    offset="100%"
                    stopColor={areaColor}
                    stopOpacity={0.05}
                  />
                </linearGradient>
              </defs>
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="hsl(var(--border))"
                opacity={0.3}
              />
              <XAxis
                dataKey="timeLabel"
                tick={{ fontSize: 9, fill: 'hsl(var(--muted-foreground))' }}
                tickLine={false}
                axisLine={false}
                interval="preserveStartEnd"
                minTickGap={40}
              />
              <YAxis
                tick={{ fontSize: 9, fill: 'hsl(var(--muted-foreground))' }}
                tickLine={false}
                axisLine={false}
                tickFormatter={(v: number) => formatRupees(v)}
                width={55}
                domain={['dataMin - 500', 'dataMax + 500']}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: 'hsl(var(--card))',
                  border: '1px solid hsl(var(--border))',
                  borderRadius: '8px',
                  fontSize: '11px',
                }}
                formatter={(value) =>
                  [formatRupees(Number(value)), 'Balance'] as [string, string]
                }
                labelFormatter={(label) => String(label)}
              />
              <ReferenceLine
                y={startRef}
                stroke="hsl(var(--muted-foreground))"
                strokeDasharray="4 4"
                strokeOpacity={0.4}
              />
              <Area
                type="monotone"
                dataKey="balance"
                stroke={areaColor}
                strokeWidth={1.5}
                fill="url(#equityGradient)"
                dot={{ r: 2, fill: areaColor, strokeWidth: 0 }}
                activeDot={{ r: 4, fill: areaColor, strokeWidth: 0 }}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        {/* Best/Worst */}
        <div className="flex items-center justify-between text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <TrendingUp size={10} className="text-success" />
            Best: {formatRupees(stats.bestTrade)}
          </span>
          <span className="flex items-center gap-1">
            <TrendingDown size={10} className="text-destructive" />
            Worst: {formatRupees(stats.worstTrade)}
          </span>
          <span>Start: {formatRupees(stats.startBalance)}</span>
        </div>
      </CardContent>
    </Card>
  )
}
