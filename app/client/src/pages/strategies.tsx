import type { StrategyConfig } from '@/lib/types'
import { useEffect, useState } from 'react'
import type { StrategyBotController } from '@/hooks/useStrategyBot'
import { getStrategyConfig, saveStrategyConfig } from '@/lib/strategyConfig'
import { fetchPaperAccount } from '@/lib/paperTrading'
import { StrategyWorkspace } from '@/components/dashboard/strategy/strategy-workspace'

interface StrategiesPageProps {
  bot: StrategyBotController
  token: string | null
}

/**
 * Cloud dashboard adapter: maps the browser strategy engine controller onto
 * the shared Strategy workspace (see `strategy-workspace.tsx`).
 */
export function StrategiesPage({ bot, token }: StrategiesPageProps) {
  const [config, setConfig] = useState<StrategyConfig>(getStrategyConfig)
  const [paperBalance, setPaperBalance] = useState<number | null>(null)

  useEffect(() => {
    if (config.executionMode !== 'paper') return
    let cancelled = false
    void fetchPaperAccount()
      .then((summary) => {
        if (!cancelled) setPaperBalance(summary.account.balance)
      })
      .catch(() => {
        if (!cancelled) setPaperBalance(null)
      })
    return () => {
      cancelled = true
    }
  }, [config.executionMode, bot.lastUpdated])

  return (
    <StrategyWorkspace
      state={bot.state}
      position={bot.position}
      tradesCount={bot.tradesCount}
      lastUpdated={bot.lastUpdated}
      error={bot.error}
      pollingIntervalSec={config.pollingIntervalSec}
      executionMode={config.executionMode}
      paperBalance={paperBalance}
      token={token}
      start={bot.start}
      stop={bot.stop}
      sourceStatus={bot.sourceStatus}
      hardStop={bot.hardStop}
      allSignalData={bot.allSignalData}
      finalSignal={bot.finalSignal}
      candles={bot.candles}
      vrdData={bot.vrdData}
      indicators={bot.indicators}
      globalIndices={bot.globalIndices}
      logs={bot.logs}
      onClearLogs={bot.clearLogs}
      config={config}
      onSaveConfig={setConfig}
      onApplyThresholds={(values) => {
        const next = { ...config, ...values }
        saveStrategyConfig(next)
        setConfig(next)
      }}
    />
  )
}
