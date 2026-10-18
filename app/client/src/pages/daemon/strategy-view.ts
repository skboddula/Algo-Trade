import type {
  ActivePosition,
  AllSignalData,
  Candle,
  FinalSignal,
  IndicatorsResult,
  UnderlyingSymbol,
  VrdData,
} from '@/lib/types'
import type { BotState } from '@/hooks/useBotState'
import type { DaemonHealth, DaemonStatus } from '@/lib/daemon'
import type { SourceStatus } from '@/lib/marketService'
import { formatClock } from './format'
import { deriveSourceStatus } from './source-status'

/** Data half of the shared Strategy workspace contract for one symbol. */
export interface DaemonStrategyView {
  state: BotState
  position: ActivePosition | null
  tradesCount: number
  lastUpdated: string | null
  error: string | null
  paperBalance: number
  token: string | null
  sourceStatus: Record<string, SourceStatus>
  allSignalData: AllSignalData | null
  finalSignal: FinalSignal | null
  candles: Candle[]
  vrdData: VrdData | null
  indicators: IndicatorsResult | null
}

/**
 * Map the daemon's snapshot + user state for `symbol` onto the shared
 * Strategy workspace (see `strategy-workspace.tsx`).
 */
export function deriveDaemonStrategyView(
  status: DaemonStatus | null,
  health: DaemonHealth | null,
  symbol: UnderlyingSymbol,
): DaemonStrategyView {
  const userState = status?.userState ?? null
  const snapshot = status?.snapshots?.[symbol]
  const vrdData = snapshot?.vrdData ?? null
  const liveFeed = Boolean(health?.feed && health.feed.source !== 'mock')

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

  return {
    state: userState?.state ?? 'IDLE',
    position: userState?.positions?.[symbol] ?? null,
    tradesCount: userState?.tradesCountToday ?? 0,
    lastUpdated: userState ? formatClock(userState.updatedAt) : null,
    error: userState?.error ?? null,
    paperBalance: (userState?.paperBalance ?? 0) / 100,
    token: liveFeed ? 'daemon-master-token' : null,
    sourceStatus: deriveSourceStatus(health, vrdData),
    allSignalData,
    finalSignal: snapshot?.signal ?? null,
    candles: snapshot?.candles ?? [],
    vrdData,
    indicators: snapshot?.indicators ?? null,
  }
}
