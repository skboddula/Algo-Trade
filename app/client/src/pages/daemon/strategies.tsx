import type {
  AllSignalData,
  StrategyConfig,
  UnderlyingSymbol,
} from '@/lib/types'
import { DEFAULT_CONFIG } from '@/lib/types'
import type { DaemonController } from '@/hooks/useDaemon'
import { DAEMON_SYMBOLS } from '@/lib/daemon'
import { useState } from 'react'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Activity, BarChart3, Settings } from 'lucide-react'

import { StrategyHeaderBar } from '@/components/dashboard/strategy/strategy-header-bar'
import { MarketSetupPanel } from '@/components/dashboard/strategy/market-setup-panel'
import { GlobalMarketsPanel } from '@/components/dashboard/strategy/global-markets-panel'
import { SimpleChartWidget } from '@/components/dashboard/strategy/simple-chart-widget'
import { InstitutionalPanel } from '@/components/dashboard/strategy/institutional-panel'
import { BreadthPanel } from '@/components/dashboard/strategy/breadth-panel'
import { IndicatorsPanel } from '@/components/dashboard/strategy/indicators-panel'
import { ScorePanel } from '@/components/dashboard/strategy/score-panel'
import { BotControls } from '@/components/dashboard/strategy/bot-controls'
import { StrategyConfig as StrategyConfigPanel } from '@/components/dashboard/strategy/strategy-config'
import { LogPanel } from '@/components/dashboard/strategy/log-panel'
import { SourceStatusBar } from '@/components/dashboard/strategy/source-status-bar'
import { NewsAlertsPanel } from '@/components/dashboard/strategy/news-alerts-panel'
import { ThresholdOptimizer } from '@/components/dashboard/strategy/threshold-optimizer'
import { DailyBacktestReport } from '@/components/dashboard/strategy/daily-backtest-report'
import { formatClock } from './format'
import { deriveSourceStatus } from './source-status'

export function DaemonStrategiesPage({ daemon }: { daemon: DaemonController }) {
  const [activeSymbol, setActiveSymbol] = useState<UnderlyingSymbol>('NIFTY 50')
  const [activeTab, setActiveTab] = useState<string>('operations')

  const userState = daemon.status?.userState
  const config: StrategyConfig = userState?.config ?? DEFAULT_CONFIG
  const snapshot = daemon.status?.snapshots?.[activeSymbol]
  const vrdData = snapshot?.vrdData ?? null
  const liveFeed = Boolean(
    daemon.health?.feed && daemon.health.feed.source !== 'mock',
  )

  const allSignalData: AllSignalData | null = snapshot?.indicators
    ? {
        v3:
          snapshot.indicators.ema === 'Buy'
            ? 'buy'
            : snapshot.indicators.ema === 'Sell'
              ? 'sell'
              : 'hold',
        indicators: snapshot.indicators,
        vrd: snapshot.vrdData ?? null,
      }
    : null

  const errorLogsCount = daemon.logs.filter((l) => l.level === 'error').length

  return (
    <div className="p-4 space-y-4 max-w-[1600px] mx-auto">
      {/* Sticky Execution Control Header */}
      <StrategyHeaderBar
        underlyingMode={config.underlyingMode}
        state={userState?.state ?? 'IDLE'}
        position={userState?.positions?.[activeSymbol] ?? null}
        tradesCount={userState?.tradesCountToday ?? 0}
        lastUpdated={userState ? formatClock(userState.updatedAt) : null}
        pollingIntervalSec={config.pollingIntervalSec}
        start={() => void daemon.start(config.executionMode)}
        stop={() => void daemon.stop()}
        executionMode={config.executionMode}
        paperBalance={(userState?.paperBalance ?? 0) / 100}
        token={liveFeed ? 'daemon-master-token' : null}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        logErrorCount={errorLogsCount}
      />

      {/* Data feed status */}
      <SourceStatusBar
        sourceStatus={deriveSourceStatus(daemon.health, vrdData)}
      />

      {/* Symbol workspace selector (daemon streams all symbols in parallel) */}
      <Tabs
        value={activeSymbol}
        onValueChange={(value) => setActiveSymbol(value as UnderlyingSymbol)}
        className="w-full"
      >
        <TabsList className="grid w-full grid-cols-3 max-w-md">
          {DAEMON_SYMBOLS.map((symbol) => (
            <TabsTrigger key={symbol} value={symbol} className="text-xs">
              {symbol}
            </TabsTrigger>
          ))}
        </TabsList>

        {/* Main Tabbed Workspaces */}
        <Tabs
          value={activeTab}
          onValueChange={setActiveTab}
          className="w-full space-y-4 mt-4"
        >
          <TabsList className="grid w-full grid-cols-3 max-w-md">
            <TabsTrigger
              value="operations"
              className="flex items-center gap-1.5 text-xs"
            >
              <Activity size={14} />
              <span>Live Operations</span>
            </TabsTrigger>
            <TabsTrigger
              value="signals"
              className="flex items-center gap-1.5 text-xs"
            >
              <BarChart3 size={14} />
              <span>Market Signals</span>
            </TabsTrigger>
            <TabsTrigger
              value="config"
              className="flex items-center gap-1.5 text-xs"
            >
              <Settings size={14} />
              <span>Config &amp; Tuning</span>
            </TabsTrigger>
          </TabsList>

          {/* ── TAB 1: Live Operations ─────────────────────────────────────── */}
          <TabsContent
            value="operations"
            className="space-y-4 focus-visible:outline-none"
          >
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
              <div className="lg:col-span-4">
                <BotControls
                  state={userState?.state ?? 'IDLE'}
                  position={userState?.positions?.[activeSymbol] ?? null}
                  tradesCount={userState?.tradesCountToday ?? 0}
                  lastUpdated={
                    userState ? formatClock(userState.updatedAt) : null
                  }
                  error={userState?.error ?? null}
                  pollingIntervalSec={config.pollingIntervalSec}
                  start={() => void daemon.start(config.executionMode)}
                  stop={() => void daemon.stop()}
                  executionMode={config.executionMode}
                  paperBalance={(userState?.paperBalance ?? 0) / 100}
                />
              </div>
              <div className="lg:col-span-8">
                <LogPanel logs={daemon.logs} onClear={daemon.clearLogs} />
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-stretch">
              <div className="lg:col-span-7">
                <ScorePanel
                  allSignalData={allSignalData}
                  finalSignal={snapshot?.signal ?? null}
                  config={config}
                />
              </div>
              <div className="lg:col-span-5 space-y-4 flex flex-col justify-between">
                <MarketSetupPanel vrdData={vrdData} />
                <SimpleChartWidget candles={snapshot?.candles ?? []} />
              </div>
            </div>
          </TabsContent>

          {/* ── TAB 2: Market Signals & Analytics ──────────────────────────── */}
          <TabsContent
            value="signals"
            className="space-y-4 focus-visible:outline-none"
          >
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-stretch">
              <div className="lg:col-span-9 h-full">
                <MarketSetupPanel vrdData={vrdData} />
              </div>
              <div className="lg:col-span-3 h-full">
                <SimpleChartWidget candles={snapshot?.candles ?? []} />
              </div>
            </div>

            <IndicatorsPanel indicators={snapshot?.indicators ?? null} />

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <InstitutionalPanel vrdData={vrdData} />
              <BreadthPanel
                vrdData={vrdData}
                underlyingMode={config.underlyingMode}
              />
            </div>

            <GlobalMarketsPanel globalIndices={null} />
            <NewsAlertsPanel alerts={vrdData?.newsAlerts} />
          </TabsContent>

          {/* ── TAB 3: Strategy Config & Tuning ────────────────────────────── */}
          <TabsContent
            value="config"
            className="space-y-4 focus-visible:outline-none"
          >
            <DailyBacktestReport />
            <StrategyConfigPanel
              config={config}
              onSave={(next) => void daemon.saveConfig(next)}
            />
            <ThresholdOptimizer
              config={config}
              onApply={(values) => {
                const next = { ...config, ...values }
                void daemon.saveConfig(next)
              }}
            />
          </TabsContent>
        </Tabs>
      </Tabs>
    </div>
  )
}
