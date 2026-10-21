// Re-export all domain constants from shared package
export * from '../../../packages/shared/src/constants'

/**
 * Env var that arms live trading server-side. Client-side confirmation is UX
 * only; every live entry path re-checks this switch. Exits are never gated.
 */
export const LIVE_ARM_ENV = 'DAEMON_LIVE_ARMED'
