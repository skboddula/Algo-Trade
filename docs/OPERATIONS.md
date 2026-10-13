# Operations Runbook — incident response during trading

> The rule this runbook exists for: **the running daemon never executes
> the working tree.** It runs a pinned snapshot (`/home/shiva/algo-trade-runtime`,
> deployed via `scripts/deploy-daemon.sh`). A bug found mid-session is
> therefore *contained* by design — the fix is developed in parallel while
> the daemon keeps running the old code.

## 1. Classify the bug first

| Class | Example | Urgency |
|---|---|---|
| **A — Entries-only** | bad signals, wrong strike selection, churn | stop entries, keep supervising |
| **B — Exit-layer** | exits not firing, wrong exit orders | immediate — positions at risk |
| **C — Observability** | dashboard shows wrong data, log issues | fix after hours |
| **D — State/ledger** | corruption, persistence faults | immediate — restore path |

## 2. Containment ladder (in order — stop as soon as you're safe)

```bash
# 1. Stop the bot: entries blocked, open positions REMAIN supervised (CR-03)
curl -X POST -H "x-api-key: $KEY" -H "Content-Type: application/json" \
  -d '{"userId":"shiva"}' http://127.0.0.1:3000/api/bot/stop

# 2. Exit a position manually (works even while the bot is stopped)
curl -X POST -H "x-api-key: $KEY" -H "Content-Type: application/json" \
  -d '{"userId":"shiva","symbol":"FINNIFTY","reason":"manual — incident"}' \
  http://127.0.0.1:3000/api/bot/trade/exit

# 3. NUCLEAR (exit path fully broken): close via the Upstox mobile app
#    (live) or accept the simulated loss (paper). Then stop the daemon:
systemctl --user stop algo-trade-daemon
```

## 3. Fix flow (the snapshot architecture at work)

```
1. Develop the fix in Desktop (feat/cloud-deploy) — the daemon keeps
   running the pinned snapshot and supervising positions in parallel
2. Regression test + full suites (79 core · 396 client)
3. Merge → scripts/deploy-daemon.sh <fix-commit>
4. Restart at a SAFE MOMENT: flat preferred; a correctly-supervised
   position survives restarts (recovery restores entry, peak, state)
5. Verify: health · balance · budget · stream · first tick
```

**Rollback** (a fix that made it worse):
```bash
scripts/deploy-daemon.sh <previous-good-commit>   # restart = rollback
```

## 4. State recovery

- Positions, entry price, and the trailing-stop peak persist in SQLite
  (`peakFavorablePrice` is part of the position record) — restarts resume
  supervision exactly where it stopped
- Corrupt store: restore from the backup tarball (repo root,
  `data-backup-*.tar.gz`) or the `*.migrated-*` legacy copies
- Auth0/API-key outage: SSH → `systemctl --user stop algo-trade-daemon`;
  positions closeable via the Upstox app — the daemon trades autonomously
  through IdP outages (verified design: the trading loop never touches auth)

## 5. Restart-safety rules

- Never restart onto unvalidated code — deploy via the script only
- Prefer restarting FLAT; a supervised position survives restarts, but
  if the bug affects supervision itself, exit first, then restart
- The ~10s restart gap delays exits — bounded, and the peak/entry state
  persists so the layers re-evaluate correctly on the first tick
