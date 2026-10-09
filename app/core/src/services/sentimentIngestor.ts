/**
 * Live sentiment ingestor — daemon port of the browser client's VRD data
 * pipeline (marketService.fetchGlobalMarketData + fetchSymbolSentiment).
 *
 * Fetches, on a 60-second cadence with per-item graceful fallback:
 *  - NIFTY 50 breadth (advances/declines) from Upstox constituent quotes
 *  - FII index-futures long/short + net positioning from Upstox FII activity
 *    (falls back to ATM-window OI proxy flow when unavailable)
 *  - GIFT Nifty from the VRD Nation pulse feed (drives opening-gap signal)
 *  - Instrument news classified into MACRO/EARNINGS alerts
 * Per symbol+expiry (60s cadence):
 *  - Official PCR from Upstox /market/pcr
 *  - Max pain from Upstox /market/max-pain
 *
 * Chain/OHLC-derived values (PCR fallback, support/resistance walls from OI,
 * ATM straddle IV vs VIX, proxy PE valuation, synthetic MMI) are computed
 * synchronously from data the master ingestor already holds.
 */
import type {
  IndicatorsResult,
  McMarketItem,
  NewsAlert,
  OptionData,
  UnderlyingSymbol,
  UpstoxNewsItem,
  VrdData,
} from "../types";
import { UNDERLYING_INSTRUMENT_KEYS } from "../types";
import { fetchWithRetry } from "../utils/http/fetchRetry";
import { getIndiaTime } from "../utils/timeUtils";
import {
  computeMMI,
  computeProxyFlow,
  computeProxyValuation,
  computeStraddleIV,
} from "./syntheticCalculators";
import { classifyNews } from "./vrdSignals";

// NIFTY 50 constituents (instrument keys) for market breadth.
const NIFTY50_KEYS = [
  "NSE_EQ|INE423A01024",
  "NSE_EQ|INE742F01042",
  "NSE_EQ|INE437A01024",
  "NSE_EQ|INE021A01026",
  "NSE_EQ|INE238A01034",
  "NSE_EQ|INE917I01010",
  "NSE_EQ|INE296A01032",
  "NSE_EQ|INE918I01026",
  "NSE_EQ|INE029A01011",
  "NSE_EQ|INE397D01024",
  "NSE_EQ|INE216A01030",
  "NSE_EQ|INE059A01026",
  "NSE_EQ|INE522F01014",
  "NSE_EQ|INE361B01024",
  "NSE_EQ|INE089A01031",
  "NSE_EQ|INE066A01021",
  "NSE_EQ|INE047A01021",
  "NSE_EQ|INE860A01027",
  "NSE_EQ|INE040A01034",
  "NSE_EQ|INE795G01014",
  "NSE_EQ|INE158A01026",
  "NSE_EQ|INE038A01020",
  "NSE_EQ|INE030A01027",
  "NSE_EQ|INE090A01021",
  "NSE_EQ|INE095A01012",
  "NSE_EQ|INE009A01021",
  "NSE_EQ|INE154A01025",
  "NSE_EQ|INE019A01038",
  "NSE_EQ|INE237A01036",
  "NSE_EQ|INE018A01030",
  "NSE_EQ|INE214T01019",
  "NSE_EQ|INE101A01026",
  "NSE_EQ|INE585B01010",
  "NSE_EQ|INE239A01024",
  "NSE_EQ|INE733E01010",
  "NSE_EQ|INE213A01029",
  "NSE_EQ|INE752E01010",
  "NSE_EQ|INE002A01018",
  "NSE_EQ|INE123W01016",
  "NSE_EQ|INE721A01047",
  "NSE_EQ|INE062A01020",
  "NSE_EQ|INE044A01036",
  "NSE_EQ|INE467B01029",
  "NSE_EQ|INE192A01025",
  "NSE_EQ|INE155A01022",
  "NSE_EQ|INE081A01020",
  "NSE_EQ|INE669C01036",
  "NSE_EQ|INE280A01028",
  "NSE_EQ|INE849A01020",
  "NSE_EQ|INE481G01011",
];

const GLOBAL_PULSE_URL = "https://www.vrdnation.com/pulse/api/dashboard";
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36";

const REFRESH_MS = 60_000;
const FII_LOOKBACK_DAYS = 15;

interface MarketWideSentiment {
  breadth: {
    advances: number | null;
    declines: number | null;
    ratio: number | null;
  } | null;
  fiiLongShort: VrdData["fiiLongShort"];
  fiiPositioning: VrdData["fiiPositioning"];
  giftNifty: VrdData["giftNifty"];
  globalIndices: McMarketItem[];
  newsAlerts: NewsAlert[];
  fetchedAt: string;
}

const EMPTY_MARKET_WIDE: MarketWideSentiment = {
  breadth: null,
  fiiLongShort: null,
  fiiPositioning: null,
  giftNifty: null,
  globalIndices: [],
  newsAlerts: [],
  fetchedAt: "",
};

export class SentimentIngestor {
  private lastMarketWideMs = 0;
  private marketWide: MarketWideSentiment = EMPTY_MARKET_WIDE;
  private pcrCache = new Map<string, { value: number | null; ms: number }>();
  private maxPainCache = new Map<
    string,
    { value: number | null; ms: number }
  >();

  constructor(
    private readonly config: {
      upstoxApiBaseUrl: string;
      token?: string;
    },
  ) {}

  /** Updates the bearer token used for Upstox sentiment endpoints. */
  public setToken(token: string | undefined): void {
    this.config.token = token;
  }

  private get headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.token}`,
      Accept: "application/json",
    };
  }

  /** Market-wide sentiment (breadth, FII, GIFT Nifty, news) — 60s cadence. */
  public async getMarketWide(
    niftyChain: OptionData[],
  ): Promise<MarketWideSentiment> {
    const nowMs = Date.now();
    if (
      nowMs - this.lastMarketWideMs < REFRESH_MS &&
      this.marketWide.fetchedAt
    ) {
      return this.marketWide;
    }
    this.lastMarketWideMs = nowMs;

    const breadth = await this.fetchBreadth().catch(() => null);
    const fii = await this.fetchFii().catch(() => null);
    const global = await this.fetchGlobalIndices().catch(() => null);
    const newsAlerts = await this.fetchNewsAlerts().catch(
      () => [] as NewsAlert[],
    );

    let fiiLongShort = fii?.fiiLongShort ?? null;
    let fiiPositioning = fii?.fiiPositioning ?? null;

    // Fallback to proxy/synthetic FII from ATM-window OI (client parity)
    if (!fiiLongShort || !fiiPositioning) {
      const niftyLtp = niftyChain[0]?.underlying_spot_price ?? 0;
      const proxyFlow = computeProxyFlow(niftyChain, niftyLtp);
      fiiLongShort =
        proxyFlow.longPct !== null && proxyFlow.shortPct !== null
          ? {
              longPct: proxyFlow.longPct,
              shortPct: proxyFlow.shortPct,
              shortPctTrend: "Stable",
            }
          : null;
      fiiPositioning =
        proxyFlow.netPosition !== null
          ? {
              netPosition: proxyFlow.netPosition,
              consecutiveShortDays: proxyFlow.consecutiveShortDays,
            }
          : null;
    }

    this.marketWide = {
      breadth,
      fiiLongShort,
      fiiPositioning,
      giftNifty: global?.giftNifty ?? null,
      globalIndices: global?.indices ?? [],
      newsAlerts,
      fetchedAt: new Date().toISOString(),
    };
    return this.marketWide;
  }

  /** Official Upstox PCR for a symbol+expiry — 60s cadence per key. */
  public async getOfficialPcr(
    symbol: UnderlyingSymbol,
    expiry: string | null,
  ): Promise<number | null> {
    if (!expiry) return null;
    const cacheKey = `${symbol}|${expiry}`;
    const cached = this.pcrCache.get(cacheKey);
    const nowMs = Date.now();
    if (cached && nowMs - cached.ms < REFRESH_MS) return cached.value;

    const qs = new URLSearchParams({
      instrument_key: UNDERLYING_INSTRUMENT_KEYS[symbol],
      expiry,
      date: getIndiaTime().dateString,
      bucket_interval: "60",
    });
    try {
      const res = await fetchWithRetry(
        `${this.config.upstoxApiBaseUrl}/market/pcr?${qs.toString()}`,
        { headers: this.headers },
      );
      const value = res.ok ? extractLatestPcrValue(await res.json()) : null;
      this.pcrCache.set(cacheKey, { value, ms: nowMs });
      return value;
    } catch {
      this.pcrCache.set(cacheKey, { value: cached?.value ?? null, ms: nowMs });
      return cached?.value ?? null;
    }
  }

  /** Official Upstox max-pain strike for a symbol+expiry — 60s cadence per key. */
  public async getMaxPain(
    symbol: UnderlyingSymbol,
    expiry: string | null,
  ): Promise<number | null> {
    if (!expiry) return null;
    const cacheKey = `${symbol}|${expiry}`;
    const cached = this.maxPainCache.get(cacheKey);
    const nowMs = Date.now();
    if (cached && nowMs - cached.ms < REFRESH_MS) return cached.value;

    const qs = new URLSearchParams({
      instrument_key: UNDERLYING_INSTRUMENT_KEYS[symbol],
      expiry,
      date: getIndiaTime().dateString,
      bucket_interval: "60",
    });
    try {
      const res = await fetchWithRetry(
        `${this.config.upstoxApiBaseUrl}/market/max-pain?${qs.toString()}`,
        { headers: this.headers },
      );
      let value: number | null = null;
      if (res.ok) {
        const raw = (await res.json()) as {
          data?: { max_pain?: number } | { max_pain?: number }[];
        };
        const d = raw?.data;
        if (Array.isArray(d)) {
          const latest = [...d].sort((a, b) =>
            String((b as { timestamp?: string }).timestamp ?? "").localeCompare(
              String((a as { timestamp?: string }).timestamp ?? ""),
            ),
          )[0];
          value = typeof latest?.max_pain === "number" ? latest.max_pain : null;
        } else if (d && typeof d.max_pain === "number") {
          value = d.max_pain;
        }
      }
      this.maxPainCache.set(cacheKey, { value, ms: nowMs });
      return value;
    } catch {
      this.maxPainCache.set(cacheKey, {
        value: cached?.value ?? null,
        ms: nowMs,
      });
      return cached?.value ?? null;
    }
  }

  /** Cached global indices list (Brent/SGX/US) for the scoring layers. */
  public getGlobalIndices(): McMarketItem[] {
    return this.marketWide.globalIndices;
  }

  /**
   * Assembles the full per-symbol VrdData — direct port of the client's
   * fetchSymbolSentiment composition, minus the logging/UI plumbing.
   */
  public async buildSymbolVrd(
    symbol: UnderlyingSymbol,
    expiry: string | null,
    optionChain: OptionData[],
    indicators: IndicatorsResult,
    vix: number | null,
  ): Promise<VrdData> {
    const marketWide = await this.getMarketWide(optionChain);

    const [officialPcr, maxPain] = await Promise.all([
      this.getOfficialPcr(symbol, expiry),
      this.getMaxPain(symbol, expiry),
    ]);
    const effectivePcr = officialPcr ?? indicators.pcrValue;

    // Support and resistance walls from option-chain open interest
    let supportWall: number | null = null;
    let resistanceWall: number | null = null;
    if (optionChain.length > 0) {
      let maxPutOi = -1;
      let maxCallOi = -1;
      for (const strike of optionChain) {
        const putOi = strike.put_options?.market_data?.oi ?? 0;
        const callOi = strike.call_options?.market_data?.oi ?? 0;
        if (putOi > maxPutOi) {
          maxPutOi = putOi;
          supportWall = strike.strike_price;
        }
        if (callOi > maxCallOi) {
          maxCallOi = callOi;
          resistanceWall = strike.strike_price;
        }
      }
    }

    const ltp = optionChain[0]?.underlying_spot_price ?? 0;
    const straddleIv = computeStraddleIV(optionChain, ltp, vix);
    const adRatio = marketWide.breadth?.ratio ?? null;
    const proxyPe = computeProxyValuation(ltp, indicators, vix, adRatio);
    const mmi = computeMMI(vix, indicators.rsi.value, effectivePcr);

    return {
      mmi: { score: mmi.score, label: mmi.label },
      advancesDeclines: marketWide.breadth
        ? {
            advances: marketWide.breadth.advances,
            declines: marketWide.breadth.declines,
            ratio: marketWide.breadth.ratio,
            label: null,
          }
        : null,
      fiiLongShort: marketWide.fiiLongShort,
      fiiPositioning: marketWide.fiiPositioning,
      pcr:
        effectivePcr > 0
          ? {
              value: parseFloat(effectivePcr.toFixed(3)),
              zone:
                effectivePcr >= 1.6
                  ? "Overbought"
                  : effectivePcr >= 1.0
                    ? "Bullish"
                    : effectivePcr > 0.7
                      ? "Neutral"
                      : "Bearish",
            }
          : null,
      straddleIv: {
        elevated:
          straddleIv.percentAboveAvg !== null &&
          straddleIv.percentAboveAvg > 30,
        percentAboveAvg: straddleIv.percentAboveAvg,
      },
      niftyPe: { pe: proxyPe.pe, label: proxyPe.label },
      vix,
      giftNifty: marketWide.giftNifty,
      supportWall,
      resistanceWall,
      maxPain,
      newsAlerts: marketWide.newsAlerts,
      fetchedAt: new Date().toISOString(),
    };
  }

  // ── Private fetchers ──────────────────────────────────────────────────────

  /** NIFTY 50 constituent quotes → advances/declines ratio. */
  private async fetchBreadth(): Promise<MarketWideSentiment["breadth"]> {
    const res = await fetchWithRetry(
      `${this.config.upstoxApiBaseUrl}/market-quote/quotes?instrument_key=${encodeURIComponent(NIFTY50_KEYS.join(","))}`,
      { headers: this.headers },
    );
    if (!res.ok) return null;
    const raw = (await res.json()) as {
      data?: Record<string, { net_change?: number }>;
    };
    const stocks = Object.values(raw?.data ?? {});
    if (!stocks.length) return null;
    const advances = stocks.filter((s) => (s.net_change ?? 0) > 0).length;
    const declines = stocks.filter((s) => (s.net_change ?? 0) < 0).length;
    const ratio =
      declines > 0
        ? parseFloat((advances / declines).toFixed(3))
        : advances > 0
          ? 3.0
          : 1.0;
    return { advances, declines, ratio };
  }

  /** FII index-futures activity → long/short split + net positioning. */
  private async fetchFii(): Promise<Pick<
    MarketWideSentiment,
    "fiiLongShort" | "fiiPositioning"
  > | null> {
    const from = new Date();
    from.setDate(from.getDate() - FII_LOOKBACK_DAYS);
    const qs = new URLSearchParams({
      data_type: "NSE_FO|INDEX_FUTURES,NSE_FO|INDEX_OPTIONS,NSE_EQ|CASH",
      interval: "1D",
      from: getIndiaTime(from).dateString,
    });
    const res = await fetchWithRetry(
      `${this.config.upstoxApiBaseUrl}/market/fii?${qs.toString()}`,
      { headers: this.headers },
    );
    if (!res.ok) return null;
    const raw = (await res.json()) as {
      data?: Record<
        string,
        {
          time_stamp: number;
          total_long_contracts: number;
          total_short_contracts: number;
          buy_amount: number;
          sell_amount: number;
        }[]
      >;
    };
    const indexFutures = raw?.data?.["NSE_FO|INDEX_FUTURES"] ?? [];
    const sorted = [...indexFutures].sort(
      (a, b) => b.time_stamp - a.time_stamp,
    );
    const latest = sorted[0];
    if (!latest) return null;

    const long = latest.total_long_contracts ?? 0;
    const short = latest.total_short_contracts ?? 0;
    const total = long + short;
    if (total <= 0) return null;

    let shortPctTrend: "Rising" | "Falling" | "Stable" | null = null;
    if (sorted.length >= 2) {
      const getShortPct = (entry: (typeof sorted)[number]) => {
        const l = entry.total_long_contracts ?? 0;
        const s = entry.total_short_contracts ?? 0;
        return l + s > 0 ? (s / (l + s)) * 100 : 0;
      };
      const todayShortPct = getShortPct(sorted[0]);
      const comparisonEntry = sorted[Math.min(sorted.length - 1, 3)];
      const pastShortPct = getShortPct(comparisonEntry);
      if (todayShortPct - pastShortPct > 1.5) shortPctTrend = "Rising";
      else if (pastShortPct - todayShortPct > 1.5) shortPctTrend = "Falling";
      else shortPctTrend = "Stable";
    }

    let consecutiveShortDays: number | null = 0;
    for (const entry of sorted) {
      const entryNet =
        (entry.total_long_contracts ?? 0) - (entry.total_short_contracts ?? 0);
      if (entryNet < 0) consecutiveShortDays++;
      else break;
    }
    consecutiveShortDays = consecutiveShortDays || null;

    return {
      fiiLongShort: {
        longPct: parseFloat(((long / total) * 100).toFixed(1)),
        shortPct: parseFloat(((short / total) * 100).toFixed(1)),
        shortPctTrend,
      },
      fiiPositioning: {
        netPosition: long - short,
        consecutiveShortDays,
      },
    };
  }

  /** Global indices + GIFT Nifty from the VRD Nation pulse feed. */
  private async fetchGlobalIndices(): Promise<{
    giftNifty: VrdData["giftNifty"];
    indices: McMarketItem[];
  } | null> {
    const res = await fetchWithRetry(GLOBAL_PULSE_URL, {
      headers: { Accept: "application/json", "User-Agent": BROWSER_UA },
    });
    if (!res.ok) return null;
    const raw = (await res.json()) as {
      globalIndicesByRegion?: {
        US?: { displayName: string; price: number; change: number }[];
        ASIA?: { displayName: string; price: number; change: number }[];
        Commodities?: { displayName: string; price: number; change: number }[];
      };
    };
    const regions = raw?.globalIndicesByRegion;
    if (!regions) return null;

    // Flatten all regions — matches the Worker's handleGlobalIndices mapping
    const indices: McMarketItem[] = [
      ...(regions.US ?? []),
      ...(regions.ASIA ?? []),
      ...(regions.Commodities ?? []),
    ].map((item) => ({
      symbol: item.displayName,
      last_price: item.price ?? null,
      change_per: item.change ?? 0,
    }));

    const asia = regions.ASIA ?? [];
    const rawGift = asia.find(
      (item) =>
        item.displayName.toLowerCase().includes("gift") ||
        item.displayName.toLowerCase().includes("sgx"),
    );

    let giftNifty: VrdData["giftNifty"] = null;
    if (rawGift) {
      const price = Number(rawGift.price ?? 0);
      const changePct = Number(rawGift.change ?? 0);
      const changePts = parseFloat((price * (changePct / 100)).toFixed(2));
      const openingSignal =
        changePct > 0.1 ? "Gap Up" : changePct < -0.1 ? "Gap Down" : "Flat";
      giftNifty = { price, changePts, changePct, openingSignal };
    }
    return { giftNifty, indices };
  }

  /** Instrument news → classified MACRO/EARNINGS alerts. */
  private async fetchNewsAlerts(): Promise<NewsAlert[]> {
    const instrumentKeys = (
      ["NIFTY 50", "BANKNIFTY", "FINNIFTY"] as UnderlyingSymbol[]
    )
      .map((sym) => UNDERLYING_INSTRUMENT_KEYS[sym])
      .join(",");
    const qs = new URLSearchParams({
      category: "instrument_keys",
      instrument_keys: instrumentKeys,
    });
    const res = await fetchWithRetry(
      `${this.config.upstoxApiBaseUrl}/news?${qs.toString()}`,
      { headers: this.headers },
    );
    if (!res.ok) return [];
    const raw = (await res.json()) as {
      data?: UpstoxNewsItem[] | Record<string, UpstoxNewsItem[]>;
    };
    const newsItems = Array.isArray(raw?.data)
      ? raw.data
      : Object.values(raw?.data ?? {}).flat();
    return classifyNews(newsItems);
  }
}

/** Direct port of the Worker's extractLatestPcrValue — tolerant shape parsing. */
function extractLatestPcrValue(raw: unknown): number | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as {
    data?:
      | {
          pcr?: number;
          value?: number;
          put_call_ratio?: number;
          timestamp?: string;
          date?: string;
        }[]
      | {
          pcr?: number;
          value?: number;
          put_call_ratio?: number;
          candles?: {
            pcr?: number;
            value?: number;
            put_call_ratio?: number;
            timestamp?: string;
            date?: string;
          }[];
        };
  };
  const data = record.data;

  const series = Array.isArray(data)
    ? data
    : Array.isArray(data?.candles)
      ? data.candles
      : [];

  const latest = [...series].sort((left, right) =>
    String(right.timestamp ?? right.date ?? "").localeCompare(
      String(left.timestamp ?? left.date ?? ""),
    ),
  )[0];
  const objectValue = !Array.isArray(data)
    ? (data?.pcr ?? data?.value ?? data?.put_call_ratio)
    : undefined;
  const value =
    latest?.pcr ?? latest?.value ?? latest?.put_call_ratio ?? objectValue;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
