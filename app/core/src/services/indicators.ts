/**
 * Calculation engine — re-exported from the BROWSER CLIENT.
 *
 * The client's files are the single source of truth for all trading math.
 * The daemon (and the browser bot) consume the identical functions, so the
 * engines cannot diverge. Never re-implement anything here — extend
 * app/client/src/lib/indicators.ts and both sides change together.
 *
 * The reference-identity guard for these re-exports lives in
 * app/core/src/__tests__/sharedIndicators.test.ts.
 */
export * from "../../../client/src/lib/indicators";
