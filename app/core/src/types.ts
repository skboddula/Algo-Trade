// Re-export all domain interfaces and types from shared package
export * from '../../../packages/shared/src/types'

import type {
  AllSignalData,
  ExecutionMode,
  FinalSignal,
  MarketSnapshot,
  SignalType,
  StrategyConfig,
  UnderlyingSymbol,
  UserBotState,
} from '../../../packages/shared/src/types'

/**
 * Why an actionable signal did or did not become an order. This is telemetry,
 * not an entry gate: the daemon's real gates remain authoritative.
 */
export interface SignalSnapshotContext {
  tradesCountToday: number
  tradesCountPerSymbol: number
  dailyLossTripped: boolean
  cooldownRemainingMs: number
  entryBlockedReasons: string[]
  sentimentFault: string | null
  persistenceFault: string | null
}

/**
 * A replayable record of one signal evaluation. `data` + `config` are the
 * exact inputs to `getFinalSignal`, so the on/off filter arms can be replayed
 * offline without reconstructing candles, VRD, or V3.
 */
export interface SignalSnapshotRecord {
  id?: number
  userId: string
  symbol: UnderlyingSymbol
  capturedAt: string
  istDate: string
  executionMode: ExecutionMode
  botState: UserBotState['state']
  spotPrice: number
  config: StrategyConfig
  data: AllSignalData
  defaultSignal?: FinalSignal
  userSignal: FinalSignal
  unfilteredSignal: FinalSignal
  higherTimeframeTrend?: SignalType
  entryEligible: boolean
  filterVerdict: 'allowed' | 'vetoed' | 'off' | 'not-applicable'
  blockedReason?: string
  context: SignalSnapshotContext
  orderPlaced?: boolean
  tradeId?: string
  instrumentKey?: string
  /** Option premium in paise (same unit as paper_trades.entry_price). */
  entryPrice?: number
  sources?: MarketSnapshot['sources']
  createdAt?: string
}
