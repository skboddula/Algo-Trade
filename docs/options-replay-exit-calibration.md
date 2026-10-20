# NIFTY options replay — exit calibration (Jan–May 2026)

**Status: no candidate. Do not change production exits or arm live on this
result.**

This is the follow-up to the
[Jan–May replay evidence review](options-replay.md). It asks one narrow
question:

> Can a different trailing stop, target or stop-loss turn the negative
> strategy-plan baseline into a robust positive edge?

The answer from this grid is **no**. Removing or widening the 5% trailing stop
does move the baseline from a large loss to roughly breakeven, but the best arms
are entirely dependent on March 2026, fail out-of-sample in April–May, and fail
a 25 bps slippage stress. No variant is eligible for a production change or a
paper A/B promotion.

## Method

- **Ten exit arms** on the strategy-plan baseline: OTM-3, 14:30 entry cutoff,
  15:30 square-off, 5-min EMA 10/42 filter on, 6 trades/symbol/day, 1 lot,
  NIFTY lot size 75.
- **Costs:** statutory brokerage/STT/exchange/stamp/SEBI/GST, plus 10 bps
  slippage per side. The shortlist was also run at 25 bps per side.
- **Calibration:** 2026-01-01 → 2026-03-31.
- **Validation:** 2026-04-01 → 2026-05-22 (held out from arm selection).
- **Selection rule, fixed before reading validation:** at least 30 calibration
  trades, positive calibration net P&L, calibration profit factor > 1.10, and a
  positive month in at least 2 of the 3 calibration months. The top three were
  to be stressed at 25 bps.
- **Promotion rule:** validation net P&L > 0 at 25 bps, validation profit
  factor > 1.10, validation max drawdown < 15%, at least 30 validation trades,
  and both April and May positive.

The grid is documented in
[`app/core/scripts/options-replay/configs/exit-grid-2026.json`](../app/core/scripts/options-replay/configs/exit-grid-2026.json).
It changes exits only. It does **not** test a time stop, entry cutoff,
confidence threshold, strike selection or regime filter.

## Calibration result (10 bps)

Sorted by calibration net P&L. Only the first four arms were positive, and none
cleared the pre-specified 1.10 profit-factor floor.

| Arm | Cal trades | Win rate | Cal net | Cal PF | Cal max DD | Cal expectancy | Hold |
|---|---:|---:|---:|---:|---:|---:|---:|
| No trail · target 20% | 127 | 48.8% | +₹7,199.18 | 1.099 | 17.12% | +₹56.69 | 35.9 min |
| No trail · target 25% | 110 | 42.7% | +₹5,864.85 | 1.084 | 19.78% | +₹53.32 | 44.8 min |
| No trail · target 30% | 101 | 39.6% | +₹4,106.01 | 1.058 | 18.55% | +₹40.65 | 50.2 min |
| Trail 10% · target 20% | 183 | 36.6% | +₹36.91 | 1.001 | 18.33% | +₹0.20 | 17.4 min |
| Trail 10% · target 30% | 177 | 33.3% | −₹5,295.95 | 0.927 | 25.14% | −₹29.92 | 19.1 min |
| Trail 10% · target 25% | 180 | 34.4% | −₹6,004.43 | 0.916 | 23.78% | −₹33.36 | 18.7 min |
| Trail 10% · target 25% · stop 20% | 174 | 33.9% | −₹8,091.89 | 0.887 | 24.25% | −₹46.51 | 20.8 min |
| Trail 8% · target 20% | 191 | 37.2% | −₹12,125.52 | 0.820 | 17.81% | −₹63.48 | 13.3 min |
| Trail 5% · baseline | 197 | 38.6% | −₹14,499.64 | 0.759 | 18.90% | −₹73.60 | 10.1 min |
| Trail 8% · target 25% | 189 | 36.0% | −₹18,137.62 | 0.736 | 25.49% | −₹95.97 | 14.7 min |

The no-trail result is the same post-hoc diagnostic seen in the main review:
the 5% trail creates churn, and removing it improves the calibration window.
But the no-trail arm's profit factor is **1.099**, just below the 1.10 floor,
and its January is **−₹11,346.69** while March is **+₹17,821.18**. The other
two positive arms are also March-dependent:

| Arm | Jan 2026 | Feb 2026 | Mar 2026 |
|---|---:|---:|---:|
| No trail · target 20% | −₹11,346.69 | +₹724.69 | +₹17,821.18 |
| No trail · target 25% | −₹15,765.19 | +₹2,728.63 | +₹18,901.41 |
| No trail · target 30% | −₹13,299.22 | +₹2,069.66 | +₹15,335.57 |
| Trail 10% · target 20% | −₹15,635.55 | +₹1,353.47 | +₹14,318.99 |
| Trail 5% · baseline | −₹9,668.49 | −₹4,830.61 | −₹0.54 |

Because no arm cleared the calibration gate, the pre-registered shortlist is
empty. The validation and 25 bps checks below are diagnostics, not promotions.

## Validation result (10 bps)

Every arm lost money in both April and May. The top four calibration arms are
shown, plus the baseline.

| Arm | Val trades | Win rate | Val net | Val PF | Val max DD | Val expectancy |
|---|---:|---:|---:|---:|---:|---:|
| No trail · target 20% | 48 | 43.8% | −₹4,993.92 | 0.828 | 5.35% | −₹104.04 |
| No trail · target 25% | 43 | 37.2% | −₹6,096.83 | 0.790 | 7.48% | −₹141.79 |
| No trail · target 30% | 39 | 33.3% | −₹5,108.02 | 0.816 | 6.36% | −₹130.97 |
| Trail 10% · target 20% | 68 | 30.9% | −₹10,720.47 | 0.617 | 10.72% | −₹157.65 |
| Trail 5% · baseline | 80 | 36.3% | −₹7,062.03 | 0.671 | 7.27% | −₹88.28 |

Monthly validation:

| Arm | Apr 2026 | May 2026 |
|---|---:|---:|
| No trail · target 20% | −₹3,170.74 | −₹1,823.18 |
| No trail · target 25% | −₹3,142.37 | −₹2,954.46 |
| No trail · target 30% | −₹3,537.53 | −₹1,570.49 |
| Trail 10% · target 20% | −₹5,896.05 | −₹4,824.42 |
| Trail 5% · baseline | −₹2,712.89 | −₹4,349.14 |

The best full-window 10 bps result is still the no-trail target-20 arm at
**+₹2,205.26**, but that is +₹7,199 in calibration and −₹4,994 in validation.
The no-trail target-25 and target-30 arms are −₹231.98 and −₹1,002.01 over the
full window: essentially breakeven, not an edge.

## 25 bps stress

The three no-trail arms were rerun at 25 bps. The target-25 arm is still
slightly positive in calibration (+₹2,280.85, PF 1.031), but its validation is
**−₹9,213.95**; the target-30 arm is +₹703.65 calibration and −₹5,645.08
validation. The original no-trail target-20 arm is negative even in calibration
at 25 bps.

| Arm · 25 bps | Cal net | Cal PF | Val net | Val PF | Full-window net | Full PF |
|---|---:|---:|---:|---:|---:|---:|
| No trail · target 20% | −₹218.77 | 0.997 | −₹6,693.16 | 0.780 | −₹6,911.93 | 0.935 |
| No trail · target 25% | +₹2,280.85 | 1.031 | −₹9,213.95 | 0.696 | −₹6,933.10 | 0.933 |
| No trail · target 30% | +₹703.65 | 1.010 | −₹5,645.08 | 0.799 | −₹4,941.43 | 0.951 |

The cost arithmetic is decisive. At 10 bps the no-trail target-25 arm has
**+₹9,106.50 gross** and **₹9,338.48 charges**, leaving −₹231.98. At 25 bps
its gross falls to **+₹2,515.50** against **₹9,448.60 charges**, leaving
−₹6,933.10. The strategy does not have enough gross edge to pay for its
turnover, even before real bid/ask spreads.

## Interpretation

1. **The 5% trail is a real source of churn.** The baseline has 209 trailing
   exits in 277 trades and a 9.8-minute average hold. Removing the trail raises
   the win rate and average hold, and moves the full-window result from
   −₹21,561.67 to roughly breakeven.
2. **Removing or widening the trail is not sufficient.** The no-trail arms have
   lower turnover but still only cover, or fail to cover, their own charges.
   Their calibration profit is a March crash artifact; January and both
   validation months are negative. The full-window no-trail target-25 arm has a
   41.2% win rate against a 41.2% net breakeven win rate and a 0.998 profit
   factor—it is exactly at breakeven, not above it.
3. **Costs and slippage are not a rounding error.** At 10 bps the best arm is
   within ₹232 of breakeven; at 25 bps the same family loses ₹4,941–₹6,933.
   Real OTM option spreads can be wider than 25 bps.
4. **Exit-only calibration is exhausted.** Ten combinations of trail, target
   and stop did not produce a validation survivor. Further tuning on this same
   Jan–May window would be data mining. A next phase must use fresh data and
   change entry quality, frequency, regime or execution—not just exits.

## Decision

- **Do not change production `trailPct`, target or stop from this grid.**
- **Keep the daemon in paper mode and keep live disarmed.**
- **Freeze the current paper config for snapshot collection**, or explicitly
  choose the strategy-plan baseline; do not change it mid-collection.
- Do not promote the no-trail arm to production. It is a diagnostic that says
  "the trail is costly", not a validated replacement.
- Do not use April–May again as a fresh test set. It has now been used for
  validation.

## Next experiments, in order

1. **Exact `signal_snapshots` replay** once the table has several weeks of
   data. Reconstructed inputs are still missing breadth, FII/DII, MMI, Nifty
   PE, straddle IV, GIFT Nifty and news.
2. **Entry quality / frequency**, pre-registered on fresh data: strong-only vs
   moderate, max 2–3 trades/day, 13:00/14:00 cutoff, no first 5–10 minutes.
   Fewer trades reduce the ~₹62/trade charge burden, but only if the selected
   trades keep their gross edge.
3. **Time stop / max hold**, which was not implemented in this replay. Test it
   as a separate pre-registered arm, not as another post-hoc exit tweak.
4. **Execution and liquidity:** actual bid/ask, volume/OI filters, limit-order
   assumptions, ATM vs OTM spread comparison. The 25 bps proxy is not a
   substitute for real spreads.
5. **Regime and symmetry:** check CE and PE separately; require the result to
   survive outside a crash month; test 15-minute/daily alignment as a
   pre-registered filter, not a March-specific rule.

If a future phase cannot produce a validation-positive result at 25 bps, the
correct decision is to keep the strategy in paper or stop trading it, not to
keep searching this dataset.

## Reproduce

From `app/core`:

```bash
# 10 bps exit arms; labels match configs/exit-grid-2026.json.
npx tsx scripts/options-replay.ts \
  --from 2026-01-01 --to 2026-05-22 \
  --filter on --slippage-bps 10 \
  --trail-pct 0 --max-profit-pct 25 --max-loss-pct 15 \
  --label grid-t0-r25-s15 \
  --out data/replay/reports/grid-t0-r25-s15

# Calibration only; validation stays hidden until the shortlist is frozen.
node scripts/options-replay/calibrate.mjs \
  "No trail / target 25=data/replay/reports/grid-t0-r25-s15" \
  --split=2026-04-01 \
  --out=data/replay/reports/calibration.md

# After freezing, show validation.
node scripts/options-replay/calibrate.mjs \
  "No trail / target 25=data/replay/reports/grid-t0-r25-s15" \
  --split=2026-04-01 --validation \
  --out=data/replay/reports/validation.md
```

Generated reports are under `app/core/data/replay/reports/` and are not
committed. `summary.json`, `trades.csv`, `daily.csv` and `equity.csv` sit next
to each report.
