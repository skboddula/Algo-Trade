# Platform Roadmap — from personal daemon to multi-tenant trading platform

## Vision

Personal always-on trading daemon (laptop, solo, paper) → validated →
cloud-deployed → multi-tenant platform where every user trades their own
Upstox account through their own bot account, with their own capital,
ledger, and identity.

The data layer has been multi-tenant-ready from day one (`user_id`-keyed
D1-verbatim tables, per-user ledgers, scoped logs). The remaining work is
identity, authorization, deployment, and the platform decision itself.

---

## Phase 0 — Solo validation (CURRENT)

- Laptop, local SQLite, Tailscale access, single tenant (`shiva`)
- 2-week paper validation on the frozen config
  (otmSkip 1 · 10/5 · 3 trades/day · 14:30 cutoff · breadth + V3 + SL exits)
- **Gate**: engine correctness + realized performance data
- **Change freeze**: trading logic and storage do not move mid-window

## Phase 1 — Codebase productionization (post-validation)

- Remove the browser fallback bot + its paths (deferred cleanup;
  dissolves the WS-protocol and loop-bookkeeping duplications)
- Auth0 identity on the daemon: JWT verification (jose + JWKS — the
  Worker's `verifyAuth0Token` pattern is portable to Node)
- Per-user Upstox token REQUIRED for live entries (fail-closed; the
  per-user token field and order-call plumbing already exist)
- The single-active-trader invariant becomes per-broker-account scoping
  (concurrent RUNNING users allowed when tokens differ)
- Route-level audit logging: who · what · when on every state-changing call
- Dead-code sweep (`fetchDaemonEquityCurve`, etc.)

## Phase 2 — Cloud deployment

- Target: **OCI ap-mumbai-1 (chosen — trading-loop priority)**:
  always-free ARM A1 up to 4 OCPU/24GB (or 2× x86 micro fallback) ·
  ~2–5ms daemon→Upstox (the engine's critical path: entries, exits,
  SL triggers) vs ~10–15ms from Hyderabad · 200GB block storage ·
  Object Storage 10GB for nightly backups · reserved public IP
  (SEBI whitelisting asset).
  Accepted trade-offs: operator dashboard ~29ms (immaterial), ARM
  capacity contention at signup (retry; x86 micro as fallback)
- Daemon as a systemd system service; dashboard = production build behind
  Caddy/nginx (TLS)
- Access model (decide at deploy): Tailscale-on-VM (private, minimal) or
  public HTTPS + Auth0 (standard cloud app)
- Nightly SQLite backup → object storage (S3/GCS free tier) — required
- Secrets: `.env` 0600 → systemd credentials / cloud secret manager
- IST logic is timezone-independent (verified) — a UTC VM works as-is
- **Environment canary**: 3–5 paper sessions on the cloud before live
  (the engine is proven; the deployment is the new variable)

## Phase 3 — Multi-tenant PAPER (the platform opens, risk-free)

- Auth0 sign-up → tenant onboarding → connect own Upstox (OAuth) → own bot
- Multiple concurrent paper tenants: the invariant relaxes for paper mode
  (paper users share no broker risk)
- Tenant isolation hardening + per-tenant metrics/alerts
- Feedback loop with real users before any real money

## Phase 4 — Multi-tenant LIVE (the platform decision)

- **Regulatory**: SEBI algo-platform framework verification (broker/CA) —
  personal algo trading vs providing algo services to others are
  different regulatory regimes
- **Per-tenant token encryption at rest** becomes MANDATORY (the daemon
  would hold other people's broker tokens — their money's keys)
- Uptime/monitoring commitments; per-tenant restore capability
- Commercial model (optional)
- **Gate**: only after Phase 3 runs clean with real tenants

---

## Decisions already locked (the current architecture is cloud/multi-tenant-ready)

- SQLite single-file pooled store, `user_id`-keyed D1-verbatim tables
- Per-user token fields flowing through entry and exit calls
- CR-18 user-scoped logs; per-user counters/ledgers/statements
- Single-active-trader invariant with a known, small relaxation path
- Auth0 tenant deployed (`algo-trade.us.auth0.com`) + dashboard session
- Account-adjust endpoint (per-tenant capital management)
- Expiry-day (0-DTE) contracts skipped; same-token reconnect churn skipped

## Tuning candidates (post-validation — from Day 1/2 evidence)

1. **Breadth as an ENTRY gate, not just an exit** — Day 1 (Oct 13): 4 of 7
   losses were PE entries exited within 2–10s by "Breadth turned bullish"
   (the breadth was already > 1.5 at entry; the exit fired on the first
   evaluation). Gating PE entries on ratio ≤ 1.5 (and CE on ≥ 0.8 — the
   mirror of the exit rules) would have prevented the churn (~₹400–500 in
   fees+spread) while keeping the winning FINNIFTY CE. Needs breadth-ratio
   telemetry at entry/exit decisions to confirm before changing.
2. **Realized exit-layer asymmetry to track**: Day 1 avg win ₹1,423.74 vs
   avg loss ₹110.72 (the layered exits compress losses far below the −5%
   SL) — the realized breakeven win rate is ~7.6%, not the nominal ~40%.
   Track whether this asymmetry holds across the 2 weeks.
3. **0-DTE trades (Oct 13, 3 trades)** — eliminated by the expiry-day skip
   (fixed Oct 13); verify no 0-DTE recurs on NIFTY expiry days.

## Non-code gates

- SEBI algo framework verification (Phase 4)
- Operator liability/uptime commitment (Phase 4)
- Trust: tenants' broker tokens on the operator's infrastructure
