import { EventEmitter } from "events";
import type {
  UnderlyingSymbol,
  MarketSnapshot,
  Candle,
  OptionData,
  VrdData,
  AllSignalData,
} from "../types";
import { UNDERLYING_INSTRUMENT_KEYS } from "../types";
import { computeAllIndicators } from "./indicators";
import { getFinalSignal } from "./strategyEngine";
import { SentimentIngestor } from "./sentimentIngestor";
import { computeV3Signal } from "./v3Sentiment";
import { DEFAULT_STRATEGY_CONFIG } from "../constants";
import { getIndiaTime } from "../utils/timeUtils";
import { fetchWithRetry } from "../utils/http/fetchRetry";

export interface MasterIngestorConfig {
  pollingIntervalMs: number;
  upstoxApiBaseUrl: string;
  primaryUpstoxToken?: string;
  mockMode?: boolean;
}

export class MasterIngestionEngine extends EventEmitter {
  private isRunning = false;
  private timer: NodeJS.Timeout | null = null;
  private candleBuffer: Map<UnderlyingSymbol, Candle[]> = new Map();
  private latestSnapshots: Map<UnderlyingSymbol, MarketSnapshot> = new Map();
  private latestOptionChains: Map<UnderlyingSymbol, OptionData[]> = new Map();
  private latestVrd: VrdData | null = null;
  private config: MasterIngestorConfig;

  // ── Live data fetch cadence (staggered to respect Upstox rate limits) ────
  private static readonly CANDLE_REFRESH_MS = 30_000;
  private static readonly CHAIN_REFRESH_MS = 15_000;
  private static readonly VIX_REFRESH_MS = 60_000;
  private static readonly EXPIRY_TTL_MS = 6 * 60 * 60 * 1000;

  private lastCandleFetchMs = new Map<UnderlyingSymbol, number>();
  private lastChainFetchMs = new Map<UnderlyingSymbol, number>();
  private lastVixFetchMs = 0;
  private vixValue: number | null = null;
  private sentimentIngestor!: SentimentIngestor;
  private expiryCache = new Map<
    UnderlyingSymbol,
    { expiry: string; fetchedMs: number }
  >();

  constructor(config?: Partial<MasterIngestorConfig>) {
    super();
    this.setMaxListeners(100); // Prevent memory leak warnings on high subscriber counts
    this.config = {
      pollingIntervalMs: config?.pollingIntervalMs ?? 2000,
      upstoxApiBaseUrl: config?.upstoxApiBaseUrl ?? "https://api.upstox.com/v2",
      primaryUpstoxToken: config?.primaryUpstoxToken,
      mockMode: config?.mockMode ?? false,
    };

    // Seed initial candle buffer
    for (const sym of [
      "NIFTY 50",
      "BANKNIFTY",
      "FINNIFTY",
    ] as UnderlyingSymbol[]) {
      this.candleBuffer.set(sym, this.generateSeedCandles(sym));
    }

    // Live sentiment pipeline (breadth, FII, PCR, max pain, GIFT Nifty, news)
    this.sentimentIngestor = new SentimentIngestor({
      upstoxApiBaseUrl: this.config.upstoxApiBaseUrl,
      token: this.config.primaryUpstoxToken,
    });
  }

  public setToken(token: string) {
    this.config.primaryUpstoxToken = token;
    this.sentimentIngestor.setToken(token);
  }

  public getPrimaryToken(): string | null {
    return this.config.primaryUpstoxToken ?? null;
  }

  public setMockMode(enabled: boolean) {
    this.config.mockMode = enabled;
  }

  public start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.runTick();
  }

  public stop() {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  public getSnapshot(symbol: UnderlyingSymbol): MarketSnapshot | undefined {
    return this.latestSnapshots.get(symbol);
  }

  public getAllSnapshots(): Record<UnderlyingSymbol, MarketSnapshot> {
    const result: Partial<Record<UnderlyingSymbol, MarketSnapshot>> = {};
    for (const [sym, snap] of this.latestSnapshots.entries()) {
      result[sym] = snap;
    }
    return result as Record<UnderlyingSymbol, MarketSnapshot>;
  }

  public getOptionChain(symbol: UnderlyingSymbol): OptionData[] {
    return this.latestOptionChains.get(symbol) || [];
  }

  private async runTick() {
    if (!this.isRunning) return;

    try {
      await this.fetchAndComputeMarketData();
    } catch (err) {
      if (this.listenerCount("error") > 0) {
        this.emit("error", err);
      }
    } finally {
      if (this.isRunning) {
        // Off-hours (nights/weekends): relax the poll to 30s — snapshots are
        // frozen anyway; this protects the daily Upstox rate-limit budget
        // for the next live session while keeping dashboard data fresh.
        const delay = getIndiaTime().isMarketHours
          ? this.config.pollingIntervalMs
          : Math.max(this.config.pollingIntervalMs, 30_000);
        this.timer = setTimeout(() => this.runTick(), delay);
      }
    }
  }

  public async fetchAndComputeMarketData() {
    const symbols: UnderlyingSymbol[] = ["NIFTY 50", "BANKNIFTY", "FINNIFTY"];
    const istInfo = getIndiaTime();
    const timestamp = istInfo.date.toISOString();

    for (const symbol of symbols) {
      let spotPrice = 24000;
      let candles = this.candleBuffer.get(symbol) || [];
      let optionChain: OptionData[] = this.latestOptionChains.get(symbol) || [];

      if (this.config.mockMode || !this.config.primaryUpstoxToken) {
        // Mock generation for testing / non-market hours
        const lastClose = candles.length
          ? candles[candles.length - 1][4]
          : symbol === "NIFTY 50"
            ? 24500
            : 51500;
        const delta =
          (Math.random() - 0.49) * (symbol === "NIFTY 50" ? 10 : 25);
        const newClose = Math.round((lastClose + delta) * 100) / 100;
        spotPrice = newClose;

        const newCandle: Candle = [
          timestamp,
          lastClose,
          Math.max(lastClose, newClose) + 2,
          Math.min(lastClose, newClose) - 2,
          newClose,
          Math.floor(Math.random() * 5000) + 1000,
        ];

        candles = [...candles.slice(-99), newCandle];
        this.candleBuffer.set(symbol, candles);

        if (!optionChain.length) {
          optionChain = this.generateMockOptionChain(spotPrice);
          this.latestOptionChains.set(symbol, optionChain);
        }
      } else {
        // Live Upstox fetch from primary token
        const instrumentKey = UNDERLYING_INSTRUMENT_KEYS[symbol];
        const headers = {
          Authorization: `Bearer ${this.config.primaryUpstoxToken}`,
          Accept: "application/json",
        };

        // 1. Spot quote — every tick
        try {
          const quoteRes = await fetchWithRetry(
            `${this.config.upstoxApiBaseUrl}/market-quote/quotes?instrument_key=${encodeURIComponent(instrumentKey)}`,
            { headers },
          );
          if (quoteRes.ok) {
            const data = (await quoteRes.json()) as {
              data?: Record<string, { last_price?: number }>;
            };
            const quote =
              data?.data?.[instrumentKey.replace("|", ":")] ??
              Object.values(data?.data ?? {})[0];
            if (typeof quote?.last_price === "number") {
              spotPrice = quote.last_price;
            }
          }
        } catch {
          // Network glitch — fall through to newest candle close below
        }

        // 2. Intraday 1-minute candles — 30s cadence per symbol
        try {
          candles = await this.fetchLiveCandles(
            symbol,
            instrumentKey,
            headers,
            candles,
          );
        } catch {
          // Keep previous buffer on transient failure
        }

        // 3. Live option chain — 15s cadence per symbol
        try {
          optionChain = await this.fetchLiveOptionChain(
            symbol,
            instrumentKey,
            headers,
            optionChain,
          );
        } catch {
          // Keep previous chain on transient failure
        }

        // 4. India VIX quote — 60s cadence
        await this.fetchLiveVix(headers);

        // Fallback: newest candle close (Upstox returns newest-first)
        if (spotPrice === 24000 && candles.length) {
          spotPrice = Number(candles[0][4]);
        }
      }

      // Compute indicators and scoring ONCE
      const indicators = computeAllIndicators(candles, optionChain);

      // ── VRD sentiment layer ─────────────────────────────────────────────
      // Live mode: assembled from real breadth/FII/PCR/max-pain/GIFT/news
      // (SentimentIngestor) plus chain-derived walls/IV/MMI. Mock mode and
      // pre-seed states keep the deterministic placeholder so tests stay
      // reproducible.
      const placeholderVrd: VrdData = {
        mmi: { score: 45, label: "Fear" },
        advancesDeclines: {
          advances: 30,
          declines: 20,
          ratio: 1.5,
          label: "Healthy Breadth",
        },
        fiiLongShort: { longPct: 58, shortPct: 42, shortPctTrend: "Rising" },
        fiiPositioning: { netPosition: 450, consecutiveShortDays: 0 },
        pcr: { value: indicators.pcrValue, zone: "buy" },
        straddleIv: { elevated: false, percentAboveAvg: 0 },
        niftyPe: { pe: 21.5, label: "Fair Value" },
        vix: this.vixValue ?? 14.2,
        giftNifty: {
          price: spotPrice + 10,
          changePts: 10,
          changePct: 0.05,
          openingSignal: "Flat",
        },
        supportWall: Math.floor(spotPrice / 100) * 100 - 200,
        resistanceWall: Math.floor(spotPrice / 100) * 100 + 200,
        maxPain: Math.round(spotPrice / 50) * 50,
        fetchedAt: timestamp,
      };

      let vrdData: VrdData;
      if (this.latestVrd) {
        vrdData = this.latestVrd;
      } else if (this.config.mockMode || !this.config.primaryUpstoxToken) {
        vrdData = placeholderVrd;
      } else {
        try {
          const chainExpiry = optionChain[0]?.expiry ?? null;
          vrdData = await this.sentimentIngestor.buildSymbolVrd(
            symbol,
            chainExpiry,
            optionChain,
            indicators,
            this.vixValue,
          );
        } catch {
          vrdData = placeholderVrd;
        }
      }

      // V3 macro signal (browser parity): global sentiment + breadth
      // advances + this symbol's chain OI ratio, through the shared mapping
      // tables — NOT a copy of the EMA.
      const globalIndices = this.sentimentIngestor.getGlobalIndices();
      const marketWide =
        await this.sentimentIngestor.getMarketWide(optionChain);
      let chainPutOi = 0;
      let chainCallOi = 0;
      for (const row of optionChain) {
        chainPutOi += row.put_options?.market_data?.oi ?? 0;
        chainCallOi += row.call_options?.market_data?.oi ?? 0;
      }
      const v3 = computeV3Signal(
        globalIndices,
        marketWide.breadth?.advances ?? null,
        chainPutOi,
        chainCallOi,
      );

      const signalData: AllSignalData = {
        v3,
        indicators,
        vrd: vrdData,
        globalIndices,
      };

      const finalSignal = getFinalSignal(signalData, DEFAULT_STRATEGY_CONFIG);

      const snapshot: MarketSnapshot = {
        timestamp,
        underlyingSymbol: symbol,
        spotPrice,
        candles,
        optionChain,
        vix: vrdData.vix ?? 14,
        pcr: indicators.pcrValue,
        indicators,
        vrdData,
        signal: finalSignal,
        globalIndices: signalData.globalIndices ?? [],
      };

      this.latestSnapshots.set(symbol, snapshot);
    }

    // Emit tick event to all listeners (TenantManager & WebSockets)
    this.emit("marketTick", {
      timestamp,
      snapshots: this.getAllSnapshots(),
    });
  }

  // ── Live Upstox data fetchers ─────────────────────────────────────────────

  /**
   * Fetches live intraday 1-minute candles and replaces the buffer.
   *
   * IMPORTANT: Upstox returns candles newest-first. The array is stored in
   * that native order because the shared indicator engine (used unchanged
   * by the browser client, the backtester, and this daemon) is calibrated
   * on exactly this ordering — do NOT reverse it here.
   */
  private async fetchLiveCandles(
    symbol: UnderlyingSymbol,
    instrumentKey: string,
    headers: Record<string, string>,
    fallback: Candle[],
  ): Promise<Candle[]> {
    const nowMs = Date.now();
    const lastFetch = this.lastCandleFetchMs.get(symbol) ?? 0;
    if (nowMs - lastFetch < MasterIngestionEngine.CANDLE_REFRESH_MS) {
      return fallback;
    }
    this.lastCandleFetchMs.set(symbol, nowMs);
    const res = await fetchWithRetry(
      `${this.config.upstoxApiBaseUrl}/historical-candle/intraday/${encodeURIComponent(instrumentKey)}/1minute`,
      { headers },
    );
    if (!res.ok) return fallback;
    const data = (await res.json()) as { data?: { candles?: Candle[] } };
    const candles = (data?.data?.candles ?? []).filter(
      (row) => Array.isArray(row) && row.length >= 6,
    );
    if (!candles.length) return fallback;
    this.candleBuffer.set(symbol, candles);
    return candles;
  }

  /**
   * Fetches the nearest-expiry live option chain (calls, puts, LTPs, OI).
   * Entry pricing and OTM strike selection depend on this data.
   */
  private async fetchLiveOptionChain(
    symbol: UnderlyingSymbol,
    instrumentKey: string,
    headers: Record<string, string>,
    fallback: OptionData[],
  ): Promise<OptionData[]> {
    const nowMs = Date.now();
    const lastFetch = this.lastChainFetchMs.get(symbol) ?? 0;
    if (nowMs - lastFetch < MasterIngestionEngine.CHAIN_REFRESH_MS) {
      return fallback;
    }
    this.lastChainFetchMs.set(symbol, nowMs);
    const expiry = await this.resolveNearestExpiry(
      symbol,
      instrumentKey,
      headers,
    );
    if (!expiry) return fallback;
    const qs = new URLSearchParams({
      instrument_key: instrumentKey,
      expiry_date: expiry,
    });
    const res = await fetchWithRetry(
      `${this.config.upstoxApiBaseUrl}/option/chain?${qs.toString()}`,
      { headers },
    );
    if (!res.ok) return fallback;
    const data = (await res.json()) as { data?: OptionData[] };
    const chain = data?.data ?? [];
    if (!chain.length) return fallback;
    this.latestOptionChains.set(symbol, chain);
    return chain;
  }

  /**
   * Resolves the nearest upcoming expiry (IST) from Upstox's option-contract
   * list. Handles the weekly/monthly expiry regime automatically because the
   * exchange — not this code — decides which expiries are listed.
   */
  private async resolveNearestExpiry(
    symbol: UnderlyingSymbol,
    instrumentKey: string,
    headers: Record<string, string>,
  ): Promise<string | null> {
    const cached = this.expiryCache.get(symbol);
    if (
      cached &&
      Date.now() - cached.fetchedMs < MasterIngestionEngine.EXPIRY_TTL_MS
    ) {
      return cached.expiry;
    }
    const res = await fetchWithRetry(
      `${this.config.upstoxApiBaseUrl}/option/contract?instrument_key=${encodeURIComponent(instrumentKey)}`,
      { headers },
    );
    if (!res.ok) return cached?.expiry ?? null;
    const data = (await res.json()) as { data?: { expiry?: string }[] };
    const today = getIndiaTime().dateString;
    const expiries = [
      ...new Set(
        (data?.data ?? [])
          .map((item) => item.expiry)
          .filter(
            (value): value is string =>
              typeof value === "string" && value >= today,
          ),
      ),
    ].sort();
    if (!expiries.length) return cached?.expiry ?? null;
    const expiry = expiries[0];
    this.expiryCache.set(symbol, { expiry, fetchedMs: Date.now() });
    return expiry;
  }

  /** Fetches the India VIX spot quote (60s cadence) for the VRD layer + warnings. */
  private async fetchLiveVix(headers: Record<string, string>): Promise<void> {
    const nowMs = Date.now();
    if (nowMs - this.lastVixFetchMs < MasterIngestionEngine.VIX_REFRESH_MS)
      return;
    this.lastVixFetchMs = nowMs;
    try {
      const res = await fetchWithRetry(
        `${this.config.upstoxApiBaseUrl}/market-quote/quotes?instrument_key=${encodeURIComponent("NSE_INDEX|India VIX")}`,
        { headers },
      );
      if (!res.ok) return;
      const data = (await res.json()) as {
        data?: Record<string, { last_price?: number }>;
      };
      const quote =
        data?.data?.["NSE_INDEX:India VIX"] ??
        Object.values(data?.data ?? {})[0];
      if (typeof quote?.last_price === "number") {
        this.vixValue = quote.last_price;
      }
    } catch {
      // Keep previous VIX on transient failure
    }
  }

  private generateSeedCandles(symbol: UnderlyingSymbol): Candle[] {
    const basePrice =
      symbol === "NIFTY 50" ? 24500 : symbol === "BANKNIFTY" ? 51500 : 23000;
    const candles: Candle[] = [];
    let current = basePrice;
    const now = Date.now();

    for (let i = 50; i >= 0; i--) {
      const time = new Date(now - i * 60000).toISOString();
      const delta = (Math.random() - 0.48) * 15;
      const open = current;
      const close = Math.round((current + delta) * 100) / 100;
      const high = Math.max(open, close) + Math.random() * 5;
      const low = Math.min(open, close) - Math.random() * 5;
      const volume = Math.floor(Math.random() * 8000) + 2000;
      candles.push([time, open, high, low, close, volume]);
      current = close;
    }
    return candles;
  }

  private generateMockOptionChain(spot: number): OptionData[] {
    const roundedSpot = Math.round(spot / 50) * 50;
    const strikes = [-200, -150, -100, -50, 0, 50, 100, 150, 200].map(
      (offset) => roundedSpot + offset,
    );
    const expiry = new Date(Date.now() + 5 * 86400000)
      .toISOString()
      .split("T")[0];

    return strikes.map((strike) => {
      const cePrice = Math.max(5, Math.round((spot - strike + 80) * 100) / 100);
      const pePrice = Math.max(5, Math.round((strike - spot + 80) * 100) / 100);
      return {
        expiry,
        strike_price: strike,
        underlying_spot_price: spot,
        call_options: {
          instrument_key: `NSE_FO|OPT_NIFTY_${strike}_CE`,
          trading_symbol: `NIFTY ${expiry} ${strike} CE`,
          market_data: { ltp: cePrice, volume: 50000, oi: 120000 },
        },
        put_options: {
          instrument_key: `NSE_FO|OPT_NIFTY_${strike}_PE`,
          trading_symbol: `NIFTY ${expiry} ${strike} PE`,
          market_data: { ltp: pePrice, volume: 45000, oi: 135000 },
        },
      };
    });
  }
}
