/**
 * Backtesting engine — the browser client's implementation, re-exported.
 * Only fetchHistoricalCandles differs: the daemon talks to Upstox directly
 * (there is no Worker proxy in the daemon runtime).
 */
export {
  runBacktest,
  approximatePremium,
  getBacktestDefaults,
  BACKTEST_DEFAULTS,
} from "../../../client/src/lib/backtestEngine";
export type {
  BacktestConfig,
  BacktestTrade,
  BacktestResult,
} from "../../../client/src/lib/backtestEngine";

import { fetchWithRetry } from "../utils/http/fetchRetry";
import type { Candle } from "../types";

interface UpstoxHistoricalResponse {
  status?: string;
  data?: {
    candles?: (string | number | null)[][];
  };
}

/** Daemon-local: historical candles straight from Upstox (no Worker proxy). */
export async function fetchHistoricalCandles(
  token: string,
  instrumentKey: string,
  fromDate: string,
  toDate: string,
  interval = "1minute",
): Promise<Candle[]> {
  const key = encodeURIComponent(instrumentKey);
  const response = await fetchWithRetry(
    `https://api.upstox.com/v2/historical-candle/${key}/${interval}/${toDate}/${fromDate}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    },
  );
  if (!response.ok) {
    throw new Error(`Historical candle fetch failed: HTTP ${response.status}`);
  }
  const raw: unknown = await response.json();
  const resp = raw as UpstoxHistoricalResponse;
  const rows: (string | number | null)[][] = resp.data?.candles ?? [];
  return rows.map((row): Candle => {
    const [ts, o, h, l, c, v] = row;
    return [
      typeof ts === "string"
        ? ts
        : new Date(typeof ts === "number" ? ts : 0).toISOString(),
      Number(o ?? 0),
      Number(h ?? 0),
      Number(l ?? 0),
      Number(c ?? 0),
      Number(v ?? 0),
      undefined,
    ];
  });
}
