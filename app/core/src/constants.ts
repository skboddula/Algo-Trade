// Re-export all domain constants from shared package
export * from '../../../packages/shared/src/constants'

/**
 * Env var that arms live trading server-side. Client-side confirmation is UX
 * only; every live entry path re-checks this switch. Exits are never gated.
 */
export const LIVE_ARM_ENV = 'DAEMON_LIVE_ARMED'

/**
 * Re-entry policy constants (pre-registered; do not tune intraday).
 *
 * Moderate entries must improve by this many directional score points after a
 * net loss/scratch. A direction flip is also accepted as new information.
 */
export const REENTRY_SCORE_IMPROVEMENT = 2

/** Two consecutive net losses pause moderate entries for this long. */
export const LOSS_PAUSE_MS = 30 * 60_000

/** Third consecutive net loss blocks the symbol for the rest of the IST day. */
export const MAX_CONSECUTIVE_LOSSES = 3

/**
 * Hard risk caps. Strategy config may lower these, but never raise them.
 *
 * Pre-registered 2026-10-21 as 8 per symbol / 18 total, then amended the same
 * evening before the first session under the policy: total 18 → 24 so the
 * envelope equals the full three-symbol sweep (3 × 8). The amendment is
 * arithmetic (symmetry), not evidence-driven; see docs/reentry-policy.md.
 */
export const HARD_MAX_TRADES_PER_SYMBOL = 8
export const HARD_MAX_TOTAL_TRADES = 24
