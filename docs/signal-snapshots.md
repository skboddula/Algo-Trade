# Signal Snapshots (daemon A/B telemetry)

The daemon now persists one replayable row per candidate entry evaluation in
the `signal_snapshots` table of `DATA_DIR/algo-trade.sqlite` (default
`app/core/data/algo-trade.sqlite`).

This exists so the multi-timeframe filter can be evaluated from the **full**
scoring inputs, not from a candle-only proxy:

- `data_json` holds the exact `AllSignalData` input: `v3`, `indicators`
  (including `higherTimeframeTrend` and PCR), `vrd`, and `globalIndices`.
- `config_json` holds the user's `StrategyConfig` at evaluation time.
- `default_signal_json` is the master snapshot's reference signal (default
  config).
- `user_signal_json` is `getFinalSignal(data, config)` with the user's filter
  setting.
- `unfiltered_signal_json` is the same scoring with
  `useMultiTimeframe: false`.
- `filter_verdict` is `allowed`, `vetoed`, `off`, or `not-applicable`.
- `blocked_reason` and `context_json` record why an actionable signal did or
  did not become an order (cap, cooldown, daily loss, stale data, hard stop,
  order failure, ...).

Snapshots are written at most once per minute per user+symbol for an
unchanged decision fingerprint, plus whenever an order is placed. Write
failures are logged and never block entries.

## Per-user filter behavior

The master ingestor computes:

- `snapshot.signal` — reference scoring with the default config (filter on).
- `snapshot.unfilteredSignal` — the same scoring with the veto disabled.
- `snapshot.v3` — the V3 macro input used for scoring.

The tenant entry path then computes the user's signal from the same
`AllSignalData` with `user.config`. This means `useMultiTimeframe` in
`/api/bot/config` now actually controls daemon entries; it is no longer
ignored in favor of the default config. Users on default thresholds keep the
same signal as before.

## Reading snapshots

Quick daily report (both filter arms, veto count, actual orders):

```bash
cd app/core
npx tsx scripts/snapshot-report.ts 2026-10-21 default_user
```

The table starts at the deploy that introduced it; earlier dates are not
backfilled. `2026-10-19`/`2026-10-20` will be empty.

Raw API:

```bash
curl -s 'http://127.0.0.1:3000/api/bot/signal-snapshots?userId=default_user&date=2026-10-21&limit=200' \
  | jq '.count, .snapshots[0]'
```

Query the SQLite table directly for bulk analysis:

```bash
sqlite3 app/core/data/algo-trade.sqlite \
  "SELECT ist_date, symbol, captured_at, filter_verdict, blocked_reason,
          json_extract(user_signal_json, '$.signal') AS user_signal,
          json_extract(unfiltered_signal_json, '$.signal') AS unfiltered_signal
   FROM signal_snapshots
   WHERE user_id='default_user'
   ORDER BY id;"
```

Replay an arm offline with the shared engine:

```ts
import { getFinalSignal } from '../../packages/strategy-engine/src'

const signal = getFinalSignal(row.data, {
  ...row.config,
  useMultiTimeframe: true, // or false for the off arm
})
```

Because both the input and config are stored, the replay uses the same
scoring code as the daemon and browser. It is still a model of the decision:
fills, option premium paths and exit rules are not part of this table.

## Retention

There is no automatic pruning. A capture-mode switch and automated retention
lifecycle (sampled vs full capture, auto-downgrade, pruning) is designed but
**deferred** to avoid critical-path changes; see
[Deferred: snapshot capture lifecycle](options-replay.md#deferred-snapshot-capture-lifecycle-telemetry).
Export the period you need, then prune, e.g.:

```sql
DELETE FROM signal_snapshots WHERE ist_date < '2026-07-21';
```

Back up `algo-trade.sqlite` before pruning. The table contains no broker
tokens or order credentials, but it does contain full VRD/news and account
user ids, so treat it as private trading data.

## Related replay harness

The cost-aware historical options replay lives in
[`app/core/scripts/options-replay/README.md`](../app/core/scripts/options-replay/README.md)
and the Jan–May 2026 evidence review is in
[`docs/options-replay.md`](options-replay.md). It uses reconstructed inputs and
is **not** a substitute for exact snapshot replay; once this table has enough
rows, the replay's `signalFor` hook can be backed by `data_json`,
`config_json`, `user_signal_json` and `unfiltered_signal_json`.
