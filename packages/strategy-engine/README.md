# @algo-trade/strategy-engine

Canonical strategy scoring engine for Algo-Trade. The daemon
(`app/core`) and the browser bot (`app/client`) re-export this package and
must never implement scoring locally.

## Contents

- `strategyEngine.ts` — `getFinalSignal`, `scoreBullish`, `scoreBearish`,
  `shouldExit`, `runHardStopChecks`, multi-timeframe confluence filter.
- `vrdSignals.ts` — VRD scorers (`scoreMMI`, `scoreADRatio`,
  `scoreFiiLongShort`, `scoreFiiPositioning`, `scoreNiftyPE`, `scoreVix`,
  `scoreStraddleIV`) + `classifyNews`.
- `higherTimeframe.ts` — 5-minute resampling and EMA 10/42 trend used by the
  multi-timeframe entry filter.

Shared contracts (`StrategyConfig`, `AllSignalData`, `VrdData`, thresholds,
`VIX_HARD_STOP_MIN/MAX`, `VIX_FRESHNESS_WINDOW_MS`) live in
`packages/shared`.

## Tests

```sh
npm test        # 25 engine tests (vitest via app/core's install)
npm run typecheck
```

The app suites (`app/core`, `app/client`) run their own integration tests on
top of the same engine; `app/core/src/__tests__/engineBoundary.test.ts`
enforces the package boundary (no app-to-app imports).

## Fail-closed gates (daemon live path)

- `SentimentIngestor` reports `getStatus().live` only when a real Upstox
  market-wide source was fetched and the data is within 3 refresh cycles.
- `MasterIngestionEngine` stamps `sources.sentimentFault` when live VRD/VIX
  is unavailable or stale (and when `useRealVrd=false`).
- `TenantManager` blocks new LIVE entries while `sentimentFault` is set;
  paper staging continues on the deterministic fallback. The entry
  hard-stop gate (`runHardStopChecks(vrd)`) applies to both modes.
