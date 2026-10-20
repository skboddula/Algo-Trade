# NIFTY options replay (cost-aware, historical)

This is the research replay for the daemon's NIFTY options strategy. It answers
one question:

> Given the production scoring, multi-timeframe veto, contract selection, caps
> and exits, would the strategy have made money on **actual historical option
> premiums** after realistic fills, slippage and statutory costs?

It is deliberately **not** the synthetic Black-Scholes report and **not** a
demo/backtest screen. It reconstructs the production signal inputs from
historical 1-minute NIFTY spot/option data, executes at the next option bar
open, and writes trade-level plus aggregate results.

## What it does

- Uses the production `getFinalSignal`, `applyMultiTimeframeFilter`,
  `shouldExit`, hard-stop, cap, cooldown and EOD rules.
- Reconstructs technicals, chain PCR, global-index sentiment and India VIX
  from point-in-time data.
- Selects the nearest **strictly future** expiry (same-day 0-DTE is skipped)
  and the configured ATM/OTM strike, with a data-gap guard.
- Fills entries at the **next 1-minute option bar open** after a signal.
- Applies stop-first intrabar ordering for stop/target/trailing exits.
- Charges ₹20 brokerage/order, STT on sell premium, exchange fee, stamp duty,
  SEBI turnover fee (`statutory` mode) and 18% GST.
- Separates statutory charges from configurable slippage.
- Writes `report.md`, `summary.json`, `trades.csv`, `daily.csv` and
  `equity.csv`, including data coverage, signal funnel and skipped-trade
  diagnostics.

## Data

The first real run uses the free Hugging Face dataset
[`thetrademarkk/india-index-options-1m`](https://huggingface.co/datasets/thetrademarkk/india-index-options-1m):

- NIFTY index 1-minute bars (`index/NIFTY.parquet`)
- expiry-scoped NIFTY option 1-minute bars (`options/NIFTY/<expiry>.parquet`)
- **License: CC-BY-NC-4.0** — research/non-commercial use; attribute the
  dataset. Treat it as third-party research data, not official NSE/Upstox
  pricing.

Daily macro proxies (previous completed global close, USD/INR, Brent, Gold and
India VIX) are fetched from Yahoo Finance by
`scripts/options-replay/fetch-macro.mjs`. They are explicitly labelled as
proxies in the report.

Data is written under `app/core/data/replay/` and is **not committed** (it is
covered by `app/core/.gitignore`).

## Run

From `app/core`:

```bash
# 1. Download index + expiry files for the window.
node scripts/options-replay/download-hf.mjs \
  --from 2026-01-01 --to 2026-05-22

# 2. Fetch daily macro/VIX proxies.
node scripts/options-replay/fetch-macro.mjs \
  --from 2026-01-01 --to 2026-05-22

# 3. Replay the strategy-plan baseline (OTM-3, 14:30/15:30, filter on, 10 bps/side).
npx tsx scripts/options-replay.ts \
  --from 2026-01-01 --to 2026-05-22 \
  --filter on --slippage-bps 10 \
  --label filter-on-slip10 \
  --out data/replay/reports/filter-on-slip10
```

The report is at
`data/replay/reports/filter-on-slip10/report.md`; the machine-readable
aggregate is `summary.json`, and every trade is in `trades.csv`.

The running paper daemon currently differs from that baseline (ATM-0, 15:15
cutoff/square-off, 60s cooldown, 10% daily-loss stop). Reproduce its parity
arm with:

```bash
npx tsx scripts/options-replay.ts \
  --from 2026-01-01 --to 2026-05-22 \
  --config scripts/options-replay/configs/current-daemon-2026.json \
  --filter on --slippage-bps 10 \
  --label current-daemon-slip10 \
  --out data/replay/reports/current-daemon-slip10
```

Useful overrides:

```bash
--filter off                 # disable the 5-min EMA 10/42 veto
--slippage-bps 0             # frictionless diagnostic
--slippage-bps 25            # pessimistic fill
--otm-skip 0                 # ATM instead of the baseline OTM-3
--trail-pct 0                # disable trailing stop (diagnostic)
--max-profit-pct 20 --max-loss-pct 15
--max-total-trades-per-day 18 --max-daily-loss-pct 10
--exit-cooldown-sec 60
--capital 100000 --lots 1 --lot-size 75
--cost-model paper-parity    # browser ledger fee parity (no SEBI fee)
```

`--lot-size 75` is the 2026 NIFTY contract lot. The current daemon constant is
65, so compare **per-unit** P&L when reconciling against the paper ledger.

## Compare arms

`compare.mjs` reads completed report directories and prints a markdown table
plus a paired daily bootstrap against the first arm (or `--baseline`):

```bash
node scripts/options-replay/compare.mjs \
  "Production filter on=data/replay/reports/filter-on-slip10" \
  "Production filter off=data/replay/reports/filter-off-slip10" \
  "Current paper daemon=data/replay/reports/current-daemon-slip10" \
  "No-trail filter on=data/replay/reports/filter-on-notrail" \
  --baseline="Production filter on" \
  --out=data/replay/reports/comparison.md
```

## Tests

```bash
cd app/core
npx vitest run src/__tests__/optionsReplay.test.ts
yarn typecheck
```

The tests cover cost parity, contract/expiry selection, session filtering,
stop-first priority, next-bar fills, same-bar trailing ordering, entry-delay
waiting, filter veto accounting, daily caps, exit cooldown, macro as-of
reconstruction and report output.

## Important limitations

- **Partial system.** Breadth, FII/DII, MMI, Nifty PE, straddle IV, GIFT
  Nifty, live support/resistance and news alerts were not available
  historically. They are passed as null/empty and do **not** claim full
  live-VRD parity.
- **No bid/ask.** Historical files have OHLC/volume/OI only. Slippage is a
  configurable bps proxy. The report keeps it separate from statutory costs.
- **Option data quality.** Far strikes are sparse; the selector refuses a
  strike more than `--max-strike-distance-pct` from spot instead of
  substituting an unrealistic far contract. ATM/near-ATM is the usable region.
- **No look-ahead convention.** A signal at minute `t` uses candles/chain data
  up to `t` and fills at `t+1` open. Global macro uses the previous completed
  session; VIX uses the current daily open or previous close. Stops are assumed
  to hit before targets in the same bar.
- **Exact snapshot replay is the gold standard.** This harness can accept a
  future `signalFor` source backed by `signal_snapshots`; the table was empty
  when this replay was built. Until it accumulates, this reconstructed replay
  is evidence, not proof of live-system parity.
- **Do not arm live on this alone.** The committed evidence is negative /
  fragile; see `docs/options-replay.md`. Keep paper running and confirm with
  exact snapshots and out-of-sample data before changing production or arming
  live.
