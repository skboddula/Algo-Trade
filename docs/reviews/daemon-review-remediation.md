# Daemon Review Remediation — CR-01 … CR-20

Reviewed snapshot: `4ddf54a` (feat/always-on-daemon). Remediation commits land
on top; every finding was re-verified against the current code before fixing.

**No live broker orders were submitted at any point.** All broker-facing tests
use scripted/mock gateway responses; the live Upstox paths were exercised only
against mocked fetches. Paper trading behavior is unchanged (instant-fill
simulation is the documented definition of paper mode).

## Status summary

| CR | Status | Files (core) | Tests |
|----|--------|--------------|-------|
| CR-01 failed exits clear positions | **FIXED** | `services/tenantManager.ts` (`manualExit`) | `remediation.test.ts` (4 exit-outcome tests) |
| CR-02 submission ≠ execution | **FIXED (live paths)** | `services/orderGateway.ts` (`placeLiveUpstoxOrder`, `exitLiveUpstoxOrder`, `confirmLiveOrder`) | orderGateway suite (existing 8) + live-path unit coverage via OrderResult contract |
| CR-03 stop ≠ abandon supervision | **FIXED** | `services/tenantManager.ts` (`handleMarketTick` STOPPED branch, `stopBot`) | `remediation.test.ts` (lifecycle suite) |
| CR-04 restart reconciliation | **FIXED** | `services/tenantManager.ts` (`runStartupRecovery`, `validateUserState`, `getRecoveryStatus`), `services/orderGateway.ts` (`getLivePositions`) | `remediation.test.ts` (recovery, live-blocked-while-pending) |
| CR-05 auth hardening | **FIXED** (round 1) **+ strengthened** (this round) | `server.ts` (fail-closed bind + redact), `routes/botRoutes.ts` (ticket flow, schemas) | `botRoutes.test.ts` (auth suite + ticket-based leak test) |
| CR-06 payload sanitization | **FIXED** (round 1) **+ strengthened** (this round) | `routes/botRoutes.ts` (`PublicUserState` allowlist DTO) | `botRoutes.test.ts` (canary leak test) |
| CR-07 persisted credentials | **PARTIAL** — perms 0600/0700 + separation + redaction; **encryption DEFERRED** (documented) | `utils/store.ts` | store tests in `remediation.test.ts` |
| CR-08 live-trading backend safety | **FIXED** | `services/tenantManager.ts` (`startBot` arming/recovery/persistence gates), `routes/botRoutes.ts` (403 mapping) | `remediation.test.ts` (arming, recovery, fault gates) |
| CR-09 token update + reconnect | **FIXED** | `services/marketStream.ts` (`notifyTokenAvailable`, `reconnect`, jitter, no-token no-retry), `services/masterIngestor.ts` (`tokenChanged`), `services/tenantManager.ts` (wiring) | stream behavior covered via ingestor suite + telemetry exposure |
| CR-10 subscription restore | **FIXED** | `services/tenantManager.ts` (constructor `syncStreamSubscriptions` after recovery) | live daemon verification |
| CR-11 source freshness | **FIXED** | `services/masterIngestor.ts` (per-source timestamps, `sources` block, `getEntryBlockers`), `services/tenantManager.ts` (entry staleness gate) | live daemon verification (sources block live; blockers on stale) |
| CR-12 expiry cache validation | **FIXED** | `services/masterIngestor.ts` (`resolveNearestExpiry` date validation, fail-safe null) | `masterIngestor.test.ts` (existing suite green) |
| CR-13 stream-health telemetry | **FIXED** | `services/marketStream.ts` (`getTelemetry`), `services/tenantManager.ts` (`getStreamHealth` real values) | live daemon `/api/bot/stream-health` |
| CR-14 ALL_PARALLEL handling | **FIXED** (behavior correction — flagged) | `services/tenantManager.ts` (entry gate RUNNING∥ORDERED + optional `maxTotalTradesPerDay`), `packages/shared/types.ts` | `tenantManager.test.ts` (existing suite green) |
| CR-15 persistence failures | **FIXED** | `utils/store.ts` (throw, corrupt preservation), `services/tenantManager.ts` (`persistUserStates` fault → blocks live) | `remediation.test.ts` (corrupt, readonly, fault surfacing) |
| CR-16 durable paper reset | **FIXED** | `services/orderGateway.ts` (`resetPaperAccount` persists, CANCELLED appends, audit statement) | orderGateway suite |
| CR-17 runtime validation | **FIXED** (command routes) | `routes/botRoutes.ts` (JSON schemas: start/stop/config/token/exit; enum/bound checks) | `botRoutes.test.ts` (schema 400s via suite) |
| CR-18 scoped user logs | **FIXED** | `services/botLogService.ts` (userId field), `services/tenantManager.ts` (scoped calls), `routes/botRoutes.ts` (per-user broadcast) | log-scoping verified in code path; multi-client test via ticket suite |
| CR-19 backtest validation | **FIXED** (bounds) — engine semantics untouched per constraint 5 | `routes/botRoutes.ts` (date shape/order/range ≤120d) | botRoutes suite |
| CR-20 account/equity reconciliation | **FIXED** | `services/orderGateway.ts` (`startingBalance` on create/reset), `routes/botRoutes.ts` (equity uses account baseline), `packages/shared/types.ts` | orderGateway suite (round-trip invariant) |

## Root causes → corrections (key items)

- **CR-01/02**: `manualExit` ignored `exitOrder`'s result and nulled the
  position; live orders treated an HTTP 200 as a fill at the requested price.
  Now: an explicit `OrderResult.status` lifecycle (`filled | pending |
  rejected | unknown`); live orders submit → capture brokerOrderId → bounded
  poll of `/order/details` → only broker-confirmed fills (qty + average price
  from the broker) close positions; unknown outcomes retain the position and
  demand reconciliation. A `pendingExit` flag deduplicates concurrent exits.
  *Paper mode remains an instant-fill simulation by design.*
- **CR-03**: `STOPPED` skipped the whole user; now STOPPED users with open
  positions receive full protective supervision (SL/trailing/EOD) — only
  entries are blocked. Stop messaging reflects the real semantics.
- **CR-04**: startup recovery lifecycle: load → validate shapes → reconcile
  live users against `/order&positions` (token-gated) → recovery
  `complete`; LIVE entries blocked while `pending`/`failed`. Mismatches are
  recorded, never silently treated as closed.
- **CR-05**: round-1 added the API key + fail-closed bind; this round added
  one-use 30s **WS tickets** (keys never in URLs), pino `redact` for
  authorization/x-api-key/query params, and runtime JSON schemas.
- **CR-08**: `DAEMON_LIVE_ARMED=true` (server-side env) is required for any
  live start; recovery-complete + persistence-health also gate live; the
  route maps rejections to 403. A client flipping `executionMode` cannot arm.
- **CR-11**: per-symbol quote/candle/chain + VIX success timestamps; snapshots
  carry a `sources` block (ages + `entryBlockedReasons`); the tenant entry
  gate blocks on stale inputs. Failed fetches no longer masquerade as fresh.
- **CR-12**: cached expiry must satisfy `expiry >= today IST`; expired entries
  refetch and fall back to null (fail-safe) when the exchange cannot confirm.
- **CR-14**: entries now allowed while `ORDERED` (per-symbol position check is
  the duplicate guard), restoring ALL_PARALLEL semantics; optional
  `maxTotalTradesPerDay` global cap added (unset = off, additive config).
  **Behavior correction, not a threshold change** — flagged per constraint 5.
- **CR-15**: `saveState`/`appendRecord` throw; corrupt JSON is preserved as
  `<name>.corrupt-<ts>`; `persistUserStates` failures surface as an
  operational fault that blocks LIVE entries (paper continues in-memory).

## Regression tests added

`app/core/src/__tests__/remediation.test.ts` (12 tests):
CR-01 rejected/unknown/pending exit retention, confirmed-fill close with
broker prices, in-flight dedup; CR-03 recovery completion, live-unarmed
rejection, live-while-pending rejection (armed), paper-start regression;
CR-15 corrupt-file preservation, readonly-save exception, persistence-fault
surfacing.

`app/core/src/__tests__/botRoutes.test.ts` (extended):
auth suite (401/200, `/health` open, writes guarded, inert-when-unset) +
ticket-based INITIAL_STATE canary-leak test.

Existing suites all green — orderGateway 8 (cash model incl. round-trip
invariant), tenantManager 4, masterIngestor 4, botRoutes 15, sharedIndicators
6, telegramAlerts 3, store 5, timeUtils 4 = **59 core tests**; client battery
**136 tests** (incl. 28 static + 12 live parity). Live daemon verification:
recovery `complete`, auth 401/200, sources block emitting real ages, no
`upstoxToken` in any payload, WS ticket flow end-to-end.

## Quality-gate commands and results

```
app/core:   yarn typecheck  → 0 errors
            yarn test       → 9 files, 59 passed (×3 consecutive runs)
app/client: yarn typecheck   → 0 errors
            yarn lint       → 0 errors
            yarn format:check → clean
            yarn vitest (12 suites) → 136 passed
            yarn build     → production build ✓ (real PWA sw.js ships)
```

## Remaining risks / deferred items

1. **CR-07 encryption**: state files are 0600 and the data dir 0700, but
   contents remain plaintext (token in `primary_token.json`, user states).
   OS-keychain/secret-manager integration deferred — the Upstox token also
   lives in plaintext `.env` on the same disk, so full at-rest encryption of
   one file would not change the threat model materially. Documented.
2. **CR-04 broker reconciliation for live** is implemented against the
   Upstox `/order&positions` shape but has never run against the real API
   (live trading has never been armed). First live arming should be a
   supervised drill.
3. **CR-14 semantics**: ALL_PARALLEL now genuinely parallel — on a strong
   multi-symbol day the daemon may hold up to 3 concurrent positions
   (respecting per-symbol caps and the optional global cap). Intentional
   correction; noted for the operator.
4. Paper mode remains an instant-fill simulation with 0.1% slippage + the
   realistic fee model — fill realism beyond that (queue position, partial
   fills in paper) is out of scope by design.

## Next recommended step

Run the daemon paper-only for a full trading session (Mon 09:15 IST) and
verify the new surfaces live: `sources` staleness behavior during market
hours, stream telemetry (`/api/bot/stream-health` shows real subscribedKeys +
tick ages), and the recovery status on a mid-session restart. Do not arm live
until a supervised drill with the backend gates (`DAEMON_LIVE_ARMED`,
recovery, reconciliation) has been walked through.
