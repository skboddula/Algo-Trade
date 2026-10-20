# NIFTY options replay — evidence review (Jan–May 2026)

**Status: no verified edge. Do not arm live on this evidence.** Keep the
daemon in paper mode and keep the current 5-min filter on until exact
`signal_snapshots` A/B is available.

This is the first cost-aware historical replay using **actual NIFTY option
premiums**, not the synthetic Black-Scholes report and not a demo/backtest
screen. It reconstructs the production scoring inputs from third-party
1-minute data, uses production entry/exit/cap logic, fills at the next option
bar open, and charges brokerage + statutory costs plus slippage.

- **Window:** 2026-01-01 → 2026-05-22 (94 NSE sessions)
- **Symbol:** NIFTY 50
- **Capital:** ₹1,00,000; 1 lot per trade; **NIFTY lot size 75** (2026 contract)
- **Data:** HF `thetrademarkk/india-index-options-1m` (CC-BY-NC-4.0,
  research/non-commercial), plus Yahoo daily macro/VIX proxies
- **Coverage:** 94/94 sessions with spot, option, macro and VIX data;
  4,601,817 option bars; 35,344 reconstructed chain-minutes
- **Fills:** signal on 1-minute close → entry at next 1-minute option bar open
  + slippage; stop-first intrabar ordering
- **Costs:** ₹20/order, 0.1% STT on sell, 0.03503% exchange, 0.003% stamp on
  buy, SEBI turnover fee, 18% GST; slippage shown separately
- **Signal source:** reconstructed production scoring, **not** exact live-VRD
  snapshots. Breadth, FII/DII, MMI, Nifty PE, straddle IV, GIFT Nifty and news
  were unavailable and passed as null/empty.

The run command and report layout are documented in
[`app/core/scripts/options-replay/README.md`](../app/core/scripts/options-replay/README.md).

## Correction: same-bar trailing lookahead

An earlier smoke run exposed a real ordering bug in the replay's trailing
stop: the engine updated the favorable peak with the **current bar's close**
before checking that same bar's low. That let a low earlier in the bar "see" a
peak that only happened later in the same bar, producing an invalidly
pessimistic trailing exit. The peak is now updated only **after** the intrabar
exit check, so a bar's trailing stop uses only peaks from completed bars.

All numbers below are **post-fix**. The earlier pre-fix production result
(about −₹64.5k) must not be used. The no-trail diagnostic is unaffected because
trailing is disabled in that arm.

## Headline

Production config = 20% target, 15% stop, **5% trailing stop**, 6 trades/symbol/day,
OTM-3, 10 bps/side slippage.

| Arm | Trades | Win rate | Gross P&L* | Charges** | Net P&L | Return | Max DD | Profit factor |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Production · filter **on** | 277 | 37.9% | −₹4,461.75 | ₹17,099.92 | **−₹21,561.67** | −21.56% | 21.77% | 0.735 |
| Production · filter **off** | 297 | 36.4% | −₹10,239.75 | ₹18,404.26 | **−₹28,644.01** | −28.64% | 28.64% | 0.683 |
| Production · filter on · **0 bps** | 281 | 37.4% | −₹2,021.25 | ₹17,369.49 | **−₹19,390.74** | −19.39% | 19.77% | 0.761 |
| Production · filter on · **25 bps** | 278 | 37.8% | −₹16,265.25 | ₹17,150.84 | **−₹33,416.09** | −33.42% | 33.42% | 0.624 |
| Diagnostic **no-trail** · filter on | 175 | 47.4% | +₹12,843.00 | ₹10,637.74 | **+₹2,205.26** | +2.21% | 17.12% | 1.022 |
| Diagnostic no-trail · filter off | 199 | 44.2% | +₹4,396.50 | ₹12,068.68 | **−₹7,672.18** | −7.67% | 19.23% | 0.937 |
| Diagnostic no-trail · filter on · **0 bps** | 174 | 47.7% | +₹15,101.25 | ₹10,581.80 | **+₹4,519.45** | +4.52% | 15.91% | 1.045 |
| Diagnostic no-trail · filter on · **25 bps** | 175 | 45.7% | +₹3,706.50 | ₹10,618.43 | **−₹6,911.93** | −6.91% | 21.40% | 0.935 |

\* Gross includes modelled slippage (10 bps arms: ₹4,333.11 production,
₹2,551.32 no-trail).  
\*\* Charges are brokerage + statutory costs, not slippage. Net = gross −
charges.

The ATM variant (OTM-0) was worse: 276 trades, 40.2% win rate,
−₹31,183.44 net, 31.82% max drawdown. OTM-3 is not the source of the loss.

## What the numbers mean

### 1. There is no positive gross edge; costs turn the production arm negative

At 10 bps the production/filter-on arm is **−₹21,561.67 net** after
₹17,099.92 of charges. Its gross P&L is −₹4,461.75 including ₹4,333.11 of
slippage; with zero slippage the separate 0 bps run still has gross
−₹2,021.25 and net **−₹19,390.74**. At 25 bps it is −₹33,416.09 net.

In other words: the frictionless strategy is roughly flat-to-negative before
costs, and the cost burden is decisive. Average net per trade is −₹77.84
(95% bootstrap CI **[−₹167.12, +₹12.92]**); the average charge alone is about
₹61.73/trade. There is no gross alpha here that costs are merely shaving. The
filter-off arm is slightly worse: −₹96.44/trade, 95% CI **[−₹182.73,
−₹8.19]**.

### 2. The 5% trailing stop still causes churn, but removing it is not a validated fix

Exit attribution for production/filter-on:

| Exit reason | Trades |
|---|---:|
| Trailing stop | 209 (75%) |
| Stop-loss | 38 |
| Target | 23 |
| V3 signal reversal | 7 |

Average hold is **9.8 minutes**. Average MFE is +8.11% and average MAE is
−5.89%. The 5% trail converts most trades into short, cost-paying exits; only
23 of 277 reach the 20% target.

The no-trail diagnostic (20% target, 15% stop, no trailing) is
**+₹2,205.26 net** at 10 bps, with a profit factor of 1.022 — essentially
breakeven. It has 175 trades, 47.4% wins, 37.2-minute average hold, and
+₹12,843.00 gross before ₹10,637.74 charges. Removing the trail improves net
by about ₹23.8k versus the production arm, but this is a **post-hoc,
in-sample diagnostic**, not a production recommendation.

### 3. The no-trail result is fragile and March-dependent

The no-trail arm is not statistically distinguishable from zero:

- Mean net per trade: **+₹12.60**, 95% bootstrap CI **[−₹192.49, +₹219.38]**
- Mean net per day: **+₹23.46**, 95% bootstrap CI **[−₹420.42, +₹522.73]**
- 0 bps: +₹4,519; 10 bps: +₹2,205; 25 bps: **−₹6,912**

The entire positive result comes from March:

| Month | No-trail filter-on net |
|---|---:|
| Jan 2026 | −₹11,346.69 |
| Feb 2026 | +₹724.69 |
| Mar 2026 | **+₹17,821.18** |
| Apr 2026 | −₹3,170.74 |
| May 2026 | −₹1,823.18 |

March was a −9.5% NIFTY crash month; PE buying did well. Outside that regime the
arm lost money. A result that flips from +₹4.5k at 0 bps to −₹6.9k at 25 bps is
not robust for OTM options, where real spreads can exceed 25 bps.

The production 5%-trail arm is flat-to-negative in every month: Jan
−₹9,668.49, Feb −₹4,830.61, Mar −₹0.54 (positive gross of +₹3,948.00, eaten by
charges), Apr −₹2,712.89, May −₹4,349.14.

### 4. The 5-min EMA 10/42 veto is not statistically significant

In the production config, filter on improves net P&L by **₹7,082.34** versus
filter off (277 vs 297 trades; gross −₹4,461.75 vs −₹10,239.75). The paired
daily difference is **+₹75.34/day**, 95% bootstrap CI **[−₹106.69,
+₹225.88]** — it includes zero.

In the no-trail diagnostic, filter on improves net by ₹9,877.44; the paired
daily difference is **+₹105.08/day**, 95% CI **[−₹134.45, +₹322.92]** — again
includes zero.

The filter vetoed 285 of 32,222 evaluations (0.88%). In a trending bear market,
PE signals mostly align with the 5-minute trend, so the veto rarely binds. It
reduces trade count and improves gross, but both arms remain negative. This
does **not** justify turning the filter off; it means the reconstructed proxy
has not demonstrated a statistically significant benefit. The exact
`signal_snapshots` A/B remains the right test once the table accumulates.

### 5. Sanity check against the paper ledger

The replay's production loss is **−₹1.04 per unit per trade** (₹21,561.67 /
277 / 75). The daemon paper ledger's 24-trade loss was −₹2.81 per unit
(₹4,379.77 / 24 / 65), and the browser ledger was −₹1.60 per unit. All are
negative; the replay is less negative than the paper daemon. The periods,
samples and signal inputs differ, so this is a sanity check, not validation.

## Verdict

**No verified edge.** The production configuration has no positive gross edge
before costs and loses 21.6% after charges and 10 bps slippage. The 5-minute
filter is not statistically significant in this reconstruction. The no-trail
variant is breakeven at best, is entirely dependent on one crash month, and
does not survive 25 bps slippage. This is not enough to arm live, and it is not
enough to change production exits on its own.

## Decision / next actions

1. **Keep live disarmed.** Keep `DAEMON_LIVE_ARMED` false; continue paper
   trading and snapshot accumulation.
2. **Keep `useMultiTimeframe` on** pending exact snapshot A/B. Do not turn it
   off because the proxy A/B is inconclusive.
3. **Do not change production `trailPct`/target/stop solely from this replay.**
   The no-trail arm was post-hoc and in-sample. If the trailing-stop hypothesis
   is pursued, pre-register a paper A/B (5% vs a wider/no trail) with a fixed
   window and enough trades, and do not arm live during it.
4. **Build the exact snapshot replay** when `signal_snapshots` has several
   weeks of data. This replay's `signalFor` hook is the integration point; the
   table was empty when this run was made.
5. **Refresh Upstox credentials** and use official/Upstox data for
   out-of-sample confirmation before any live decision. HF data is third-party
   research data with no bid/ask and partial far-strike coverage.

## Reproduce

From `app/core`:

```bash
node scripts/options-replay/download-hf.mjs --from 2026-01-01 --to 2026-05-22
node scripts/options-replay/fetch-macro.mjs --from 2026-01-01 --to 2026-05-22

npx tsx scripts/options-replay.ts \
  --from 2026-01-01 --to 2026-05-22 \
  --filter on --slippage-bps 10 \
  --label filter-on-slip10 \
  --out data/replay/reports/filter-on-slip10

node scripts/options-replay/compare.mjs \
  "Production filter on=data/replay/reports/filter-on-slip10" \
  "Production filter off=data/replay/reports/filter-off-slip10" \
  "Production filter on · 0 bps=data/replay/reports/filter-on-slip0" \
  "Production filter on · 25 bps=data/replay/reports/filter-on-slip25" \
  "No-trail filter on=data/replay/reports/filter-on-notrail" \
  "No-trail filter off=data/replay/reports/filter-off-notrail" \
  --baseline="Production filter on" \
  --out=data/replay/reports/comparison.md
```

The generated `report.md` contains the full trade-level table, daily equity,
coverage, signal funnel and exit attribution. `summary.json`, `trades.csv`,
`daily.csv` and `equity.csv` are written next to it. Data and generated reports
live under `app/core/data/replay/` and are not committed.

## Statistical caveat

The confidence intervals above are deterministic i.i.d. bootstrap intervals
over trades/days (20,000 resamples). They ignore autocorrelation, volatility
clustering and regime selection, which makes them a lower bound on uncertainty.
The production/filter-on arm's net CI includes zero, so we do **not** claim
statistical significance for its loss; the filter-off arm is only marginally
negative. The practical conclusion is conservative: there is no statistically
verified positive edge, and the cost burden is real.
