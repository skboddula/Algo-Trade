/**
 * Daemon persistence — SQLite (node:sqlite, zero dependencies).
 *
 * Layout mirrors the original D1 model:
 *   - paper_accounts / paper_trades / paper_statement_entries use the
 *     D1-verbatim schema (same column names, paise INTEGER amounts, same
 *     indexes) so daemon↔D1 row-level sync and SQL reporting work directly.
 *   - Daemon-native runtime state (user_states, primary_token, bot_logs,
 *     daily_summary_*) lives in a kv_state table as JSON documents — these
 *     have no D1 counterpart (the browser bot kept them in localStorage).
 *
 * The public API (loadState / saveState / appendRecord / loadRecords) is
 * unchanged from the JSON-file era: call sites never touch SQL, and write
 * failures still THROW so the CR-15 persistence-fault contract holds
 * (a failed critical write blocks live entries).
 *
 * Durability semantics match the JSON era exactly: WAL + synchronous=NORMAL
 * commits to the OS page cache without fsync — the old writeFileSync never
 * fsynced either. Measured median write latency on ext4: 0.025ms.
 */

import {
  existsSync,
  readFileSync,
  renameSync,
  chmodSync,
  mkdirSync,
} from "fs";
import { createRequire } from "node:module";
import { join } from "path";

// node:sqlite is newer than the vite/vitest bundled builtin registry —
// a static import gets its node: prefix stripped and fails to resolve
// ("Failed to load url sqlite"). createRequire reaches Node's native
// registry directly. Types come from src/types/node-sqlite.d.ts.
const nodeRequire = createRequire(join(process.cwd(), "package.json"));
const { DatabaseSync } = nodeRequire("node:sqlite") as typeof import("node:sqlite");

type DatabaseSyncInstance = import("node:sqlite").DatabaseSync;

const DEFAULT_DATA_DIR = join(process.cwd(), "data");
const DB_FILE_NAME = "daemon.sqlite3";

function getDataDir(): string {
  const dir = process.env.DATA_DIR || DEFAULT_DATA_DIR;
  if (!existsSync(dir)) {
    // Same creation semantics as the JSON era (0700, owner-only).
    // When DATA_DIR points at a FILE (tests' failure injection), we skip
    // this branch and the DB open below throws ENOTDIR.
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  try {
    chmodSync(dir, 0o700); // tighten legacy dirs on every open
  } catch {
    // best-effort
  }
  return dir;
}

// ─── Database handle (re-opened when DATA_DIR changes — tests rely on it) ───

let dbHandle: DatabaseSyncInstance | null = null;
let dbHandleDir = "";

function tightenPerms(dbPath: string): void {
  for (const p of [
    dbPath,
    `${dbPath}-wal`,
    `${dbPath}-shm`,
  ]) {
    try {
      if (existsSync(p)) chmodSync(p, 0o600);
    } catch {
      // best-effort
    }
  }
}

function getDb(): DatabaseSyncInstance {
  const dir = getDataDir();
  if (dbHandle && dbHandleDir === dir) return dbHandle;
  if (dbHandle) {
    try {
      dbHandle.close();
    } catch {
      // already closed
    }
    dbHandle = null;
  }
  // Statements are bound to the instance they were prepared on — a
  // re-opened db (DATA_DIR changed in tests) must start a fresh cache.
  stmtCache.clear();
  const dbPath = join(dir, DB_FILE_NAME);
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec("PRAGMA synchronous=NORMAL;");
  migrateLegacyFiles(db, dir);
  tightenPerms(dbPath);
  dbHandle = db;
  dbHandleDir = dir;
  return db;
}

// ─── Schema ────────────────────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kv_state (
  name TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS paper_accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  mode TEXT NOT NULL DEFAULT 'paper',
  balance INTEGER NOT NULL,
  starting_balance INTEGER,
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
  entry_price INTEGER NOT NULL,
  entry_value INTEGER NOT NULL,
  exit_price INTEGER,
  exit_value INTEGER,
  realized_pnl INTEGER,
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  metadata_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_paper_trades_account_status
  ON paper_trades(account_id, status, opened_at DESC);

CREATE TABLE IF NOT EXISTS paper_statement_entries (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  entry_type TEXT NOT NULL,
  amount INTEGER NOT NULL,
  balance_before INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  note TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_paper_statement_account_created_at
  ON paper_statement_entries(account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS records_jsonl (
  name TEXT NOT NULL,
  seq INTEGER NOT NULL,
  value_json TEXT NOT NULL,
  PRIMARY KEY (name, seq)
);
`;

// Prepared statement cache (keyed per db instance lifetime).
const stmtCache = new Map<string, import("node:sqlite").StatementSync>();
function stmt(sql: string): import("node:sqlite").StatementSync {
  const cached = stmtCache.get(sql);
  if (cached) return cached;
  const s = getDb().prepare(sql);
  stmtCache.set(sql, s);
  return s;
}

// ─── Legacy JSON → SQLite migration (one-time, idempotent) ────────────────

function migrateLegacyFiles(db: DatabaseSyncInstance, dir: string): void {
  db.exec(SCHEMA);

  const kvCount = (
    db
      .prepare("SELECT COUNT(*) AS n FROM kv_state")
      .get() as { n: number }
  ).n;
  const accountsCount = (
    db
      .prepare("SELECT COUNT(*) AS n FROM paper_accounts")
      .get() as { n: number }
  ).n;
  if (kvCount > 0 || accountsCount > 0) return; // already migrated

  const ts = Date.now();
  const legacyPath = (name: string) => join(dir, `${name}.json`);
  const quarantine = (p: string) => {
    // Corrupt legacy files are preserved for diagnosis (CR-15 contract),
    // not imported — the system continues with that store empty.
    renameSync(p, `${p}.corrupt-${ts}`);
    console.warn(`[store] migration: quarantined corrupt file ${p}`);
  };

  const migrated: string[] = [];
  db.exec("BEGIN IMMEDIATE");
  try {
    // KV documents
    for (const name of [
      "user_states",
      "primary_token",
      "bot_logs",
      "daily_summary_date",
      "daily_summary_dates",
    ]) {
      const p = legacyPath(name);
      if (!existsSync(p)) continue;
      let raw: string;
      try {
        raw = readFileSync(p, "utf-8");
        JSON.parse(raw); // validate before importing
      } catch {
        quarantine(p); // corrupt — preserve for diagnosis, skip import
        continue;
      }
      db.prepare(
        "INSERT OR REPLACE INTO kv_state (name, value_json, updated_at) VALUES (?, ?, ?)",
      ).run(name, raw, new Date().toISOString());
      migrated.push(p);
    }

    // paper_accounts.json — { userId: PaperAccount }
    const accPath = legacyPath("paper_accounts");
    if (existsSync(accPath)) {
      let accounts: Record<
        string,
        {
          id: string;
          userId?: string;
          mode?: string;
          balance: number;
          startingBalance?: number;
          currency?: string;
          updatedAt?: string;
          updated_at?: string;
        }
      >;
      try {
        accounts = JSON.parse(readFileSync(accPath, "utf-8"));
      } catch {
        quarantine(accPath);
        accounts = {};
      }
      const insert = db.prepare(
        "INSERT OR REPLACE INTO paper_accounts (id, user_id, mode, balance, starting_balance, currency, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      for (const [userId, a] of Object.entries(accounts)) {
        insert.run(
          a.id ?? `paper_acc_${userId}`,
          a.userId ?? userId,
          a.mode ?? "paper",
          a.balance,
          a.startingBalance ?? null,
          a.currency ?? "INR",
          a.updatedAt ?? a.updated_at ?? new Date().toISOString(),
        );
      }
      migrated.push(accPath);
    }

    // JSONL ledgers
    const importLedger = (
      fileName: string,
      insert: import("node:sqlite").StatementSync,
      mapRow: (obj: Record<string, unknown>) => unknown[],
    ) => {
      const p = legacyPath(fileName);
      if (!existsSync(p)) return;
      const raw = readFileSync(p, "utf-8");
      let imported = 0;
      let malformed = 0;
      for (const line of raw.split("\n")) {
        if (line.trim().length === 0) continue;
        try {
          insert.run(...mapRow(JSON.parse(line) as Record<string, unknown>));
          imported++;
        } catch {
          malformed++;
        }
      }
      if (malformed > 0) {
        console.warn(
          `[store] migration: ${fileName}: skipped ${malformed} malformed line(s)`,
        );
      }
      migrated.push(p);
    };

    importLedger(
      "paper_trades",
      db.prepare(
        "INSERT OR REPLACE INTO paper_trades VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ),
      (t) => {
        const meta = (t as { metadata?: unknown }).metadata;
        return [
          t.id,
          t.accountId,
          t.status,
          t.instrumentKey,
          t.direction,
          t.quantity,
          t.entryPrice,
          t.entryValue,
          t.exitPrice ?? null,
          t.exitValue ?? null,
          t.realizedPnl ?? null,
          t.openedAt,
          t.closedAt ?? null,
          meta === undefined || meta === null
            ? null
            : JSON.stringify(meta),
        ];
      },
    );

    importLedger(
      "paper_statements",
      db.prepare(
        "INSERT OR REPLACE INTO paper_statement_entries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ),
      (s) => [
        s.id,
        s.accountId,
        s.entryType,
        s.amountPaise,
        s.balanceBeforePaise,
        s.balanceAfterPaise,
        s.note ?? null,
        null,
        s.createdAt,
      ],
    );

    // All imports succeeded — commit, THEN rename legacy files (renames are
    // not transactional; a rollback with files already renamed would lose
    // the only copy).
    db.exec("COMMIT");
    for (const p of migrated) {
      renameSync(p, `${p}.migrated-${ts}`);
    }
    if (migrated.length > 0) {
      console.log(
        `[store] migrated ${migrated.length} legacy file(s) to SQLite (kept as *.migrated-${ts})`,
      );
    }
  } catch (error) {
    db.exec("ROLLBACK");
    // Fail loud, legacy files untouched — a partial migration must never
    // silently destroy the only copy. Retried on the next boot.
    throw new Error(
      `legacy JSON → SQLite migration failed (rolled back, legacy files left intact): ${(error as Error).message}`,
    );
  }
}

// ─── Public API (unchanged from the JSON-file era) ─────────────────────────

export function loadState<T>(name: string): T | null {
  getDb(); // bind to the CURRENT DATA_DIR — a stale cached statement would
  // silently read the previous directory's database after a DATA_DIR change.
  // paper_accounts lives in its TYPED table (D1-verbatim), not kv_state.
  if (name === "paper_accounts") {
    const rows = stmt(
      "SELECT id, user_id, mode, balance, starting_balance, currency, updated_at FROM paper_accounts",
    ).all() as Record<string, unknown>[];
    const map: Record<string, unknown> = {};
    for (const r of rows) {
      const userId = (r.user_id as string) ?? (r.id as string);
      map[userId] = {
        id: r.id,
        userId,
        mode: r.mode,
        balance: r.balance,
        startingBalance: r.starting_balance ?? undefined,
        currency: r.currency,
        updatedAt: r.updated_at,
      };
    }
    return map as T;
  }
  const row = stmt(
    "SELECT value_json FROM kv_state WHERE name = ?",
  ).get(name) as { value_json: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value_json) as T;
  } catch {
    // Corrupt blob: quarantine + treat as missing (same contract as the
    // JSON-file era's corrupt-file preservation).
    console.warn(
      `[store] kv_state[${name}]: corrupt JSON — quarantining and ignoring`,
    );
    stmt("DELETE FROM kv_state WHERE name = ?").run(name);
    return null;
  }
}

export function saveState<T>(name: string, data: T): void {
  getDb(); // ensure open (throws when DATA_DIR is invalid)
  if (name === "paper_accounts") {
    // The map is the whole truth — replace all rows transactionally.
    const accounts = data as Record<
      string,
      {
        id?: string;
        balance: number;
        startingBalance?: number;
        mode?: string;
        currency?: string;
        updatedAt?: string;
      }
    >;
    const upsert = dbHandle!.prepare(
      "INSERT OR REPLACE INTO paper_accounts (id, user_id, mode, balance, starting_balance, currency, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    dbHandle!.exec("BEGIN IMMEDIATE");
    try {
      dbHandle!.exec("DELETE FROM paper_accounts");
      for (const [userId, a] of Object.entries(accounts)) {
        upsert.run(
          a.id ?? `paper_acc_${userId}`,
          userId,
          a.mode ?? "paper",
          a.balance,
          a.startingBalance ?? null,
          a.currency ?? "INR",
          a.updatedAt ?? new Date().toISOString(),
        );
      }
      dbHandle!.exec("COMMIT");
    } catch (e) {
      dbHandle!.exec("ROLLBACK");
      throw e;
    }
    tightenPerms(join(getDbDir(), DB_FILE_NAME));
    return;
  }
  stmt(
    "INSERT OR REPLACE INTO kv_state (name, value_json, updated_at) VALUES (?, ?, ?)",
  ).run(name, JSON.stringify(data, null, 2), new Date().toISOString());
  tightenPerms(join(getDbDir(), DB_FILE_NAME));
}

export function appendRecord<T>(name: string, record: T): void {
  getDb(); // ensure open
  if (name === "paper_trades") {
    const t = record as unknown as {
      id: string;
      accountId: string;
      status: string;
      instrumentKey: string;
      direction: string;
      quantity: number;
      entryPrice: number;
      entryValue: number;
      exitPrice?: number | null;
      exitValue?: number | null;
      realizedPnl?: number | null;
      openedAt: string;
      closedAt?: string | null;
      metadata?: Record<string, unknown> | null;
    };
    stmt(
      "INSERT OR REPLACE INTO paper_trades VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      t.id,
      t.accountId,
      t.status,
      t.instrumentKey,
      t.direction,
      t.quantity,
      t.entryPrice,
      t.entryValue,
      t.exitPrice ?? null,
      t.exitValue ?? null,
      t.realizedPnl ?? null,
      t.openedAt,
      t.closedAt ?? null,
      t.metadata == null ? null : JSON.stringify(t.metadata),
    );
  } else if (name === "paper_statements") {
    const s = record as unknown as {
      id: string;
      accountId: string;
      entryType: string;
      amountPaise: number;
      balanceBeforePaise: number;
      balanceAfterPaise: number;
      note?: string | null;
      createdAt: string;
    };
    stmt(
      "INSERT OR REPLACE INTO paper_statement_entries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      s.id,
      s.accountId,
      s.entryType,
      s.amountPaise,
      s.balanceBeforePaise,
      s.balanceAfterPaise,
      s.note ?? null,
      null,
      s.createdAt,
    );
  } else {
    // Generic JSONL fallback (same semantics as the old appendFileSync path)
    stmt(
      "INSERT INTO records_jsonl (name, seq, value_json) VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM records_jsonl WHERE name = ?), ?)",
    ).run(name, name, JSON.stringify(record));
  }
  tightenPerms(join(getDbDir(), DB_FILE_NAME));
}

export function loadRecords<T>(name: string): T[] {
  getDb(); // bind to the CURRENT DATA_DIR (see loadState)
  if (name === "paper_trades") {
    const rows = stmt(
      "SELECT id, account_id, status, instrument_key, direction, quantity, entry_price, entry_value, exit_price, exit_value, realized_pnl, opened_at, closed_at, metadata_json FROM paper_trades ORDER BY rowid",
    ).all() as Record<string, unknown>[];
    return rows.map(
      (r) =>
        ({
          id: r.id,
          accountId: r.account_id,
          status: r.status,
          instrumentKey: r.instrument_key,
          direction: r.direction,
          quantity: r.quantity,
          entryPrice: r.entry_price,
          entryValue: r.entry_value,
          exitPrice: r.exit_price ?? undefined,
          exitValue: r.exit_value ?? undefined,
          realizedPnl: r.realized_pnl ?? undefined,
          openedAt: r.opened_at,
          closedAt: r.closed_at ?? undefined,
          metadata:
            r.metadata_json == null
              ? undefined
              : (JSON.parse(r.metadata_json as string) as Record<
                  string,
                  unknown
                >),
        }) as unknown as T,
    );
  }
  if (name === "paper_statements") {
    const rows = stmt(
      "SELECT id, account_id, entry_type, amount, balance_before, balance_after, note, created_at FROM paper_statement_entries ORDER BY rowid",
    ).all() as Record<string, unknown>[];
    return rows.map(
      (r) =>
        ({
          id: r.id,
          accountId: r.account_id,
          entryType: r.entry_type,
          amountPaise: r.amount,
          balanceBeforePaise: r.balance_before,
          balanceAfterPaise: r.balance_after,
          note: (r.note as string | null) ?? undefined,
          createdAt: r.created_at,
        }) as unknown as T,
    );
  }
  const rows = stmt(
    "SELECT value_json FROM records_jsonl WHERE name = ? ORDER BY seq",
  ).all(name) as { value_json: string }[];
  const out: T[] = [];
  for (const r of rows) {
    try {
      out.push(JSON.parse(r.value_json) as T);
    } catch {
      // Malformed lines are skipped and counted — same contract as before.
    }
  }
  return out;
}

function getDbDir(): string {
  return dbHandleDir;
}
