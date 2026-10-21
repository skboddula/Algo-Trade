// In-memory activity log powering the daemon window's Bot Logs panel.
//
// Two bounded rings keep the important events safe from high-volume noise:
//   - activity: info/warn/error (curated bot/feed/order/risk events)
//   - debug:    scoring traces, dropped at the source when disabled
//
// Debug traces can be coalesced (the default): identical evaluations for the
// same key are folded into a counter and a line is emitted only when the
// state changes or the heartbeat elapses. Suppressed ticks refresh the last
// emitted line in place, so a backlog fetch still sees accurate counts.
//
// Everything here is fire-and-forget and never throws into the trading path;
// a misbehaving subscriber cannot break the daemon either.

export type ActivityLevel = 'info' | 'warn' | 'error' | 'debug'

export interface ActivityEntry {
  /** Monotonic per-process id — used by the window to dedupe backlog + live. */
  seq: number
  ts: string
  level: ActivityLevel
  source: string
  msg: string
  /** Coalesced lines: identical evaluations suppressed before this one. */
  repeatCount?: number
  /** Coalesced lines: ms since the previous emitted line for this key. */
  heldMs?: number
}

/** Repeat metadata handed to a coalesced message builder. */
export interface CoalesceInfo {
  /** Identical evaluations suppressed since the previous emitted line. */
  repeatCount: number
  /** Time elapsed since the previous emitted line for this key. */
  heldMs: number
}

export interface ActivityLogOptions {
  /** Cap for info/warn/error entries (default 500). */
  activityCap?: number
  /** Cap for debug entries (default 150). */
  debugCap?: number
  /** When false, debug entries are dropped at the source (default true). */
  debugEnabled?: boolean
  /** When false, addCoalesced() emits every call (per-tick stream). */
  coalesceDebug?: boolean
  /**
   * Re-emit an unchanged coalesced line at most this often, so a static
   * state still refreshes its numbers (default 60 000 ms; 0 = never).
   */
  coalesceHeartbeatMs?: number
}

interface CoalesceState {
  fingerprint: string
  lastEmitAtMs: number
  repeatCount: number
  entry: ActivityEntry | null
}

export class ActivityLog {
  private seq = 0
  private activity: ActivityEntry[] = []
  private debug: ActivityEntry[] = []
  private listeners = new Set<(entry: ActivityEntry) => void>()
  private readonly activityCap: number
  private readonly debugCap: number
  private readonly coalesceDebug: boolean
  private readonly coalesceHeartbeatMs: number
  private debugEnabled: boolean
  private coalesceState = new Map<string, CoalesceState>()

  constructor(opts: ActivityLogOptions = {}) {
    this.activityCap = Math.max(1, opts.activityCap ?? 500)
    this.debugCap = Math.max(1, opts.debugCap ?? 150)
    this.debugEnabled = opts.debugEnabled ?? true
    this.coalesceDebug = opts.coalesceDebug ?? true
    const heartbeat = opts.coalesceHeartbeatMs
    this.coalesceHeartbeatMs =
      heartbeat !== undefined && Number.isFinite(heartbeat) && heartbeat >= 0
        ? heartbeat
        : 60_000
  }

  /** Whether debug entries are currently generated (DAEMON_ACTIVITY_DEBUG). */
  public isDebugEnabled(): boolean {
    return this.debugEnabled
  }

  public setDebugEnabled(enabled: boolean): void {
    if (!enabled) this.coalesceState.clear()
    this.debugEnabled = enabled
  }

  /**
   * Append an entry and fan it out to subscribers. Never throws.
   * Returns the stored entry, or null when the entry was dropped.
   */
  public add(
    level: ActivityLevel,
    source: string,
    msg: string,
  ): ActivityEntry | null {
    if (level === 'debug' && !this.debugEnabled) return null
    const entry: ActivityEntry = {
      seq: ++this.seq,
      ts: new Date().toISOString(),
      level,
      source,
      msg,
    }
    if (level === 'debug') {
      this.push(this.debug, entry, this.debugCap)
    } else {
      this.push(this.activity, entry, this.activityCap)
    }
    for (const listener of this.listeners) {
      try {
        listener(entry)
      } catch {
        // A bad subscriber must never affect the daemon or other listeners.
      }
    }
    return entry
  }

  /**
   * Change-only debug emission. Identical evaluations for the same key are
   * suppressed; a line is emitted when the fingerprint changes or when the
   * heartbeat elapses. Suppressed ticks update the last emitted ring entry in
   * place (message + counters) so the backlog stays accurate — no extra
   * frames or rows.
   */
  public addCoalesced(opts: {
    /** Per-user/symbol key; coalescing state is independent per key. */
    key: string
    /** The semantic state that decides whether a new line is warranted. */
    fingerprint: string
    source: string
    /** Builds the message from current values + repeat metadata. */
    buildMessage: (info: CoalesceInfo) => string
    level?: ActivityLevel
    /** Per-call override of the log-wide heartbeat (0 = never). */
    heartbeatMs?: number
  }): void {
    const level = opts.level ?? 'debug'
    if (level === 'debug' && !this.debugEnabled) return

    // Full-stream mode: emit every evaluation, no coalescing.
    if (!this.coalesceDebug) {
      this.add(level, opts.source, opts.buildMessage({ repeatCount: 0, heldMs: 0 }))
      return
    }

    const heartbeatMs = opts.heartbeatMs ?? this.coalesceHeartbeatMs
    const now = Date.now()
    const prev = this.coalesceState.get(opts.key)

    if (
      prev &&
      prev.fingerprint === opts.fingerprint &&
      (heartbeatMs <= 0 || now - prev.lastEmitAtMs < heartbeatMs)
    ) {
      prev.repeatCount += 1
      if (prev.entry) {
        const info: CoalesceInfo = {
          repeatCount: prev.repeatCount,
          heldMs: now - prev.lastEmitAtMs,
        }
        prev.entry.repeatCount = info.repeatCount
        prev.entry.heldMs = info.heldMs
        prev.entry.msg = opts.buildMessage(info)
      }
      return
    }

    const unchangedRun = prev?.fingerprint === opts.fingerprint
    const info: CoalesceInfo = {
      repeatCount: unchangedRun ? prev!.repeatCount : 0,
      heldMs: unchangedRun ? now - prev!.lastEmitAtMs : 0,
    }
    const entry = this.add(level, opts.source, opts.buildMessage(info))
    if (entry) {
      entry.repeatCount = info.repeatCount
      entry.heldMs = info.heldMs
    }
    this.coalesceState.set(opts.key, {
      fingerprint: opts.fingerprint,
      lastEmitAtMs: now,
      repeatCount: 0,
      entry,
    })
  }

  /** Newest-last merged backlog (activity + debug), capped to `limit`. */
  public backlog(limit = 200): ActivityEntry[] {
    const merged = [...this.activity, ...this.debug].sort((a, b) => a.seq - b.seq)
    if (limit >= merged.length) return merged
    return merged.slice(merged.length - limit)
  }

  /** Subscribe to live entries; returns the unsubscribe function. */
  public subscribe(listener: (entry: ActivityEntry) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private push(ring: ActivityEntry[], entry: ActivityEntry, cap: number): void {
    ring.push(entry)
    if (ring.length > cap) ring.splice(0, ring.length - cap)
  }
}
