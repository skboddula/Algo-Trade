/**
 * File-based persistence store for the daemon.
 *
 * Persists state to JSON files on disk so positions, paper accounts,
 * trade history, and bot configuration survive daemon restarts.
 *
 * Design:
 * - Single JSON file per concern (accounts, trades, user states)
 * - Atomic writes (write temp file, then rename) to prevent corruption
 * - Secrets live in their own files with restrictive permissions (0600);
 *   the data directory is created 0700 so other local users cannot read
 *   trading state or credentials
 * - Failures are EXPLICIT: save/append throw so callers can surface the
 *   fault (a silent persistence failure can produce unsafe trading state)
 * - Corrupt state files are preserved for diagnosis (renamed .corrupt-*)
 *   rather than silently treated as absent
 * - Data directory configurable via DATA_DIR env var (default: ./data)
 */

import {
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  existsSync,
  appendFileSync,
  chmodSync,
  renameSync as renameFile,
} from "fs";
import { join } from "path";

const DEFAULT_DATA_DIR = join(process.cwd(), "data");

function getDataDir(): string {
  const dir = process.env.DATA_DIR || DEFAULT_DATA_DIR;
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(dir, 0o700);
    } catch {
      // umask may have applied; best-effort restrictive defaults
    }
  }
  return dir;
}

function getFilePath(name: string): string {
  return join(getDataDir(), `${name}.json`);
}

/** Writes a file with owner-only permissions and atomic replacement. */
function writeRestricted(path: string, contents: string): void {
  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, contents, "utf-8");
  try {
    chmodSync(tmpPath, 0o600);
  } catch {
    // best-effort restriction
  }
  renameSync(tmpPath, path);
}

/**
 * Loads a JSON state file. Returns null when absent. On CORRUPT JSON the
 * file is preserved (renamed to <name>.corrupt-<timestamp>) so it can be
 * diagnosed and recovered — never silently treated as absent.
 */
export function loadState<T>(name: string): T | null {
  const path = getFilePath(name);
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (error) {
    console.error(`[store] Failed to read ${name}:`, (error as Error).message);
    return null;
  }
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    const corruptPath = `${path}.corrupt-${Date.now()}`;
    try {
      renameFile(path, corruptPath);
      console.error(
        `[store] CORRUPT state file ${name} preserved at ${corruptPath} ` +
          `(${(error as Error).message}); starting without it. ` +
          `Recover it manually if it holds trading state.`,
      );
    } catch (renameError) {
      console.error(
        `[store] CORRUPT state file ${name} could not be preserved:`,
        (renameError as Error).message,
      );
    }
    return null;
  }
}

/**
 * Saves data to a JSON file atomically (write temp, chmod 0600, rename).
 * THROWS on failure so callers can surface the fault — a silent failure
 * here could let trading continue with unpersisted critical state.
 */
export function saveState<T>(name: string, data: T): void {
  const path = getFilePath(name);
  writeRestricted(path, JSON.stringify(data, null, 2));
}

/**
 * Appends a record to a JSONL (JSON Lines) file — each line is one JSON
 * object. Suitable for append-only logs like trade history. THROWS on
 * failure so callers can surface the fault.
 */
export function appendRecord<T>(name: string, record: T): void {
  const path = getFilePath(name);
  const line = JSON.stringify(record) + "\n";
  appendFileSync(path, line, "utf-8");
}

/**
 * Loads all records from a JSONL file. Malformed lines are skipped but
 * counted and reported — a truncated final line (crash mid-append) is
 * expected and tolerated; anything else is surfaced.
 */
export function loadRecords<T>(name: string): T[] {
  const path = getFilePath(name);
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf-8");
  const lines = raw.split("\n").filter((line) => line.length > 0);
  const records: T[] = [];
  let malformed = 0;
  for (const line of lines) {
    try {
      records.push(JSON.parse(line) as T);
    } catch {
      malformed += 1;
    }
  }
  if (malformed > 0) {
    console.warn(
      `[store] Skipped ${malformed} malformed line(s) in ${name} ` +
        `(a truncated final line from a crash mid-append is expected)`,
    );
  }
  return records;
}
