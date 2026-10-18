import { DEFAULT_CONFIG } from '@/lib/types'
import type { StrategyConfig, UnderlyingSymbol } from '@/lib/types'
import { useState } from 'react'
import type { DaemonController } from '@/hooks/useDaemon'
import { DAEMON_SYMBOLS } from '@/lib/daemon'
import { StrategyWorkspace } from '@/components/dashboard/strategy/strategy-workspace'
import { deriveDaemonStrategyView } from './strategy-view'

/**
 * Daemon window adapter: maps the socket/ledger controller onto the shared
 * Strategy workspace (see `strategy-workspace.tsx`).
 */
export function DaemonStrategiesPage({ daemon }: { daemon: DaemonController }) {
  const [activeSymbol, setActiveSymbol] = useState<UnderlyingSymbol>('NIFTY 50')

  const userState = daemon.status?.userState
  const config: StrategyConfig = userState?.config ?? DEFAULT_CONFIG
  const view = deriveDaemonStrategyView(
    daemon.status,
    daemon.health,
    activeSymbol,
  )

  const start = () => void daemon.start(config.executionMode)
  const stop = () => void daemon.stop()

  return (
    <StrategyWorkspace
      state={view.state}
      position={view.position}
      tradesCount={view.tradesCount}
      lastUpdated={view.lastUpdated}
      error={view.error}
      pollingIntervalSec={config.pollingIntervalSec}
      executionMode={config.executionMode}
      paperBalance={view.paperBalance}
      token={view.token}
      start={start}
      stop={stop}
      sourceStatus={view.sourceStatus}
      allSignalData={view.allSignalData}
      finalSignal={view.finalSignal}
      candles={view.candles}
      vrdData={view.vrdData}
      indicators={view.indicators}
      globalIndices={null}
      symbolSelector={{
        symbols: DAEMON_SYMBOLS,
        value: activeSymbol,
        onChange: setActiveSymbol,
      }}
      logs={daemon.logs}
      onClearLogs={daemon.clearLogs}
      config={config}
      onSaveConfig={(next) => void daemon.saveConfig(next)}
      onApplyThresholds={(values) => {
        void daemon.saveConfig({ ...config, ...values })
      }}
    />
  )
}
