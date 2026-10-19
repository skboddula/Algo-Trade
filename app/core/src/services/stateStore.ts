import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import type { DatabaseSync as DatabaseSyncType, StatementSync } from 'node:sqlite'
import type { PaperAccount, PaperTradeRecord, UserBotState } from '../types'

// `node:sqlite` is a prefixed-only builtin (Node >= 22.5) that some transform
// pipelines predate — load it through createRequire so both the compiled CJS
// build and vitest's vite-node resolve it natively. The `import type` above is
// erased at runtime.
const nodeRequire = createRequire(__filename)
const { DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite')

/**
 * Durable state store for the always-on daemon, backed by SQLite
 * (`node:sqlite` — built into Node, no native dependencies).
 *
 * Persists the state that must survive daemon restarts and machine reboots
 * so open positions keep being supervised where they stopped:
 *   - bot_state        : per-user UserBotState (positions, trailing-SL peak, counters)
 *   - paper_accounts   : paper ledger balances
 *   - paper_trades     : paper ledger trade history
 *   - daemon_settings  : window-managed settings (Upstox OAuth credentials, master token)
 *
 * The database file lives in DATA_DIR (default: ./data) and is created with
 * 0600 permissions. It contains broker tokens, so treat it as a secret.
 */
export class StateStore {
  private db: DatabaseSyncType
  private closed = false
  /** CR-15: rows skipped during the last load (unreadable JSON), for surfacing. */
  private loadErrors: string[] = []
  private saveUserStmt: StatementSync
  private loadUsersStmt: StatementSync
  private saveAccountStmt: StatementSync
  private loadAccountsStmt: StatementSync
  private saveTradeStmt: StatementSync
  private loadTradesStmt: StatementSync
  private getSettingStmt: StatementSync
  private saveSettingStmt: StatementSync
  private deleteSettingStmt: StatementSync

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true })
    const dbPath = path.join(dataDir, 'algo-trade.sqlite')
    this.db = new DatabaseSync(dbPath)
    try {
      fs.chmodSync(dbPath, 0o600)
    } catch {
      // Best effort — some filesystems do not support chmod.
    }
    this.db.exec('PRAGMA journal_mode = WAL;')
    this.db.exec('PRAGMA synchronous = NORMAL;')
    this.migrate()

    this.saveUserStmt = this.db.prepare(
      `INSERT INTO bot_state (user_id, state_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         state_json = excluded.state_json,
         updated_at = excluded.updated_at`,
    )
    this.loadUsersStmt = this.db.prepare(
      'SELECT user_id, state_json FROM bot_state ORDER BY user_id',
    )
    this.saveAccountStmt = this.db.prepare(
      `INSERT INTO paper_accounts (id, user_id, mode, balance, currency, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         user_id = excluded.user_id,
         mode = excluded.mode,
         balance = excluded.balance,
         currency = excluded.currency,
         updated_at = excluded.updated_at`,
    )
    this.loadAccountsStmt = this.db.prepare(
      `SELECT id, user_id, mode, balance, currency, updated_at
       FROM paper_accounts ORDER BY id`,
    )
    this.saveTradeStmt = this.db.prepare(
      `INSERT INTO paper_trades (
         id, account_id, status, instrument_key, direction, quantity,
         entry_price, entry_value, exit_price, exit_value, realized_pnl,
         opened_at, closed_at, metadata_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         status = excluded.status,
         exit_price = excluded.exit_price,
         exit_value = excluded.exit_value,
         realized_pnl = excluded.realized_pnl,
         closed_at = excluded.closed_at,
         metadata_json = excluded.metadata_json`,
    )
    this.loadTradesStmt = this.db.prepare(
      `SELECT id, account_id, status, instrument_key, direction, quantity,
              entry_price, entry_value, exit_price, exit_value, realized_pnl,
              opened_at, closed_at, metadata_json
       FROM paper_trades ORDER BY opened_at`,
    )
    this.getSettingStmt = this.db.prepare('SELECT value FROM daemon_settings WHERE key = ?')
    this.saveSettingStmt = this.db.prepare(
      `INSERT INTO daemon_settings (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`,
    )
    this.deleteSettingStmt = this.db.prepare('DELETE FROM daemon_settings WHERE key = ?')
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bot_state (
        user_id TEXT PRIMARY KEY,
        state_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS paper_accounts (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        mode TEXT,
        balance INTEGER NOT NULL,
        currency TEXT NOT NULL DEFAULT 'INR',
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS paper_trades (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        status TEXT NOT NULL,
        instrument_key TEXT NOT NULL,
        direction TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        entry_price INTEGER,
        entry_value INTEGER,
        exit_price INTEGER,
        exit_value INTEGER,
        realized_pnl INTEGER,
        opened_at TEXT NOT NULL,
        closed_at TEXT,
        metadata_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_paper_trades_account
        ON paper_trades(account_id, status);
      CREATE TABLE IF NOT EXISTS daemon_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `)
  }

  public saveUserState(user: UserBotState): void {
    this.saveUserStmt.run(
      user.userId,
      JSON.stringify(user),
      user.updatedAt ?? new Date().toISOString(),
    )
  }

  public loadUserStates(): UserBotState[] {
    this.loadErrors = []
    const rows = this.loadUsersStmt.all() as { user_id: string; state_json: string }[]
    const users: UserBotState[] = []
    for (const row of rows) {
      try {
        users.push(JSON.parse(row.state_json) as UserBotState)
      } catch (err) {
        // Skip unreadable rows rather than failing daemon startup, but keep
        // the failure so the caller can surface it (CR-15) — a skipped row
        // can mean an open position the daemon no longer knows about.
        this.loadErrors.push(`${row.user_id}: ${(err as Error).message}`)
      }
    }
    return users
  }

  /** CR-15: unreadable rows skipped by the most recent loadUserStates(). */
  public getLoadErrors(): string[] {
    return [...this.loadErrors]
  }

  public savePaperAccount(account: PaperAccount): void {
    this.saveAccountStmt.run(
      account.id,
      account.userId ?? '',
      account.mode ?? 'paper',
      account.balance,
      account.currency ?? 'INR',
      account.updatedAt ?? account.updated_at ?? new Date().toISOString(),
    )
  }

  public loadPaperAccounts(): PaperAccount[] {
    const rows = this.loadAccountsStmt.all() as {
      id: string
      user_id: string
      mode: string | null
      balance: number
      currency: string
      updated_at: string
    }[]
    return rows.map((row) => ({
      id: row.id,
      userId: row.user_id || row.id.replace(/^paper_acc_/, ''),
      mode: row.mode ?? 'paper',
      balance: row.balance,
      currency: row.currency,
      updatedAt: row.updated_at,
    }))
  }

  public savePaperTrade(trade: PaperTradeRecord): void {
    this.saveTradeStmt.run(
      trade.id,
      trade.accountId,
      trade.status,
      trade.instrumentKey,
      trade.direction,
      trade.quantity,
      trade.entryPrice ?? null,
      trade.entryValue ?? null,
      trade.exitPrice ?? null,
      trade.exitValue ?? null,
      trade.realizedPnl ?? null,
      trade.openedAt,
      trade.closedAt ?? null,
      trade.metadata ? JSON.stringify(trade.metadata) : null,
    )
  }

  public loadPaperTrades(): PaperTradeRecord[] {
    const rows = this.loadTradesStmt.all() as {
      id: string
      account_id: string
      status: string
      instrument_key: string
      direction: string
      quantity: number
      entry_price: number | null
      entry_value: number | null
      exit_price: number | null
      exit_value: number | null
      realized_pnl: number | null
      opened_at: string
      closed_at: string | null
      metadata_json: string | null
    }[]
    return rows.map((row) => {
      let metadata: Record<string, unknown> | undefined
      if (row.metadata_json) {
        try {
          metadata = JSON.parse(row.metadata_json) as Record<string, unknown>
        } catch {
          metadata = undefined
        }
      }
      return {
        id: row.id,
        accountId: row.account_id,
        status: row.status as PaperTradeRecord['status'],
        instrumentKey: row.instrument_key,
        direction: row.direction as PaperTradeRecord['direction'],
        quantity: row.quantity,
        entryPrice: row.entry_price ?? 0,
        entryValue: row.entry_value ?? 0,
        exitPrice: row.exit_price ?? undefined,
        exitValue: row.exit_value ?? undefined,
        realizedPnl: row.realized_pnl ?? undefined,
        openedAt: row.opened_at,
        closedAt: row.closed_at ?? undefined,
        metadata,
      }
    })
  }

  /**
   * Read a window-managed setting (see DAEMON_SETTING_KEYS). Returns undefined
   * when unset. Values may be secrets (Upstox credentials) — never expose them
   * to the browser verbatim.
   */
  public getSetting(key: string): string | undefined {
    const row = this.getSettingStmt.get(key) as { value: string } | undefined
    return row?.value
  }

  /** Persist a window-managed setting (upsert). */
  public setSetting(key: string, value: string): void {
    this.saveSettingStmt.run(key, value, new Date().toISOString())
  }

  /** Remove a window-managed setting. */
  public deleteSetting(key: string): void {
    this.deleteSettingStmt.run(key)
  }

  public close(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.db.close()
    } catch {
      // Already closed or failed to close — nothing sensible left to do.
    }
  }
}
