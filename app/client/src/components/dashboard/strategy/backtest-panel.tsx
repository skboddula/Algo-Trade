import { useState, useCallback } from 'react'
import { Play, RotateCcw, TrendingUp } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { InfoTooltip } from '@/components/ui/tooltip'
import {
  fetchHistoricalCandles,
  runBacktest,
  getBacktestDefaults,
  type BacktestResult,
} from '@/lib/backtestEngine'
import { getStrategyConfig } from '@/lib/strategyConfig'
import type { UnderlyingSymbol } from '@/lib/types'

const SYMBOLS: { value: UnderlyingSymbol; label: string; key: string }[] = [
  { value: 'NIFTY 50', label: 'NIFTY 50', key: 'NSE_INDEX|Nifty 50' },
  { value: 'BANKNIFTY', label: 'BANKNIFTY', key: 'NSE_INDEX|Nifty Bank' },
  { value: 'FINNIFTY', label: 'FINNIFTY', key: 'NSE_INDEX|Nifty Fin Service' },
]

function daysAgoISO(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() - days)
  return d.toISOString().split('T')[0]
}

function todayISO(): string {
  return new Date().toISOString().split('T')[0]
}

export function BacktestPanel({ token }: { token: string | null }) {
  const [symbol, setSymbol] = useState<UnderlyingSymbol>('NIFTY 50')
  const [fromDate, setFromDate] = useState(daysAgoISO(30))
  const [toDate, setToDate] = useState(todayISO())
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<BacktestResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const handleRun = useCallback(async () => {
    if (!token) {
      setError('No Upstox token available — connect your broker account first.')
      return
    }
    setRunning(true)
    setError(null)
    setResult(null)
    try {
      const sym = SYMBOLS.find((s) => s.value === symbol)
      if (!sym) throw new Error('Invalid symbol')
      const defaults = getBacktestDefaults(symbol)
      const strategyConfig = getStrategyConfig()
      const candles = await fetchHistoricalCandles(
        token,
        sym.key,
        fromDate,
        toDate,
      )
      if (candles.length < 100) {
        throw new Error(
          `Only ${candles.length} candles returned — need at least 100 for indicator warmup. Try a wider date range.`,
        )
      }
      const btResult = runBacktest(candles, {
        symbol,
        instrumentKey: sym.key,
        fromDate,
        toDate,
        token,
        strategy: {
          strongThreshold: strategyConfig.strongThreshold,
          moderateThreshold: strategyConfig.moderateThreshold,
          strongGap: strategyConfig.strongGap,
          moderateGap: strategyConfig.moderateGap,
          minConfidence: strategyConfig.minConfidence,
          maxProfitPct: strategyConfig.maxProfitPct,
          maxLossPct: strategyConfig.maxLossPct,
          trailPct: strategyConfig.trailPct ?? 5,
          otmSkip: strategyConfig.otmSkip,
          lastEntryTime: strategyConfig.lastEntryTime,
          executionMode: 'paper',
          tradeType: strategyConfig.tradeType,
          underlyingMode: strategyConfig.underlyingMode,
        },
        avgOptionPremium: defaults.premium,
        deltaLeverage: defaults.leverage,
        lotSize: defaults.lotSize,
        startingBalance: 10000,
      })
      setResult(btResult)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setRunning(false)
    }
  }, [token, symbol, fromDate, toDate])

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm flex items-center gap-2">
          <TrendingUp size={14} className="text-primary" />
          Strategy Backtest
          <InfoTooltip content="Runs the strategy's technical indicator layer against real historical 1-min candles from Upstox. Simulates option trades with the same exit conditions as the live bot. Read-only — never affects live trading." />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Config Row */}
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 items-end">
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Symbol</label>
            <select
              value={symbol}
              onChange={(e) => setSymbol(e.target.value as UnderlyingSymbol)}
              className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
            >
              {SYMBOLS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">From Date</label>
            <input
              type="date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">To Date</label>
            <input
              type="date"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={() => void handleRun()}
              disabled={running || !token}
              className="flex-1"
            >
              {running ? (
                <>
                  <RotateCcw size={14} className="animate-spin" />
                  Running...
                </>
              ) : (
                <>
                  <Play size={14} />
                  Run Backtest
                </>
              )}
            </Button>
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        )}

        {/* Results */}
        {result && (
          <div className="space-y-4">
            {/* Stats Grid */}
            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3">
              <StatCard
                label="Total Trades"
                value={String(result.totalTrades)}
                sub={`${result.totalSignals} signals`}
              />
              <StatCard
                label="Win Rate"
                value={`${result.winRatePct}%`}
                sub={`${result.winningTrades}W / ${result.losingTrades}L`}
                positive={result.winRatePct >= 50}
                negative={result.winRatePct < 50 && result.totalTrades > 0}
              />
              <StatCard
                label="Net P&L"
                value={`₹${result.netPnl.toFixed(0)}`}
                sub={`Fees: ₹${result.totalFees.toFixed(0)}`}
                positive={result.netPnl > 0}
                negative={result.netPnl < 0}
              />
              <StatCard
                label="ROI"
                value={`${result.roiPct > 0 ? '+' : ''}${result.roiPct}%`}
                sub={`on ₹10,000`}
                positive={result.roiPct > 0}
                negative={result.roiPct < 0}
              />
              <StatCard
                label="Profit Factor"
                value={result.profitFactor.toFixed(2)}
                sub={
                  result.profitFactor >= 1.5
                    ? 'Strong'
                    : result.profitFactor >= 1
                      ? 'Positive'
                      : 'Negative'
                }
                positive={result.profitFactor >= 1}
                negative={result.profitFactor < 1 && result.totalTrades > 0}
              />
              <StatCard
                label="Max Drawdown"
                value={`-${result.maxDrawdownPct}%`}
                sub={`Avg hold: ${result.avgHoldTimeMin}m`}
                negative={result.maxDrawdownPct > 5}
              />
            </div>

            {/* Trade Table */}
            {result.trades.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border text-left text-muted-foreground">
                      <th className="pb-2 pr-4">Signal</th>
                      <th className="pb-2 pr-4">Entry Time</th>
                      <th className="pb-2 pr-4">Exit Time</th>
                      <th className="pb-2 pr-4 text-right">Entry ₹</th>
                      <th className="pb-2 pr-4 text-right">Exit ₹</th>
                      <th className="pb-2 pr-4 text-right">P&L</th>
                      <th className="pb-2 pr-4 text-right">%</th>
                      <th className="pb-2">Exit Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.trades.slice(0, 50).map((trade) => (
                      <tr
                        key={trade.tradeId}
                        className="border-b border-border/50"
                      >
                        <td className="py-1.5 pr-4">
                          <Badge
                            variant={
                              trade.direction === 'CE' ? 'secondary' : 'outline'
                            }
                            className="text-[10px]"
                          >
                            {trade.signal}
                          </Badge>
                        </td>
                        <td className="py-1.5 pr-4 text-muted-foreground">
                          {new Date(trade.entryTime).toLocaleTimeString(
                            'en-IN',
                            {
                              hour: '2-digit',
                              minute: '2-digit',
                            },
                          )}
                        </td>
                        <td className="py-1.5 pr-4 text-muted-foreground">
                          {trade.exitTime
                            ? new Date(trade.exitTime).toLocaleTimeString(
                                'en-IN',
                                {
                                  hour: '2-digit',
                                  minute: '2-digit',
                                },
                              )
                            : '—'}
                        </td>
                        <td className="py-1.5 pr-4 text-right font-mono">
                          {trade.entryPremium.toFixed(1)}
                        </td>
                        <td className="py-1.5 pr-4 text-right font-mono">
                          {trade.exitPremium?.toFixed(1) ?? '—'}
                        </td>
                        <td
                          className={`py-1.5 pr-4 text-right font-mono font-medium ${
                            trade.netPnl >= 0
                              ? 'text-success'
                              : 'text-destructive'
                          }`}
                        >
                          {trade.netPnl >= 0 ? '+' : '−'}₹
                          {Math.abs(trade.netPnl).toFixed(0)}
                        </td>
                        <td
                          className={`py-1.5 pr-4 text-right font-mono ${
                            trade.pnlPct >= 0
                              ? 'text-success'
                              : 'text-destructive'
                          }`}
                        >
                          {trade.pnlPct >= 0 ? '+' : ''}
                          {trade.pnlPct}%
                        </td>
                        <td className="py-1.5 text-muted-foreground">
                          {trade.exitReason}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {result.trades.length > 50 && (
                  <p className="text-[10px] text-muted-foreground mt-2">
                    Showing first 50 of {result.trades.length} trades
                  </p>
                )}
              </div>
            )}

            {/* No trades note */}
            {result.trades.length === 0 && (
              <div className="text-center text-xs text-muted-foreground py-4">
                No trades were generated in this period. The strategy's
                confluence gate (score ≥{' '}
                {result.config.strategy.moderateThreshold} with gap ≥{' '}
                {result.config.strategy.moderateGap}) filtered out all{' '}
                {result.totalSignals} signals. Try a wider date range or lower
                thresholds.
              </div>
            )}
          </div>
        )}

        {/* Not connected */}
        {!token && (
          <div className="text-center text-xs text-muted-foreground py-4">
            Connect your Upstox account on the Broker Accounts page to run
            backtests with real historical data.
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function StatCard({
  label,
  value,
  sub,
  positive,
  negative,
}: {
  label: string
  value: string
  sub?: string
  positive?: boolean
  negative?: boolean
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <p className="text-[10px] text-muted-foreground uppercase tracking-wide">
        {label}
      </p>
      <p
        className={`text-lg font-semibold font-mono ${
          positive ? 'text-success' : negative ? 'text-destructive' : ''
        }`}
      >
        {value}
      </p>
      {sub && <p className="text-[10px] text-muted-foreground">{sub}</p>}
    </div>
  )
}
