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

- Target: GCP e2-micro (always-free) / Oracle ARM (always-free, larger) /
  AWS t3.micro (12-month free) — any handles the ~180MB daemon
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

## Non-code gates

- SEBI algo framework verification (Phase 4)
- Operator liability/uptime commitment (Phase 4)
- Trust: tenants' broker tokens on the operator's infrastructure
