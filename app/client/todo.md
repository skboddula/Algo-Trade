# Todo List — Algo-Trade

## Background / Offline Strategy Execution Engine

- [ ] **Autonomous Server-Side Strategy Execution**:
  - **Problem**: The strategy bot engine (`useStrategyBot.ts`) currently runs as a React hook inside the user's browser tab. If the user closes the browser, real-time tick polling, technical indicator calculations, trailing stop-loss supervision, and auto-exits stop immediately.
  - **Proposed Solution**: Build a background execution worker / scheduled service (e.g., Cloudflare Workflows, Durable Objects, or a Cron Worker in `app/cron`) to autonomously fetch ticks, evaluate strategy signals, and execute paper/live trade exits even when no browser tabs are active.

## Daemon Snapshot Telemetry (`app/core`)

- [ ] **Deferred — Snapshot capture mode switch (telemetry)** (deferred 2026-10-21):
  - **Why**: exact live-VRD replay needs decision-time snapshots. Current capture is always-on, best-effort, deduped to one row per minute per user+symbol; there is no supported way to raise density during a pre-registered tuning window and then turn it back down.
  - **Decision**: deferred to avoid modifying the critical path while `signal_snapshots` is empty and the Upstox feed/token is unhealthy. Not a prerequisite for paper trading.
  - **Scope when resumed**: `off|signal|full|trade-only` modes; `DAEMON_SNAPSHOT_MODE` / `DAEMON_SNAPSHOT_UNTIL` auto-downgrade; bounded async write queue for `full` rows; provenance fields (VRD source/age, config hash, capture mode); retention rules.
  - **Hard rule**: capture failure must never block scoring or order placement; candidate/trade-linked rows stay synchronous.
  - **Details**: [Deferred: snapshot capture lifecycle](../../docs/options-replay.md#deferred-snapshot-capture-lifecycle-telemetry) · [signal-snapshots.md](../../docs/signal-snapshots.md)
