/**
 * Bounded, persistent bot activity log — the daemon-side equivalent of the
 * browser bot's in-tab log feed. Lines survive page reloads (they live in the
 * daemon, not the browser) and daemon restarts (disk persistence), and are
 * broadcast to dashboard clients over the WebSocket as BOT_LOG messages.
 */
import { EventEmitter } from 'events'
import { loadState, saveState } from '../utils/store'

export interface BotLog {
  id: string
  ts: string
  level: 'info' | 'warn' | 'error' | 'debug'
  source: string
  msg: string
}

const MAX_LOGS = 500
const PERSIST_DEBOUNCE_MS = 5_000
const STORE_NAME = 'bot_logs'

export class BotLogService extends EventEmitter {
  private logs: BotLog[] = []
  private persistTimer: NodeJS.Timeout | null = null

  constructor() {
    super()
    this.setMaxListeners(100)
    const stored = loadState<BotLog[]>(STORE_NAME)
    if (Array.isArray(stored)) {
      this.logs = stored.filter((l) => l && typeof l.msg === 'string').slice(-MAX_LOGS)
    }
  }

  /** Appends a log line, emits it to listeners, and schedules persistence. */
  public add(
    level: BotLog['level'],
    source: string,
    msg: string,
  ): BotLog {
    const line: BotLog = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      ts: new Date().toISOString(),
      level,
      source,
      msg,
    }
    this.logs.push(line)
    if (this.logs.length > MAX_LOGS) {
      this.logs.splice(0, this.logs.length - MAX_LOGS)
    }
    this.emit('log', line)

    if (!this.persistTimer) {
      this.persistTimer = setTimeout(() => {
        this.persistTimer = null
        saveState(STORE_NAME, this.logs)
      }, PERSIST_DEBOUNCE_MS)
    }
    return line
  }

  /** Convenience wrappers matching the browser bot's mkLog levels. */
  public info(source: string, msg: string): void {
    this.add('info', source, msg)
  }

  public warn(source: string, msg: string): void {
    this.add('warn', source, msg)
  }

  public error(source: string, msg: string): void {
    this.add('error', source, msg)
  }

  /** Returns the most recent `limit` lines (oldest first). */
  public get(limit = 200): BotLog[] {
    return this.logs.slice(-Math.max(1, limit))
  }

  /** Flushes pending lines to disk immediately (used on shutdown). */
  public flush(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
    saveState(STORE_NAME, this.logs)
  }
}
