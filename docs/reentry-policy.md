# Re-entry policy — pre-registered 2026-10-21

**Status:** frozen for the next paper session (2026-10-22). Paper-only;
live remains disarmed. This policy was chosen after the 2026-10-21 NIFTY
symbol-cap exhaustion: six NIFTY slots were consumed by score-10/13 entries
before the score-17 strong cluster at 12:34–12:35.

**Revision (2026-10-21 evening, before the first session under this policy):**
the total cap was amended 18 → 24 so the envelope equals the full three-symbol
sweep (3 × 8). No session had run under the policy yet, so the pre-registration
stays clean; the change is arithmetic (symmetry), not evidence-driven. The
per-symbol cap is unchanged at 8.

The 8/24 caps and the 5-minute all-exit cooldown are hard limits. Strategy
config may lower a cap but the daemon will not allow it to rise above 8 per
symbol or 24 total.

## Entry ladder

| Previous valid exit (net) | Moderate signal | Strong signal |
|---|---|---|
| Net win | Same or higher directional score | Any strong repeat |
| Net loss or scratch | +2 directional score, or direction flip | Any strong repeat |
| No prior exit | Allowed | Allowed |

- **Strong repeats are unlimited** only within the hard stops below. A strong
  signal bypasses the no-new-information gate and the two-loss pause.
- **Directional score** is `bullScore` for CE and `bearScore` for PE.
- **Net P&L** is after simulated/actual fill slippage and the statutory cost
  model (brokerage, STT, exchange fee, stamp duty, SEBI fee, GST). A gross win
  can therefore be a net loss.
- **Scratch** is treated as a non-win: moderate re-entries need +2 or a flip.

## Hard stops (both confidence levels)

| Condition | Effect |
|---|---|
| 5 minutes since any exit | No new entry for that symbol |
| 2 consecutive net losses | Moderate entries paused for 30 minutes; strong allowed |
| 3 consecutive net losses | Symbol rests for the rest of the IST day; strong included |
| 8 entries per symbol in the IST day | No further entries for that symbol |
| 24 entries total in the IST day | No further entries for any symbol |

The 30-minute pause blocks all moderate entries, including improved scores.
After the pause, the normal +2/flip gate applies. A strong entry during the
pause is allowed, but a third consecutive net loss still ends the symbol's day.

## Persistence and telemetry

The daemon persists, per symbol:

- directional score and confidence at the last valid fill;
- net P&L of the last valid exit;
- consecutive net-loss count;
- pause-until timestamp;
- rest-of-day flag.

Snapshot `blockedReason` values are `symbol-cap`, `total-cap`, `cooldown`,
`loss-pause`, `rest-of-day`, and `no-new-information`. Snapshot context also
records the last entry score, last exit net P&L, loss streak, pause remaining,
and the rest-of-day flag.

Rejected orders and exits with an unknown outcome do not count as wins. A
failed/unknown exit is treated as a scratch for the moderate gate while strong
signals remain bounded by caps, cooldown, and the rest-of-day stop.

## Out of scope / open evidence items

- The historical NIFTY `paper_tr_1792565485514_mj4be` void still needs to be
  excluded from the 2026-10-21 evidence count; it does not affect the next
  session because daily counters reset.
- The exact snapshot replay engine and replay-side re-entry modeling are still
  pending. Do not treat Apr–May replay results as validation of this policy;
  those months are consumed.
- Live arming remains blocked on cost-aware out-of-sample evidence plus the
  SEBI/static-IP, host, token, and order-IP prerequisites.
