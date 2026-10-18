import type { ActivePosition } from '@/lib/types'
import type { DaemonController } from '@/hooks/useDaemon'
import { HistoryView } from '@/components/dashboard/history/history-view'
import { buildDaemonHistoryData } from './history-data'

export function DaemonHistoryPage({ daemon }: { daemon: DaemonController }) {
  const userState = daemon.status?.userState
  const trades = daemon.status?.paperTrades ?? []
  const positions = (userState?.positions ?? {}) as Record<
    string,
    ActivePosition | null
  >

  const { balanceLabel, openCount, statementRows, tradeRows } =
    buildDaemonHistoryData(trades, positions, userState?.paperBalance ?? 0)

  return (
    <HistoryView
      subtitle="Daemon paper trading ledger and simulated trade statement"
      balance={balanceLabel}
      openCount={openCount}
      statementRows={statementRows}
      statementEmptyMessage="No settled trades yet"
      tradeRows={tradeRows}
    />
  )
}
