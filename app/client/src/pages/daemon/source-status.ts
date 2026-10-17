import type { SourceStatus } from '@/hooks/useStrategyBot'
import type { DaemonHealth } from '@/lib/daemon'
import type { VrdData } from '@/lib/types'

/**
 * Derive the cloud dashboard's data-source statuses from the daemon's feed
 * health + latest VRD snapshot.
 */
export function deriveSourceStatus(
  health: DaemonHealth | null,
  vrd: VrdData | null | undefined,
): Record<string, SourceStatus> {
  const ws = health?.feed?.ws
  const mock = health?.feed?.source === 'mock'
  const wsOpen = ws?.state === 'open'

  const connected: SourceStatus = mock ? 'ok' : wsOpen ? 'ok' : 'pending'

  return {
    candles: mock
      ? 'ok'
      : wsOpen
        ? (ws?.ticks.index ?? 0) > 0
          ? 'ok'
          : 'pending'
        : 'stale',
    'option-chain': mock
      ? 'ok'
      : (ws?.chain.calls ?? 0) > 0
        ? ws?.chain.failures
          ? 'stale'
          : 'ok'
        : 'pending',
    vix: vrd?.vix !== null && vrd?.vix !== undefined ? 'ok' : 'unknown',
    breadth: vrd?.advancesDeclines ? 'ok' : 'unknown',
    'global-sentiment': vrd?.giftNifty?.price != null ? 'ok' : 'unknown',
    'upstox/fii': vrd?.fiiLongShort ? 'ok' : 'unknown',
    'upstox/dii': 'unknown',
    'upstox/pcr': vrd?.pcr?.value != null ? 'ok' : 'unknown',
    'upstox/max-pain': vrd?.maxPain != null ? 'ok' : 'unknown',
    'synthetic/value': connected === 'ok' ? 'ok' : 'unknown',
  }
}
