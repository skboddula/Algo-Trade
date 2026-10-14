import { DatabaseSync } from 'node:sqlite';
import { computeAllIndicators } from '../app/client/src/lib/indicators';
import { getFinalSignal } from '../app/client/src/lib/strategyEngine';

const REPO = '/home/shiva/Downloads/Algo-Trade';
const db = new DatabaseSync(REPO + '/app/core/data/daemon.sqlite3', { readOnly: true });
const token = JSON.parse(db.prepare("SELECT value_json FROM kv_state WHERE name='primary_token'").get().value_json).token;

const trades = db.prepare("SELECT instrument_key, direction, quantity, entry_price, exit_price, opened_at, closed_at, realized_pnl FROM paper_trades WHERE opened_at >= '2026-10-13T00:00' AND opened_at < '2026-10-13T18:30' ORDER BY opened_at").all();
const logEntries = JSON.parse(db.prepare("SELECT value_json FROM kv_state WHERE name='bot_logs'").get().value_json);
const shivaConfig = JSON.parse(db.prepare("SELECT value_json FROM kv_state WHERE name='user_states'").get().value_json)['shiva'].config;
db.close();

const INDICES: Record<string, string> = {
  'NIFTY 50': 'NSE_INDEX|Nifty 50',
  'BANKNIFTY': 'NSE_INDEX|Nifty Bank',
  'FINNIFTY': 'NSE_INDEX|Nifty Fin Service',
};
// F&O instrument id → underlying (verified against the daemon entry logs)
const INSTRUMENT_UNDERLYING: Record<string, string> = {
  '44591': 'NIFTY 50',
  '60393': 'FINNIFTY',
  '44618': 'NIFTY 50',
  '49440': 'BANKNIFTY',
  '50317': 'FINNIFTY',
};
const toIST = (utcStr: string) => new Date(Date.parse(utcStr.endsWith('Z') ? utcStr : utcStr + 'Z') + 330 * 60000).toISOString().slice(0, 16);
type Candle = [string, number, number, number, number, number];

async function getDayCandles(indexKey: string, day: string): Promise<Record<string, Candle>> {
  const url = `https://api.upstox.com/v2/historical-candle/${encodeURIComponent(indexKey)}/1minute/${day}/${day}`;
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } });
  const d = await r.json();
  const m: Record<string, Candle> = {};
  for (const c of ((d.data && d.data.candles) || [])) {
    const istTs = new Date(Date.parse(c[0]) + 330 * 60000).toISOString().slice(0, 16);
    m[istTs] = [c[0], Number(c[1]), Number(c[2]), Number(c[3]), Number(c[4]), Number(c[5] ?? 0)];
  }
  return m;
}

async function main() {
  const dayCandles: Record<string, Record<string, Candle>> = {};
  for (const [sym, key] of Object.entries(INDICES)) {
    dayCandles[sym] = await getDayCandles(key, '2026-10-13');
    console.log(`candles ${sym}:`, Object.keys(dayCandles[sym]).length);
  }

  console.log('\n=== PART 1: INDEX ATTRIBUTION (all PE = betting index DOWN) ===');
  let right = 0, wrong = 0;
  const entries: { istEntry: string; istExit: string | null; sym: string; dir: string; entryPrice: number }[] = [];
  for (const t of trades) {
    const istEntry = toIST(t.opened_at.slice(0, 16));
    const istExit = t.closed_at ? toIST(t.closed_at.slice(0, 16)) : null;
    const sym = INSTRUMENT_UNDERLYING[t.instrument_key.split('|')[1]] || 'UNKNOWN';
    entries.push({ istEntry, istExit, sym, dir: t.direction, entryPrice: t.entry_price / 100 });
    const idx = dayCandles[sym];
    if (!idx) { console.log('no candles:', sym); continue; }
    const entryCandle = idx[istEntry];
    const iEntry = entryCandle[4];   // close
    const exitCandle = istExit ? idx[istExit] : null;
    const iExit = exitCandle ? exitCandle[4] : null;
    if (iEntry == null || iExit == null) { console.log(istEntry.slice(11), sym, '| index candles gap'); continue; }
    const indexMove = ((iExit - iEntry) / iEntry) * 100;
    const optMove = ((t.exit_price - t.entry_price) / t.entry_price) * 100;
    const pnl = (t.realized_pnl ?? 0) / 100;
    // direction-aware: PE wins when the index falls, CE when it rises
    const expected = t.direction === 'PE' ? indexMove < 0 : indexMove > 0;
    const dir = expected ? 'moved as predicted ✓' : indexMove === 0 ? 'FLAT (no signal validation)' : 'MOVED AGAINST ✗';
    if (expected) right++; else if (indexMove !== 0) wrong++;
    console.log(istEntry.slice(11), '->', (istExit || '').slice(11), '|', sym.padEnd(10), '| index', iEntry.toFixed(1), '->', iExit.toFixed(1), `(${indexMove >= 0 ? '+' : ''}${indexMove.toFixed(2)}%) ${dir}`, '| option', `${optMove >= 0 ? '+' : ''}${optMove.toFixed(1)}%`, '| PnL Rs', pnl.toFixed(2));
  }
  console.log(`\nIndex-direction score: ${right} right / ${wrong} wrong`);

  console.log('\n=== PART 2: BROWSER-ENGINE RECOMPUTE AT EACH ENTRY WINDOW ===');
  console.log('(the technical layer only — historical VRD/sentiment are not retained; the daemon entries used the full stack)');
  for (const e of entries) {
    const sym = e.sym;
    const day = dayCandles[sym];
    const allKeys = Object.keys(day).sort();
    const upto = allKeys.filter((k) => k <= e.istEntry).slice(-100);
    if (upto.length < 50) { console.log(e.istEntry.slice(11), sym, '| too few candles for the window'); continue; }
    const visible: Candle[] = upto.map((k) => day[k]);
    const indicators = computeAllIndicators(visible, []);
    const signalData = {
      v3: 'hold' as const,
      indicators,
      vrd: null,
      globalIndices: [] as string[],
    };
    const signal = getFinalSignal(signalData, shivaConfig);
    const agree = signal.signal.startsWith(e.dir) ? 'MATCH ✓' : signal.signal === 'NO_TRADE' ? 'NO_TRADE (muted)' : `OPPOSITE ✗ (${signal.signal})`;
    console.log(
      e.istEntry.slice(11), sym.padEnd(10),
      '| daemon entered', e.dir.padEnd(2),
      '| browser-math:', String(signal.signal).padEnd(8), signal.confidence?.padEnd(8) ?? '',
      '| bull', signal.bullScore, 'bear', signal.bearScore, '|', agree,
    );
  }
  process.exit(0);
}
main();
