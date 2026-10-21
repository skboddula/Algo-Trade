// In-memory activity log powering the daemon window's Bot Logs panel.
//
// Two bounded rings keep the important events safe from high-volume noise:
//   - activity: info/warn/error (curated bot/feed/order/risk events)
//   - debug:    per-tick scoring lines, dropped at the source when disabled
//
// `add()` is fire-and-forget and never throws into the trading path; a
// misbehaving subscriber cannot break the daemon either.

export type ActivityLevel = 'info' | 'warn' | 'error' | 'debug'

export interface ActivityEntry {
  /** Monotonic per-process id — used by the window to dedupe backlog + live. */
  seq: number
  ts: string
  level: ActivityLevel
  source: string
  msg: string
}

export interface ActivityLogOptions {
  /** Cap for info/warn/error entries (default 500). */
  activityCap?: number
  /** Cap for debug entries (default 150). */
  debugCap?: number
  /** When false, debug entries are dropped at the source (default true). */
  debugEnabled?: boolean
}

export class ActivityLog {
  private seq = 0
  private activity: ActivityEntry[] = []
  private debug: ActivityEntry[] = []
  private listeners = new Set<(entry: ActivityEntry) => void>()
  private readonly activityCap: number
  private readonly debugCap: number
  private debugEnabled: boolean

  constructor(opts: ActivityLogOptions = {}) {
    this.activityCap = Math.max(1, opts.activityCap ?? 500)
    this.debugCap = Math.max(1, opts.debugCap ?? 150)
    this.debugEnabled = opts.debugEnabled ?? true
  }

  /** Whether debug entries are currently generated (DAEMON_ACTIVITY_DEBUG). */
  public isDebugEnabled(): boolean {
    return this.debugEnabled
  }

  public setDebugEnabled(enabled: boolean): void {
    this.debugEnabled = enabled
  }

  /** Append an entry and fan it out to subscribers. Never throws. */
  public add(level: ActivityLevel, source: string, msg: string): void {
    if (level === 'debug' && !this.debugEnabled) return
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
