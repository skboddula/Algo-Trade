/**
 * Strategy engine — canonical implementation lives in
 * `packages/strategy-engine`.
 *
 * The browser bot and the daemon must use the identical scoring math. Never
 * re-implement scoring here; extend the shared package instead.
 */
export * from '../../../../packages/strategy-engine/src'
