import { DatabaseSync } from 'node:sqlite';
import { computeAllIndicators } from '../app/client/src/lib/indicators';
import { getFinalSignal } from '../app/client/src/lib/strategyEngine';

// Session retrospective — run after every EOD (or for any past date):
//   npx tsx scripts/session-retro.ts             → today (IST)
//   npx tsx scripts/session-retro.ts 2026-10-13  → a past date
//
// Part 1 attributes each trade to the underlying index tape (epoch-based
// lookups, timezone-proof). Part 2 recomputes the browser strategy engine
// at each entry window (the technical layer only — the historical
// VRD/sentiment are not retained; the daemon entries used the full stack).
//
// Note: Upstox publishes the historical 1-minute store with a lag — if the
// candles come back empty for a past date, rerun later in the day.

const REPO = '/home/shiva/Downloads/Algo-Trade';
const db = new DatabaseSync(REPO + '/app/core/data/daemon.sqlite3', { readOnly: true });
const token = JSON.parse(db.prepare("SELECT value_json FROM kv_state WHERE name='primary_token'").get().value_json).token;

// The trade date: the CLI arg (YYYY-MM-DD) or the IST today
const todayIST = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const tradeDate = process.argv[2] || todayIST;
console.log(`Session retro for ${tradeDate} IST`);

// All trades since Oct 1, filtered to the IST date (timezone-proof)
const toIST = (utcStr: string) =>
  new Date(Date.parse(utcStr.endsWith('Z') ? utcStr : utcStr + 'Z') + 330 * 60000).toISOString().slice(0, 16);
const allTrades = db.prepare("SELECT instrument_key, direction, quantity, entry_price, exit_price, opened_at, closed_at, realized_pnl FROM paper_trades WHERE opened_at >= '2026-10-01' ORDER BY opened_at").all();
const trades = allTrades.filter((t: any) => toIST(t.opened_at).slice(0, 10) === tradeDate);
const shivaConfig = JSON.parse(db.prepare("SELECT value_json FROM kv_state WHERE name='user_states'").get().value_json)['shiva'].config;
db.close();
console.log(`trades on ${tradeDate}:`, trades.length);

const INDICES: Record<string, string> = {
  'NIFTY 50': 'NSE_INDEX|Nifty 50',
  'BANKNIFTY': 'NSE_INDEX|Nifty Bank',
  'FINNIFTY': 'NSE_INDEX|Nifty Fin Service',
};
// F&O instrument id → underlying (verified against the daemon entry logs —
// extend this map when a new F&O id appears in the trades)
const INSTRUMENT_UNDERLYING: Record<string, string> = {
  '44591': 'NIFTY 50',
  '60388': 'FINNIFTY',
  '60393': 'FINNIFTY',
  '44618': 'NIFTY 50',
  '49440': 'BANKNIFTY',
  '50317': 'FINNIFTY',
};

type Candle = [string, number, number, number, number, number];
const normalize = (c: any[]): Candle => [c[0], Number(c[1]), Number(c[2]), Number(c[3]), Number(c[4]), Number(c[5] ?? 0)];

async function getIndexCandles(indexKey: string): Promise<Candle[]> {
  const headers = { Authorization: 'Bearer ' + token, Accept: 'application/json' };
  // today: the intraday endpoint serves the current session
  if (tradeDate === todayIST) {
    const r = await fetch(`https://api.upstox.com/v2/historical-candle/intraday/${indexKey}/1minute`, { headers });
    const d = await r.json();
    const candles = ((d.data && d.data.candles) || []) as any[];
    if (candles.length > 0) return candles.map(normalize);
  }
  // past dates: the historical store (same-date request works once published)
  const r = await fetch(`https://api.upstox.com/v2/historical-candle/${indexKey}/1minute/${tradeDate}/${tradeDate}`, { headers });
  const d = await r.json();
  return (((d.data && d.data.candles) || []) as any[]).map(normalize);
}

// The close of the 1-minute candle containing the target moment (epoch ms);
// falls back to the nearest candle within 90 s, null if none
function closeAt(arr: { epoch: number; close: number }[], targetEpoch: number): number | null {
  const minute = Math.floor(targetEpoch / 60000) * 60000;
  const exact = arr.find((c) => c.epoch === minute);
  if (exact) return exact.close;
  const hit = arr.find((c) => Math.abs(c.epoch - targetEpoch) < 90000);
  return hit ? hit.close : null;
}
const istTime = (epoch: number) => new Date(epoch + 330 * 60000).toISOString().slice(11, 19);
const parseUTC = (s: string) => Date.parse(s.endsWith('Z') ? s : s + 'Z');

async function main() {
  const dayCandles: Record<string, Candle[]> = {};
  let haveCandles = false;
  for (const [sym, key] of Object.entries(INDICES)) {
    const candles = (await getIndexCandles(key)).sort((a, b) => Date.parse(a[0]) - Date.parse(b[0]));
    dayCandles[sym] = candles;
    if (candles.length > 0) haveCandles = true;
    console.log(`candles ${sym}:`, candles.length);
  }
  if (!haveCandles) {
    console.log(`\n⚠ index 1-minute candles for ${tradeDate} are not published yet — the attribution is skipped; rerun later in the day`);
    process.exit(0);
  }

  console.log('\n=== PART 1: INDEX ATTRIBUTION (all PE = betting index DOWN) ===');
  let right = 0, wrong = 0, unmeasurable = 0;
  const entries: { entryEpoch: number; exitEpoch: number | null; sym: string; dir: string }[] = [];
  for (const t of trades) {
    const entryEpoch = parseUTC(t.opened_at);
    const exitEpoch = t.closed_at ? parseUTC(t.closed_at) : null;
    const instId = String(t.instrument_key).split('|')[1];
    const sym = INSTRUMENT_UNDERLYING[instId] || 'UNKNOWN';
    if (sym === 'UNKNOWN') console.log(`  ⚠ unknown F&O id ${instId} — add it to INSTRUMENT_UNDERLYING in scripts/session-retro.ts`);
    entries.push({ entryEpoch, exitEpoch, sym, dir: t.direction });
    const idx = dayCandles[sym] || [];
    const closes = idx.map((c) => ({ epoch: Date.parse(c[0]), close: c[4] }));
    const iEntry = closeAt(closes, entryEpoch);
    const iExit = exitEpoch != null ? closeAt(closes, exitEpoch) : null;
    if (iEntry == null || iExit == null) { unmeasurable++; console.log(istTime(entryEpoch), sym, '| index candle gap'); continue; }

    const indexMove = ((iExit - iEntry) / iEntry) * 100;
    const optMove = ((t.exit_price - t.entry_price) / t.entry_price) * 100;
    const pnl = (t.realized_pnl ?? 0) / 100;
    // direction-aware: the PE wins when the index falls, the CE when it rises
    const expected = t.direction === 'PE' ? indexMove < 0 : indexMove > 0;
    const dir = expected ? 'moved as predicted ✓' : indexMove === 0 ? 'FLAT (no signal validation)' : 'MOVED AGAINST ✗';
    if (expected) right++; else if (indexMove !== 0) wrong++; else unmeasurable++;
    console.log(istTime(entryEpoch), '->', (exitEpoch != null ? istTime(exitEpoch) : 'OPEN'), '|', sym.padEnd(10), '| index', iEntry.toFixed(1), '->', iExit.toFixed(1), `(${indexMove >= 0 ? '+' : ''}${indexMove.toFixed(2)}%) ${dir}`, '| option', `${optMove >= 0 ? '+' : ''}${optMove.toFixed(1)}%`, '| PnL Rs', pnl.toFixed(2));
  }
  console.log(`\nSignal-direction score: ${right} as predicted / ${wrong} against / ${unmeasurable} unmeasurable (sub-minute or flat)`);

  console.log('\n=== PART 2: BROWSER-ENGINE RECOMPUTE AT EACH ENTRY WINDOW ===');
  console.log('(the technical layer only — historical VRD/sentiment are not retained; the daemon entries used the full stack)');
  for (const e of entries) {
    const candles = dayCandles[e.sym] || [];
    const upto = candles.filter((c) => Date.parse(c[0]) <= e.entryEpoch).slice(-100);
    if (upto.length < 50) { console.log(istTime(e.entryEpoch), e.sym, '| too few candles for the window'); continue; }
    const indicators = computeAllIndicators(upto, []);
    const signalData = {
      v3: 'hold' as const,
      indicators,
      vrd: null,
      globalIndices: [] as string[],
    };
    const signal = getFinalSignal(signalData, shivaConfig);
    const agree = signal.signal.startsWith(e.dir) ? 'MATCH ✓' : signal.signal === 'NO_TRADE' ? 'NO_TRADE (muted)' : `OPPOSITE ✗ (${signal.signal})`;
    console.log(
      istTime(e.entryEpoch), e.sym.padEnd(10),
      '| daemon entered', e.dir.padEnd(2),
      '| browser-math:', String(signal.signal).padEnd(8), signal.confidence?.padEnd(8) ?? '',
      '| bull', signal.bullScore, 'bear', signal.bearScore, '|', agree,
    );
  }
  process.exit(0);
}
main();
