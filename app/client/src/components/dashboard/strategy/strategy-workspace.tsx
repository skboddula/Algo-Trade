// The shared Strategy workspace: identical layout for the cloud dashboard
// (browser engine / worker) and the daemon window (socket + REST). Each page
// is a thin adapter that maps its controller onto this typed view contract.
import { useState } from 'react'
import { Activity, BarChart3, Settings } from 'lucide-react'
import type {
  ActivePosition,
  AllSignalData,
  Candle,
  ExecutionMode,
  FinalSignal,
  IndicatorsResult,
  StrategyConfig,
  UnderlyingSymbol,
  VrdData,
} from '@/lib/types'
import type { BotState } from '@/hooks/useBotState'
import type { BotLog, GlobalIndexItem, SourceStatus } from '@/lib/marketService'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { StrategyHeaderBar } from './strategy-header-bar'
import { HardStopBanner } from './hard-stop-banner'
import { MarketSetupPanel } from './market-setup-panel'
import { GlobalMarketsPanel } from './global-markets-panel'
import { SimpleChartWidget } from './simple-chart-widget'
import { InstitutionalPanel } from './institutional-panel'
import { BreadthPanel } from './breadth-panel'
import { IndicatorsPanel } from './indicators-panel'
import { ScorePanel } from './score-panel'
import { BotControls } from './bot-controls'
import { StrategyConfig as StrategyConfigPanel } from './strategy-config'
import { LogPanel } from './log-panel'
import { SourceStatusBar } from './source-status-bar'
import { NewsAlertsPanel } from './news-alerts-panel'
import { ThresholdOptimizer } from './threshold-optimizer'
import { DailyBacktestReport } from './daily-backtest-report'

export interface StrategyWorkspaceProps {
  // Execution header + bot controls
  state: BotState
  position: ActivePosition | null
  tradesCount: number
  lastUpdated: string | null
  error: string | null
  pollingIntervalSec: number
  executionMode: ExecutionMode
  paperBalance: number | null
  token: string | null
  start: () => void
  stop: () => void

  // Data feed + market data for the active symbol
  sourceStatus: Record<string, SourceStatus>
  hardStop?: { blocked: boolean; reasons: string[] } | null
  allSignalData: AllSignalData | null
  finalSignal: FinalSignal | null
  candles: Candle[]
  vrdData: VrdData | null
  indicators: IndicatorsResult | null
  globalIndices: GlobalIndexItem[] | null

  /** Multi-symbol runtimes (the daemon streams every symbol) add a selector. */
  symbolSelector?: {
    symbols: readonly UnderlyingSymbol[]
    value: UnderlyingSymbol
    onChange: (symbol: UnderlyingSymbol) => void
  }

  // Logs
  logs: BotLog[]
  onClearLogs: () => void

  // Strategy config & tuning
  config: StrategyConfig
  onSaveConfig: (next: StrategyConfig) => void
  onApplyThresholds: (
    values: Pick<
      StrategyConfig,
      'strongThreshold' | 'moderateThreshold' | 'strongGap' | 'moderateGap'
    >,
  ) => void
}

export function StrategyWorkspace({
  state,
  position,
  tradesCount,
  lastUpdated,
  error,
  pollingIntervalSec,
  executionMode,
  paperBalance,
  token,
  start,
  stop,
  sourceStatus,
  hardStop,
  allSignalData,
  finalSignal,
  candles,
  vrdData,
  indicators,
  globalIndices,
  symbolSelector,
  logs,
  onClearLogs,
  config,
  onSaveConfig,
  onApplyThresholds,
}: StrategyWorkspaceProps) {
  const [activeTab, setActiveTab] = useState<string>('operations')

  const errorLogsCount = logs.filter((l) => l.level === 'error').length

  const mainTabs = (
    <Tabs
      value={activeTab}
      onValueChange={setActiveTab}
      className={symbolSelector ? 'w-full space-y-4 mt-4' : 'w-full space-y-4'}
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

      {/* ── TAB 1: Live Operations ─────────────────────────────────────────── */}
      <TabsContent
        value="operations"
        className="space-y-4 focus-visible:outline-none"
      >
        {/* Row 1: Bot Controls + Live Logs side-by-side */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
          <div className="lg:col-span-4">
            <BotControls
              state={state}
              position={position}
              tradesCount={tradesCount}
              lastUpdated={lastUpdated}
              error={error}
              pollingIntervalSec={pollingIntervalSec}
              start={start}
              stop={stop}
              executionMode={executionMode}
              paperBalance={paperBalance}
            />
          </div>
          <div className="lg:col-span-8">
            <LogPanel logs={logs} onClear={onClearLogs} />
          </div>
        </div>

        {/* Row 2: Signal Score Breakdown & Market Chart */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-stretch">
          <div className="lg:col-span-7">
            <ScorePanel
              allSignalData={allSignalData}
              finalSignal={finalSignal}
              config={config}
            />
          </div>
          <div className="lg:col-span-5 space-y-4 flex flex-col justify-between">
            <MarketSetupPanel vrdData={vrdData} />
            <SimpleChartWidget candles={candles} />
          </div>
        </div>
      </TabsContent>

      {/* ── TAB 2: Market Signals & Analytics ────────────────────────────── */}
      <TabsContent
        value="signals"
        className="space-y-4 focus-visible:outline-none"
      >
        {/* Market setup & Chart side-by-side (3/4 Overview, 1/4 Chart) */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-stretch">
          <div className="lg:col-span-9 h-full">
            <MarketSetupPanel vrdData={vrdData} />
          </div>
          <div className="lg:col-span-3 h-full">
            <SimpleChartWidget candles={candles} />
          </div>
        </div>

        {/* Technical indicators & Squeeze */}
        <IndicatorsPanel indicators={indicators} />

        {/* Institutional + Breadth */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <InstitutionalPanel vrdData={vrdData} />
          <BreadthPanel
            vrdData={vrdData}
            underlyingMode={config.underlyingMode}
          />
        </div>

        {/* Global Markets & News */}
        <GlobalMarketsPanel globalIndices={globalIndices} />
        <NewsAlertsPanel alerts={vrdData?.newsAlerts} />
      </TabsContent>

      {/* ── TAB 3: Strategy Config & Tuning ─────────────────────────────── */}
      <TabsContent
        value="config"
        className="space-y-4 focus-visible:outline-none"
      >
        <DailyBacktestReport />
        <StrategyConfigPanel config={config} onSave={onSaveConfig} />
        <ThresholdOptimizer config={config} onApply={onApplyThresholds} />
      </TabsContent>
    </Tabs>
  )

  return (
    <div className="p-4 space-y-4 max-w-[1600px] mx-auto">
      {/* Sticky Execution Control Header */}
      <StrategyHeaderBar
        underlyingMode={config.underlyingMode}
        state={state}
        position={position}
        tradesCount={tradesCount}
        lastUpdated={lastUpdated}
        pollingIntervalSec={pollingIntervalSec}
        start={start}
        stop={stop}
        executionMode={executionMode}
        paperBalance={paperBalance}
        token={token}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        logErrorCount={errorLogsCount}
      />

      {/* Data feed status */}
      <SourceStatusBar sourceStatus={sourceStatus} />

      {/* Hard stop alert */}
      {hardStop?.blocked && <HardStopBanner reasons={hardStop.reasons} />}

      {symbolSelector ? (
        <Tabs
          value={symbolSelector.value}
          onValueChange={(value) =>
            symbolSelector.onChange(value as UnderlyingSymbol)
          }
          className="w-full"
        >
          {/* Symbol workspace selector (multi-symbol runtimes only) */}
          <TabsList className="grid w-full grid-cols-3 max-w-md">
            {symbolSelector.symbols.map((symbol) => (
              <TabsTrigger key={symbol} value={symbol} className="text-xs">
                {symbol}
              </TabsTrigger>
            ))}
          </TabsList>
          {mainTabs}
        </Tabs>
      ) : (
        mainTabs
      )}
    </div>
  )
}
