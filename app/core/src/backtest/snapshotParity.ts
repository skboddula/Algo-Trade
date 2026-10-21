/**
 * Exact snapshot replay — arm parity.
 *
 * `signal_snapshots` stores the exact `AllSignalData` (`data_json`) and
 * `StrategyConfig` (`config_json`) that produced the recorded arms at
 * evaluation time. This module re-runs the production scoring
 * (`getFinalSignal`) from those stored inputs and diffs the result against the
 * stored user / unfiltered / default arms.
 *
 * This is the trust gate for every later replay layer (entry gates, cost-aware
 * fills, re-entry policy): those may not be built on inputs that fail to
 * reproduce the daemon's own decisions bit-for-bit.
 *
 * Parity is only meaningful when the replay runs the SAME scoring build that
 * captured the rows. `signal_snapshots` has no engine-version column, so after
 * any scoring change old rows will (correctly) mismatch — pin the build or
 * replay per capture window.
 */
import { DEFAULT_STRATEGY_CONFIG } from '../constants'
import { getFinalSignal } from '../services/strategyEngine'
import type { AllSignalData, FinalSignal, StrategyConfig } from '../types'

/** One `signal_snapshots` row, reduced to the columns parity needs. */
export interface SnapshotParityRow {
  id: number
  symbol: string
  capturedAt: string
  dataJson: string
  configJson: string
  userSignalJson: string
  unfilteredSignalJson: string
  defaultSignalJson: string | null
}

export type SnapshotArm = 'user' | 'unfiltered' | 'default'

export type ArmStatus = 'match' | 'mismatch' | 'stored-missing'

export interface SignalFieldDiff {
  field: string
  stored: unknown
  recomputed: unknown
}

export interface ArmParity {
  arm: SnapshotArm
  status: ArmStatus
  diffs: SignalFieldDiff[]
  stored: FinalSignal | null
  recomputed: FinalSignal | null
}

export interface RowParity {
  id: number
  symbol: string
  capturedAt: string
  parseError: string | null
  arms: ArmParity[]
}

/** Field-level diff of two signals; empty when identical. */
export function signalFieldDiffs(
  stored: FinalSignal,
  recomputed: FinalSignal,
): SignalFieldDiff[] {
  const fields = new Set([...Object.keys(stored), ...Object.keys(recomputed)])
  const diffs: SignalFieldDiff[] = []
  for (const field of fields) {
    const storedValue = (stored as unknown as Record<string, unknown>)[field]
    const recomputedValue = (recomputed as unknown as Record<string, unknown>)[
      field
    ]
    if (storedValue !== recomputedValue) {
      diffs.push({ field, stored: storedValue, recomputed: recomputedValue })
    }
  }
  return diffs
}

function armParity(
  arm: SnapshotArm,
  stored: FinalSignal | null,
  recomputed: FinalSignal | null,
): ArmParity {
  if (!stored) {
    return { arm, status: 'stored-missing', diffs: [], stored: null, recomputed }
  }
  if (!recomputed) {
    return { arm, status: 'mismatch', diffs: [], stored, recomputed: null }
  }
  const diffs = signalFieldDiffs(stored, recomputed)
  return {
    arm,
    status: diffs.length === 0 ? 'match' : 'mismatch',
    diffs,
    stored,
    recomputed,
  }
}

/**
 * Re-runs the three production scoring calls from a stored row and diffs them:
 *
 * - `user` arm: `getFinalSignal(data, config)` — the exact call the tenant
 *   entry path made with the user's captured config.
 * - `unfiltered` arm: the same config with `useMultiTimeframe: false`.
 * - `default` arm: the master snapshot's reference scoring with
 *   `DEFAULT_STRATEGY_CONFIG`.
 */
export function compareSnapshotArms(row: SnapshotParityRow): RowParity {
  let data: AllSignalData
  let config: StrategyConfig
  let storedUser: FinalSignal
  let storedUnfiltered: FinalSignal
  let storedDefault: FinalSignal | null
  try {
    data = JSON.parse(row.dataJson)
    config = JSON.parse(row.configJson)
    storedUser = JSON.parse(row.userSignalJson)
    storedUnfiltered = JSON.parse(row.unfilteredSignalJson)
    storedDefault = row.defaultSignalJson
      ? JSON.parse(row.defaultSignalJson)
      : null
  } catch (error) {
    return {
      id: row.id,
      symbol: row.symbol,
      capturedAt: row.capturedAt,
      parseError: error instanceof Error ? error.message : String(error),
      arms: [],
    }
  }

  return {
    id: row.id,
    symbol: row.symbol,
    capturedAt: row.capturedAt,
    parseError: null,
    arms: [
      armParity('user', storedUser, getFinalSignal(data, config)),
      armParity(
        'unfiltered',
        storedUnfiltered,
        getFinalSignal(data, { ...config, useMultiTimeframe: false }),
      ),
      armParity(
        'default',
        storedDefault,
        getFinalSignal(data, DEFAULT_STRATEGY_CONFIG),
      ),
    ],
  }
}
