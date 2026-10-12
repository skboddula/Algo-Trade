import { EventEmitter } from "events";
import type {
  UnderlyingSymbol,
  StrategyConfig,
  UserBotState,
  ActivePosition,
  MarketSnapshot,
  AllSignalData,
  PaperTradeRecord,
} from "../types";
import {
  DEFAULT_STRATEGY_CONFIG,
  VIX_CRITICAL_ALERT_COOLDOWN_MS,
  VIX_CRITICAL_THRESHOLD,
  VIX_ELEVATED_THRESHOLD,
  VIX_HARD_STOP_MAX,
} from "../constants";
import { MasterIngestionEngine } from "./masterIngestor";
import { OrderGateway } from "./orderGateway";
import { getLotSizeForSymbol } from "./syntheticCalculators";
import { getOtmStrike } from "./indicators";
import { shouldExit, runHardStopChecks } from "./strategyEngine";
import { getIndiaTime } from "../utils/timeUtils";
import {
  getTelegramConfig,
  sendTelegramMessage,
  buildEntryAlertMessage,
  buildExitAlertMessage,
  buildVixAlertMessage,
  buildDailySummaryMessage,
  type TelegramConfig,
} from "./telegramAlerts";
import { UpstoxMarketStream, type StreamTick } from "./marketStream";
import type { BotLogService } from "./botLogService";
import { loadState, saveState } from "../utils/store";

export class TenantManager extends EventEmitter {
  private users: Map<string, UserBotState> = new Map();
  private masterIngestor: MasterIngestionEngine;
  private orderGateway: OrderGateway;
  private telegramConfig: TelegramConfig | null;
  private vixWarningLevel: "none" | "elevated" | "critical" = "none";
  private lastVixAlertAt: number = 0;
  private dailySummaryDate: string | null =
    loadState<{ date?: string }>("daily_summary_date")?.date ?? null;
  private marketStream: UpstoxMarketStream;

  private botLogs: BotLogService | null;
  private lastSignalBySymbol: Map<UnderlyingSymbol, string> = new Map();

  // ── Recovery lifecycle (CR-04) ─────────────────────────────────────────
  // Entries in LIVE mode stay blocked until startup reconciliation of
  // persisted state (and, for live users, broker positions) completes.
  private recoveryStatus: "pending" | "complete" | "failed" = "pending";
  private recoveryNotes: string[] = [];

  // ── Persistence health (CR-15) ────────────────────────────────────────
  // A failed critical write is an operational fault: live entries are
  // blocked until persistence is healthy again.
  private persistenceFault: string | null = null;

  // Rate-limit for the CR-11 data-stale WARN so a brief data outage at
  // market open doesn't spam one log line per tick (every 2s).
  private lastStaleWarnAtMs = new Map<UnderlyingSymbol, number>();

  // ── Live trading arming (CR-08) ────────────────────────────────────────
  private static readonly LIVE_ARM_ENV = "DAEMON_LIVE_ARMED";

  constructor(
    masterIngestor: MasterIngestionEngine,
    orderGateway: OrderGateway,
    botLogs?: BotLogService,
  ) {
    super();
    this.setMaxListeners(100);
    this.masterIngestor = masterIngestor;
    this.orderGateway = orderGateway;
    this.botLogs = botLogs ?? null;
    this.telegramConfig = getTelegramConfig();

    // Initialize the WebSocket market stream for tick-level prices + VIX
    this.marketStream = new UpstoxMarketStream({
      getToken: () => masterIngestor.getPrimaryToken(),
    });
    this.marketStream.on("tick", (tick: StreamTick) => {
      this.handleStreamTick(tick);
    });
    this.marketStream.on("status", (status, detail) => {
      if (status === "open") {
        console.log(
          "[stream] Upstox market stream connected — tick-level prices active",
        );
        this.log(
          "info",
          "stream",
          "Upstox market stream connected — tick-level prices active",
        );
      } else if (status === "closed" && detail) {
        console.warn(`[stream] ${detail}`);
        this.log("warn", "stream", detail);
      }
    });
    this.marketStream.start();

    // CR-09: when a token first arrives (morning OAuth handoff) or changes,
    // replace the stream's authenticated connection with the fresh one.
    this.masterIngestor.on("tokenChanged", () => {
      const token = this.masterIngestor.getPrimaryToken();
      if (!token) return;
      // A CHANGE of token requires replacing the (possibly authenticated-with
      // the OLD token) socket; notifyTokenAvailable handles the no-socket
      // startup case. reconnect() is safe for both: it no-ops duplicates
      // via the single-socket guard when nothing is connected, but for a
      // live socket we must tear down and reconnect with the new token.
      this.marketStream.reconnect();
      this.log(
        "info",
        "stream",
        "Upstox token refreshed — stream reconnecting with new credentials",
      );
    });

    // CR-04: startup recovery — validate persisted state, reconcile live
    // users against the broker where possible, then arm entries.
    this.runStartupRecovery();

    // CR-10: restore stream subscriptions for any persisted open positions
    // so trailing stops and PnL ticks work immediately after a restart.
    this.syncStreamSubscriptions();

    // Bind to master market ticks (REST polling — fallback/supplement to the stream)
    this.masterIngestor.on("marketTick", (tick) => {
      this.handleMarketTick(tick).catch((err) => {
        this.emit("error", err);
      });
    });
  }

  /** CR-04: validates persisted state and reconciles live users. */
  private async runStartupRecovery(): Promise<void> {
    this.recoveryStatus = "pending";
    this.recoveryNotes = [];
    try {
      // Step 0: load persisted user states from disk.
      this.restoreUserStates();

      // Step 1: validate each restored user's shape.
      for (const [userId, user] of this.users.entries()) {
        const issues = this.validateUserState(user);
        if (issues.length > 0) {
          this.recoveryNotes.push(`user ${userId}: ${issues.join("; ")}`);
          this.log(
            "warn",
            "recovery",
            `Restored state for ${userId} has issues: ${issues.join("; ")}`,
          );
        }
        // Step 2: for LIVE users with open positions, reconcile against the
        // broker where a token is available; blocked live entries on failure.
        const hasPosition = Object.values(user.positions).some(
          (p) => p !== null,
        );
        if (user.executionMode === "live" && hasPosition) {
          const token =
            user.upstoxToken ?? this.masterIngestor.getPrimaryToken();
          if (!token) {
            this.recoveryNotes.push(
              `LIVE user ${userId} holds an open position but no token is available — live entries BLOCKED until reconciled`,
            );
            continue;
          }
          const brokerPositions =
            await this.orderGateway.getLivePositions(token);
          if (brokerPositions === null) {
            this.recoveryNotes.push(
              `LIVE user ${userId}: broker position fetch failed — live entries BLOCKED until reconciled`,
            );
            this.log(
              "warn",
              "recovery",
              `Broker reconciliation for ${userId} unavailable — live entries blocked`,
            );
          } else {
            const held = Object.values(user.positions).filter(
              (p) => p !== null,
            ) as { instrumentKey: string }[];
            for (const pos of held) {
              const match = brokerPositions.find(
                (b) => b.instrumentKey === pos.instrumentKey,
              );
              if (!match) {
                this.recoveryNotes.push(
                  `position ${pos.instrumentKey} not found at broker for ${userId} — verify before assuming it closed`,
                );
                this.log(
                  "warn",
                  "recovery",
                  `Mismatch: local position ${pos.instrumentKey} for ${userId} absent at broker`,
                );
              }
            }
          }
        }
      }
      this.recoveryStatus = "complete";
      this.log(
        "info",
        "recovery",
        `Startup recovery complete${this.recoveryNotes.length > 0 ? ` (${this.recoveryNotes.length} note(s))` : ""}`,
      );
    } catch (err) {
      this.recoveryStatus = "failed";
      this.recoveryNotes.push(`recovery error: ${(err as Error).message}`);
      this.log(
        "error",
        "recovery",
        `Startup recovery FAILED — live entries blocked: ${(err as Error).message}`,
      );
    }
  }

  /** CR-04: shape validation for persisted user state. */
  private validateUserState(user: UserBotState): string[] {
    const issues: string[] = [];
    if (!user.userId) issues.push("missing userId");
    if (!user.state) issues.push("missing state");
    if (typeof user.positions !== "object" || user.positions === null) {
      issues.push("positions object missing/corrupt");
    } else {
      for (const [sym, pos] of Object.entries(user.positions)) {
        if (
          pos !== null &&
          typeof (pos as ActivePosition).instrumentKey !== "string"
        ) {
          issues.push(`position for ${sym} missing instrumentKey`);
        }
      }
    }
    if (typeof user.tradesCountToday !== "number") {
      user.tradesCountToday = 0;
      issues.push("tradesCountToday invalid — reset to 0");
    }
    return issues;
  }

  /** CR-04: recovery status for API exposure. */
  public getRecoveryStatus(): {
    status: "pending" | "complete" | "failed";
    notes: string[];
  } {
    return { status: this.recoveryStatus, notes: [...this.recoveryNotes] };
  }

  /** CR-15: persistence health; a fault blocks live entries. */
  public getPersistenceFault(): string | null {
    return this.persistenceFault;
  }

  /** Applies streamed tick-level prices to open positions in real time. */
  private handleStreamTick(tick: StreamTick): void {
    // Skip VIX ticks (handled by getStreamedVix)
    if (tick.instrumentKey === "NSE_INDEX|India VIX") return;

    for (const user of this.users.values()) {
      if (user.state !== "RUNNING" && user.state !== "ORDERED") continue;
      for (const position of Object.values(user.positions)) {
        if (!position || position.instrumentKey !== tick.instrumentKey)
          continue;

        // Update current price and peak from the streamed tick
        const prevPrice = position.currentPrice ?? position.entryPrice;
        position.currentPrice = tick.ltp;

        // Track peak favorable price (buying: max, selling: min)
        if (position.tradeType === "selling") {
          position.peakFavorablePrice =
            position.peakFavorablePrice === undefined
              ? tick.ltp
              : Math.min(position.peakFavorablePrice, tick.ltp);
        } else {
          position.peakFavorablePrice =
            position.peakFavorablePrice === undefined
              ? tick.ltp
              : Math.max(position.peakFavorablePrice, tick.ltp);
        }

        // Recalculate unrealized PnL
        const pnlPerUnit =
          position.tradeType === "selling"
            ? position.entryPrice - tick.ltp
            : tick.ltp - position.entryPrice;
        position.unrealizedPnl =
          Math.round(pnlPerUnit * position.quantity * 100) / 100;

        // Only emit an update if the price changed meaningfully (>0.1%)
        if (Math.abs(tick.ltp - prevPrice) / (prevPrice || 1) > 0.001) {
          user.updatedAt = new Date().toISOString();
          this.emitUserUpdate(user);
        }
      }
    }
  }

  /** Syncs the stream subscriptions to all held position keys + India VIX. */
  private syncStreamSubscriptions(): void {
    const keys = new Set<string>(["NSE_INDEX|India VIX"]);
    for (const user of this.users.values()) {
      for (const position of Object.values(user.positions)) {
        if (position?.instrumentKey) keys.add(position.instrumentKey);
      }
    }
    this.marketStream.setSubscriptions(Array.from(keys));
  }

  public getOrCreateUser(userId: string): UserBotState {
    const istInfo = getIndiaTime();
    let user = this.users.get(userId);
    if (!user) {
      const paperAccount = this.orderGateway.getOrCreatePaperAccount(userId);
      user = {
        userId,
        state: "IDLE",
        executionMode: "paper",
        config: { ...DEFAULT_STRATEGY_CONFIG },
        positions: {
          "NIFTY 50": null,
          BANKNIFTY: null,
          FINNIFTY: null,
        },
        tradesCountToday: 0,
        tradesCountPerSymbol: {},
        lastTradeDate: istInfo.dateString,
        lastExitTimes: {},
        totalRealizedPnl: 0,
        paperBalance: paperAccount.balance,
        updatedAt: new Date().toISOString(),
      };
      this.users.set(userId, user);
    } else {
      // Date rollover check: reset daily counts if new IST trading day
      if (user.lastTradeDate !== istInfo.dateString) {
        user.lastTradeDate = istInfo.dateString;
        user.tradesCountToday = 0;
        user.tradesCountPerSymbol = {};
      }
      const paperAccount = this.orderGateway.getOrCreatePaperAccount(userId);
      user.paperBalance = paperAccount.balance;
    }
    return user;
  }

  public updateConfig(
    userId: string,
    config: Partial<StrategyConfig>,
  ): UserBotState {
    const user = this.getOrCreateUser(userId);
    user.config = { ...user.config, ...config };
    user.executionMode = user.config.executionMode;
    user.updatedAt = new Date().toISOString();
    this.emitUserUpdate(user);
    return user;
  }

  public setToken(userId: string, token: string): UserBotState {
    const user = this.getOrCreateUser(userId);
    user.upstoxToken = token;
    user.updatedAt = new Date().toISOString();
    this.emitUserUpdate(user);
    return user;
  }

  public startBot(
    userId: string,
    executionMode?: "paper" | "live",
  ): UserBotState {
    const user = this.getOrCreateUser(userId);

    // CR-08: live trading requires explicit SERVER-SIDE arming. A client
    // flipping executionMode:"live" in a request body can never arm real
    // orders without the operator setting DAEMON_LIVE_ARMED=true in the
    // daemon's environment.
    const requestedMode = executionMode ?? user.executionMode;
    if (requestedMode === "live") {
      if (process.env[TenantManager.LIVE_ARM_ENV] !== "true") {
        this.log(
          "error",
          "bot",
          `LIVE start for ${userId} REJECTED: ${TenantManager.LIVE_ARM_ENV} is not set on the daemon`,
        );
        throw new Error(
          `Live trading is not armed: set ${TenantManager.LIVE_ARM_ENV}=true in the daemon environment to enable live orders`,
        );
      }
      // CR-04/CR-15: live entries stay blocked until recovery completes and
      // persistence is healthy.
      if (this.recoveryStatus !== "complete") {
        this.log(
          "error",
          "bot",
          `LIVE start for ${userId} REJECTED: startup recovery is ${this.recoveryStatus}`,
        );
        throw new Error(
          `Live trading blocked: startup recovery is ${this.recoveryStatus}`,
        );
      }
      if (this.persistenceFault !== null) {
        this.log(
          "error",
          "bot",
          `LIVE start for ${userId} REJECTED: persistence fault (${this.persistenceFault})`,
        );
        throw new Error(
          `Live trading blocked: persistence fault (${this.persistenceFault})`,
        );
      }
    }

    if (executionMode) {
      user.executionMode = executionMode;
      user.config.executionMode = executionMode;
    }
    const hasOpenPosition = Object.values(user.positions).some(
      (p) => p !== null,
    );
    user.state = hasOpenPosition ? "ORDERED" : "RUNNING";
    this.log(
      "info",
      "bot",
      `Bot started for ${userId} (${user.executionMode})${hasOpenPosition ? " — resuming open position supervision" : ""}`,
      userId,
    );
    user.error = undefined;
    user.updatedAt = new Date().toISOString();
    this.emitUserUpdate(user);
    this.persistUserStates();
    return user;
  }

  public stopBot(userId: string): UserBotState {
    const user = this.getOrCreateUser(userId);
    user.state = "STOPPED";
    const openCount = Object.values(user.positions).filter(
      (p) => p !== null,
    ).length;
    // CR-03: stopping only disables NEW ENTRIES. Open positions remain
    // under full supervision (stop-loss, trailing, EOD square-off) until
    // they close or an explicit exit is requested. Abandoning positions
    // silently would be unsafe.
    this.log(
      "warn",
      "bot",
      `Bot stopped for ${userId} — new entries blocked${openCount > 0 ? `; ${openCount} open position(s) remain under protective supervision` : ""}`,
      userId,
    );
    user.updatedAt = new Date().toISOString();
    this.emitUserUpdate(user);
    this.persistUserStates();
    return user;
  }

  /** Stops the WebSocket market stream — called on server shutdown. */
  public shutdown(): void {
    this.marketStream.stop();
    this.persistUserStates();
  }

  /** Returns the current WebSocket market stream health status. */
  public getStreamHealth(): {
    status: string;
    vix: number | null;
    subscribedKeys: number;
    lastTickAt: number | null;
    tickAgeMs: number | null;
    reconnectCount: number;
    lastError: string | null;
  } {
    const vix = this.marketStream.getStreamedVix();
    const telemetry = this.marketStream.getTelemetry();
    return {
      status: telemetry.status,
      vix,
      subscribedKeys: telemetry.subscribedKeys,
      lastTickAt: telemetry.lastTickAtMs,
      tickAgeMs: telemetry.tickAgeMs,
      reconnectCount: telemetry.reconnectCount,
      lastError: telemetry.lastError,
    };
  }

  /** Restores user bot states from disk on startup. */
  private restoreUserStates(): void {
    const saved = loadState<Record<string, UserBotState>>("user_states");
    if (!saved) return;
    for (const [userId, state] of Object.entries(saved)) {
      this.users.set(userId, state);
      console.log(
        `[tenantManager] Restored user ${userId}: state=${state.state}, positions=${Object.values(state.positions).filter(Boolean).length}`,
      );
    }
  }

  /**
   * Persists all user bot states to disk (call after significant changes).
   * CR-15: write failures become an explicit operational fault — live
   * entries stay blocked until persistence is healthy again. The in-memory
   * state is NOT rolled back (trading continues under paper); the fault is
   * logged and exposed.
   */
  private persistUserStates(): void {
    const states: Record<string, UserBotState> = {};
    for (const [userId, state] of this.users.entries()) {
      states[userId] = state;
    }
    try {
      saveState("user_states", states);
      if (this.persistenceFault !== null) {
        this.persistenceFault = null;
        this.log("info", "persistence", "User-state writes healthy again");
      }
    } catch (err) {
      this.persistenceFault = `user_states save failed: ${(err as Error).message}`;
      this.log(
        "error",
        "persistence",
        `CRITICAL: state save FAILED — live entries blocked until resolved: ${(err as Error).message}`,
      );
    }
  }

  public async manualExit(
    userId: string,
    symbol: UnderlyingSymbol,
    reason = "Manual exit",
  ): Promise<UserBotState> {
    const user = this.getOrCreateUser(userId);
    const position = user.positions[symbol];
    if (position) {
      // CR-01: duplicate-exit guard — never fire two concurrent exits for
      // the same position (tick overlap or repeated commands).
      if (position.pendingExit) {
        this.log(
          "warn",
          "exit",
          `[${symbol}] Exit already in flight — skipping duplicate request`,
        );
        return user;
      }
      position.pendingExit = true;
      try {
        const exitPrice = position.currentPrice || position.entryPrice;
        const result = await this.orderGateway.exitOrder({
          userId,
          executionMode: user.executionMode,
          token: user.upstoxToken,
          position,
          exitPrice,
          reason,
        });

        // CR-01: only a CONFIRMED fill closes the position. Rejected,
        // unknown, or still-pending outcomes RETAIN the position so it stays
        // under supervision; the error is surfaced for the operator.
        if (!result.success || result.status !== "filled") {
          const outcome =
            result.status === "pending"
              ? `submitted but UNCONFIRMED (broker order ${result.brokerOrderId ?? "?"})`
              : result.status === "unknown"
                ? "outcome UNKNOWN (reconcile against the broker order book)"
                : result.status === "rejected"
                  ? "REJECTED by the broker"
                  : "failed";
          user.error = `Exit ${outcome}: ${result.error ?? "unknown error"}`;
          this.log(
            "error",
            "exit",
            `[${symbol}] Exit NOT completed — position retained. ${outcome}: ${result.error ?? "unknown error"}`,
          );
          this.emitUserUpdate(user);
          return user;
        }

        // Broker-confirmed fill — safe to close the position everywhere.
        const confirmedExitPrice = result.filledPrice || exitPrice;
        this.sendExitAlert(user, position, symbol, confirmedExitPrice, reason);
        const exitPnl =
          (position.tradeType === "selling"
            ? position.entryPrice - confirmedExitPrice
            : confirmedExitPrice - position.entryPrice) *
          (result.quantity || position.quantity);
        this.log(
          exitPnl >= 0 ? "info" : "warn",
          "exit",
          `[${symbol}] Exited ${position.direction} @ ${confirmedExitPrice.toFixed(2)} — ${reason} (PnL ₹${(exitPnl >= 0 ? "+" : "") + exitPnl.toFixed(2)})`,
          userId,
        );

        user.positions[symbol] = null;
        user.lastExitTimes[symbol] = Date.now();
        const hasOtherPositions = Object.values(user.positions).some(
          (p) => p !== null,
        );
        user.state = hasOtherPositions
          ? "ORDERED"
          : user.state === "ORDERED"
            ? "RUNNING"
            : user.state;
        user.paperBalance =
          this.orderGateway.getOrCreatePaperAccount(userId).balance;
        user.updatedAt = new Date().toISOString();
        user.error = undefined;
        this.emitUserUpdate(user);
        this.syncStreamSubscriptions();
        this.persistUserStates();
      } finally {
        if (user.positions[symbol]) {
          user.positions[symbol]!.pendingExit = false;
        }
      }
    }
    return user;
  }

  /** Sends a Telegram entry alert after a successful order placement. */
  private sendEntryAlert(
    user: UserBotState,
    position: ActivePosition,
    symbol: UnderlyingSymbol,
    selectedContract: { strikePrice?: number; expiry?: string },
  ): void {
    if (!this.telegramConfig) return;
    const message = buildEntryAlertMessage({
      symbol,
      signal: position.direction === "CE" ? "BUY_CE" : "BUY_PE",
      confidence: "moderate",
      executionMode: user.executionMode === "live" ? "live" : "paper",
      strikePrice: selectedContract.strikePrice,
      expiry: selectedContract.expiry,
      legs: [
        {
          direction: position.direction,
          entryPrice: position.entryPrice,
          quantity: position.quantity,
          lotSize: position.lotSize || 1,
          tradeType: position.tradeType === "selling" ? "selling" : "buying",
        },
      ],
      maxProfitPct: user.config.maxProfitPct,
      maxLossPct: user.config.maxLossPct,
      trailPct: user.config.trailPct,
    });
    sendTelegramMessage(this.telegramConfig, message)
      .then(() =>
        this.log(
          "info",
          "telegram",
          `[${symbol}] Entry alert sent`,
          user.userId,
        ),
      )
      .catch(() =>
        this.log(
          "warn",
          "telegram",
          `[${symbol}] Entry alert failed`,
          user.userId,
        ),
      );
  }

  /** Sends a Telegram exit alert with PnL details. */
  private sendExitAlert(
    user: UserBotState,
    position: ActivePosition,
    symbol: UnderlyingSymbol,
    exitPrice: number,
    reason: string,
  ): void {
    if (!this.telegramConfig) return;
    const message = buildExitAlertMessage({
      symbol,
      direction: position.direction === "CE" ? "CE" : "PE",
      executionMode: user.executionMode === "live" ? "live" : "paper",
      entryPrice: position.entryPrice,
      exitPrice,
      quantity: position.quantity,
      lotSize: position.lotSize || 1,
      tradeType: position.tradeType === "selling" ? "selling" : "buying",
      reason,
      entryTime: position.entryTime,
      exitTime: new Date().toISOString(),
      strikePrice: position.strikePrice,
      expiry: position.expiry,
    });
    sendTelegramMessage(this.telegramConfig, message)
      .then(() =>
        this.log(
          "info",
          "telegram",
          `[${symbol}] Exit alert sent`,
          user.userId,
        ),
      )
      .catch(() =>
        this.log(
          "warn",
          "telegram",
          `[${symbol}] Exit alert failed`,
          user.userId,
        ),
      );
  }

  /** Sends a VIX early warning when thresholds are crossed (with 5-min cooldown). */
  private checkVixWarning(
    vrdData: { vix?: number | null } | null | undefined,
  ): void {
    if (!this.telegramConfig) return;
    // Prefer tick-level streamed VIX over the REST-polled value
    const streamedVix = this.marketStream.getStreamedVix();
    const vix = streamedVix ?? vrdData?.vix;
    if (!vix || !Number.isFinite(vix)) return;
    const level =
      vix >= VIX_CRITICAL_THRESHOLD
        ? "critical"
        : vix >= VIX_ELEVATED_THRESHOLD
          ? "elevated"
          : "none";
    if (level === this.vixWarningLevel) return;

    this.vixWarningLevel = level;
    this.log("warn", "vix", `VIX ${vix.toFixed(2)} — ${level} level`);
    if (level === "critical") {
      const now = Date.now();
      if (now - this.lastVixAlertAt < VIX_CRITICAL_ALERT_COOLDOWN_MS) return; // cooldown
      this.lastVixAlertAt = now;
      sendTelegramMessage(
        this.telegramConfig,
        buildVixAlertMessage({ vix, threshold: VIX_HARD_STOP_MAX }),
      ).catch(() => {});
    }
  }

  /** Sends a daily summary after EOD when all positions are closed. */
  private checkDailySummary(
    user: UserBotState,
    istInfo: { dateString: string },
  ): void {
    if (!this.telegramConfig) return;
    if (this.dailySummaryDate === istInfo.dateString) return;

    const hasActivePositions = Object.values(user.positions).some(
      (p) => p !== null,
    );
    if (hasActivePositions) return;

    // Only send after cutoff (date persisted — daemon restarts don't re-send)
    this.dailySummaryDate = istInfo.dateString;
    saveState("daily_summary_date", { date: istInfo.dateString });

    const allTrades = this.orderGateway.getPaperTrades(user.userId);
    const closedTrades = allTrades.filter(
      (t) =>
        t.status === "CLOSED" && t.closedAt?.startsWith(istInfo.dateString),
    );
    if (closedTrades.length === 0) return;

    this.log(
      "info",
      "summary",
      `[${user.userId}] Daily summary sent — ${closedTrades.length} closed trade(s) today`,
      user.userId,
    );
    const wins = closedTrades.filter((t) => (t.realizedPnl ?? 0) > 0);
    const losses = closedTrades.filter((t) => (t.realizedPnl ?? 0) <= 0);
    const realizedPnl = closedTrades.reduce(
      (s, t) => s + (t.realizedPnl ?? 0),
      0,
    );
    const best = wins.length
      ? wins.reduce((a, b) =>
          (a.realizedPnl ?? 0) >= (b.realizedPnl ?? 0) ? a : b,
        )
      : undefined;
    const worst = losses.length
      ? losses.reduce((a, b) =>
          (a.realizedPnl ?? 0) <= (b.realizedPnl ?? 0) ? a : b,
        )
      : undefined;

    const getSymbol = (t: PaperTradeRecord): string => {
      const meta = t.metadata as { underlyingSymbol?: string } | undefined;
      return meta?.underlyingSymbol ?? "—";
    };

    // NOTE: trade records and the account store PAISE — the summary
    // builder's contract is RUPEES. Convert here (this also fixes the
    // 100x-too-large values the pre-unification summary displayed).
    const message = buildDailySummaryMessage({
      date: istInfo.dateString,
      totalTrades: closedTrades.length,
      wins: wins.length,
      losses: losses.length,
      realizedPnl: realizedPnl / 100,
      paperBalance: (user.paperBalance ?? 0) / 100,
      bestTrade: best
        ? {
            symbol: getSymbol(best),
            direction: best.direction,
            pnl: (best.realizedPnl ?? 0) / 100,
          }
        : undefined,
      worstTrade: worst
        ? {
            symbol: getSymbol(worst),
            direction: worst.direction,
            pnl: (worst.realizedPnl ?? 0) / 100,
          }
        : undefined,
    });
    sendTelegramMessage(this.telegramConfig, message).catch(() => {});
  }

  private async handleMarketTick(tick: {
    timestamp: string;
    snapshots: Record<UnderlyingSymbol, MarketSnapshot>;
  }) {
    const istInfo = getIndiaTime();

    // Check VIX early warning once per tick (uses primary symbol's VRD data)
    const primarySnapshot =
      tick.snapshots["NIFTY 50"] ?? Object.values(tick.snapshots)[0];
    if (primarySnapshot?.vrdData) {
      this.checkVixWarning(primarySnapshot.vrdData);
    }

    for (const [userId, user] of this.users.entries()) {
      if (user.state === "IDLE") continue;

      // CR-03: a STOPPED bot blocks new entries but KEEPS supervising any
      // open positions (protective exits, EOD square-off). Only users with
      // no positions are skipped entirely.
      const userHasPosition = Object.values(user.positions).some(
        (p) => p !== null,
      );
      if (user.state === "STOPPED" && !userHasPosition) continue;

      // Daily rollover check
      if (user.lastTradeDate !== istInfo.dateString) {
        user.lastTradeDate = istInfo.dateString;
        user.tradesCountToday = 0;
        user.tradesCountPerSymbol = {};
      }

      const afterCutoff = istInfo.isAfterCutoff(
        user.config.lastEntryTime || "15:15",
      );

      // ── Market-hours guard (NSE: Mon–Fri, 09:15–15:30 IST) ─────────────
      // Weekend/off-hours snapshots are the previous session's frozen data:
      // signals computed on them are meaningless, and any position held
      // while the market is closed cannot be managed — square it off
      // immediately and never evaluate new entries.
      if (!istInfo.isMarketHours) {
        for (const symbol of Object.keys(
          user.positions,
        ) as UnderlyingSymbol[]) {
          if (user.positions[symbol]) {
            this.log(
              "warn",
              "eod",
              `[${symbol}] Market closed — squaring off position held outside market hours`,
              userId,
            );
            await this.manualExit(
              userId,
              symbol,
              "Market closed — position held outside trading hours",
            );
          }
        }
        continue;
      }

      const targetSymbols: UnderlyingSymbol[] =
        user.config.underlyingMode === "ALL_PARALLEL"
          ? ["NIFTY 50", "BANKNIFTY", "FINNIFTY"]
          : [user.config.underlyingMode as UnderlyingSymbol];

      for (const symbol of targetSymbols) {
        const snapshot = tick.snapshots[symbol];
        if (!snapshot) continue;

        const position = user.positions[symbol];

        // ── 1. Supervise Active Position ─────────────────────────────────────
        if (position) {
          // Update option pricing
          const optionChain = snapshot.optionChain || [];
          const optRow = optionChain.find(
            (r) =>
              r.call_options.instrument_key === position.instrumentKey ||
              r.put_options.instrument_key === position.instrumentKey,
          );

          const currentPrice =
            position.direction === "CE"
              ? optRow?.call_options?.market_data?.ltp ||
                position.currentPrice ||
                position.entryPrice
              : optRow?.put_options?.market_data?.ltp ||
                position.currentPrice ||
                position.entryPrice;

          position.currentPrice = currentPrice;

          // Track peak favorable price for trailing SL
          if (!position.peakFavorablePrice) {
            position.peakFavorablePrice = currentPrice;
          } else {
            position.peakFavorablePrice =
              position.tradeType === "selling"
                ? Math.min(position.peakFavorablePrice, currentPrice)
                : Math.max(position.peakFavorablePrice, currentPrice);
          }

          // Calculate unrealized PnL
          const pnlPerUnit =
            position.tradeType === "selling"
              ? position.entryPrice - currentPrice
              : currentPrice - position.entryPrice;
          position.unrealizedPnl =
            Math.round(pnlPerUnit * position.quantity * 100) / 100;

          // Check EOD auto square-off
          if (afterCutoff) {
            this.log(
              "info",
              "eod",
              `[${symbol}] 15:15 cutoff reached — squaring off open position`,
              userId,
            );
            await this.manualExit(
              userId,
              symbol,
              "15:15 EOD Cutoff Square-off",
            );
            continue;
          }

          // Check Hard Stop & Trailing Stop Loss triggers
          if (!snapshot.indicators) continue;

          const signalData: AllSignalData = {
            v3:
              snapshot.indicators.ema === "Buy"
                ? "buy"
                : snapshot.indicators.ema === "Sell"
                  ? "sell"
                  : "hold",
            indicators: snapshot.indicators,
            vrd: snapshot.vrdData || null,
          };

          const exitDecision = shouldExit(
            position,
            signalData,
            position.currentPrice ?? position.entryPrice,
            user.config,
          );
          if (exitDecision.exit) {
            await this.manualExit(
              userId,
              symbol,
              exitDecision.reason || "Hard Stop / Trailing SL",
            );
            continue;
          }
        }

        // ── 2. Evaluate New Entry (If no position and before cutoff) ──────────
        // CR-03: STOPPED bots never enter. CR-14: ORDERED bots CAN enter on
        // their remaining symbols (ALL_PARALLEL semantics — one position per
        // symbol; the position check above is the per-symbol duplicate guard).
        const entriesEnabled =
          user.state === "RUNNING" || user.state === "ORDERED";
        if (!position && entriesEnabled && !afterCutoff) {
          // CR-06 (entry-path gate): a critical state write failure means the
          // daemon's persisted state no longer matches reality. BLOCK live
          // entries immediately — every new position would be invisible to a
          // restart. Paper entries are simulations; they may continue (the
          // fault is already surfaced as an operational flag).
          if (user.executionMode === "live" && this.persistenceFault !== null) {
            this.log(
              "error",
              "persistence",
              `[${symbol}] LIVE entry BLOCKED — persistence fault (${this.persistenceFault}). ` +
                `Existing positions remain supervised; no new live positions until writes recover.`,
              userId,
            );
            continue;
          }
          // CR-14: optional GLOBAL cap across all symbols for the day
          if (
            user.config.maxTotalTradesPerDay !== undefined &&
            (user.tradesCountToday || 0) >= user.config.maxTotalTradesPerDay
          ) {
            continue;
          }
          // CR-11: block entries when required market data is stale
          const blockers = snapshot.sources?.entryBlockedReasons;
          if (blockers && blockers.length > 0) {
            // WARN at most once per 30s per symbol — the gate still blocks
            // on EVERY tick, only the log line is throttled.
            const lastWarn = this.lastStaleWarnAtMs.get(symbol) ?? 0;
            if (Date.now() - lastWarn > 30_000) {
              this.lastStaleWarnAtMs.set(symbol, Date.now());
              this.log(
                "warn",
                "data-stale",
                `[${symbol}] Entry blocked — ${blockers.join("; ")}`,
              );
            }
            continue;
          }
          const tradesCount = user.tradesCountPerSymbol[symbol] || 0;
          if (tradesCount >= user.config.maxTradesPerDay) continue;

          const lastExit = user.lastExitTimes[symbol] || 0;
          const cooldownMs = (user.config.exitCooldownSec || 60) * 1000;
          if (Date.now() - lastExit < cooldownMs) continue;

          const signal = snapshot.signal;
          if (
            signal &&
            (signal.signal === "BUY_CE" || signal.signal === "BUY_PE")
          ) {
            // Entry hard-stop gate (browser parity): VIX tradeability band +
            // high-severity macro news block new entries entirely.
            const hardStop = runHardStopChecks(snapshot.vrdData ?? null);
            if (hardStop.blocked) {
              this.log(
                "warn",
                "hard-stop",
                `[${symbol}] Entry blocked: ${hardStop.reasons.join("; ")}`,
              );
              continue;
            }
            this.trackSignalChange(symbol, signal.signal, signal.confidence);
            const direction = signal.signal === "BUY_CE" ? "CE" : "PE";
            const optionChain = snapshot.optionChain || [];
            const otmRow = getOtmStrike(
              optionChain,
              direction,
              user.config.otmSkip,
            );
            const lotSize = getLotSizeForSymbol(symbol);
            const otmOption =
              otmRow &&
              (direction === "CE" ? otmRow.call_options : otmRow.put_options);
            const selectedContract = otmOption
              ? {
                  strike: otmRow!.strike_price,
                  instrumentKey: otmOption.instrument_key,
                  price: otmOption.market_data?.ltp ?? 0,
                  lotSize,
                }
              : null;

            if (selectedContract && selectedContract.price > 0) {
              const orderRes = await this.orderGateway.placeOrder({
                userId,
                executionMode: user.executionMode,
                token: user.upstoxToken,
                instrumentKey: selectedContract.instrumentKey,
                direction,
                quantity: selectedContract.lotSize,
                price: selectedContract.price,
                tradeType:
                  user.config.tradeType === "selling" ? "selling" : "buying",
                underlyingSymbol: symbol,
                strikePrice: selectedContract.strike,
                expiry: optionChain[0]?.expiry,
              });

              // ── CR-02: only a CONFIRMED fill creates a position ───────────
              // A "pending" or "unknown" outcome must never become a filled
              // position (entryPrice 0, quantity 0 = ghost position that
              // blocks the symbol forever). Partial fills use the broker-
              // confirmed quantity (orderRes.quantity), which may be less
              // than the requested amount.
              if (
                orderRes.success &&
                orderRes.status === "filled" &&
                orderRes.filledPrice > 0 &&
                orderRes.quantity > 0
              ) {
                this.log(
                  "info",
                  "entry",
                  `[${symbol}] Entered ${direction} ${selectedContract.strike} @ ₹${orderRes.filledPrice.toFixed(2)} qty=${orderRes.quantity} (expiry ${optionChain[0]?.expiry ?? "?"})`,
                  userId,
                );
                const newPos: ActivePosition = {
                  instrumentKey: selectedContract.instrumentKey,
                  direction,
                  entryPrice: orderRes.filledPrice,
                  quantity: orderRes.quantity,
                  lotSize: selectedContract.lotSize,
                  entryTime: new Date().toISOString(),
                  tradeId: Date.now(),
                  executionMode: user.executionMode,
                  paperTradeId: orderRes.tradeId,
                  tradeType: user.config.tradeType,
                  currentPrice: orderRes.filledPrice,
                  unrealizedPnl: 0,
                  peakFavorablePrice: orderRes.filledPrice,
                  underlyingSymbol: symbol,
                  strikePrice: selectedContract.strike,
                  expiry: optionChain[0]?.expiry,
                };

                user.positions[symbol] = newPos;
                user.state = "ORDERED";
                user.tradesCountToday = (user.tradesCountToday || 0) + 1;
                user.tradesCountPerSymbol[symbol] =
                  (user.tradesCountPerSymbol[symbol] || 0) + 1;
                user.paperBalance =
                  this.orderGateway.getOrCreatePaperAccount(userId).balance;
                user.updatedAt = new Date().toISOString();
                this.emitUserUpdate(user);
                this.syncStreamSubscriptions();
                const persistBefore = this.persistenceFault;
                this.persistUserStates();
                // CR-06 (post-entry safety): the order IS at the broker — we
                // cannot undo it. If the state write failed, the position is
                // supervised in-memory (the tick loop holds it) but would be
                // LOST on restart. Surface CRITICAL, block further live
                // entries via the fault flag, and continue supervising.
                if (
                  this.persistenceFault !== null &&
                  persistBefore === null &&
                  user.executionMode === "live"
                ) {
                  this.log(
                    "error",
                    "persistence",
                    `CRITICAL: LIVE position ${newPos.instrumentKey} for ${userId} ` +
                      `exists at the broker but could NOT be persisted — it will be ` +
                      `lost on restart. Position remains supervised in memory. ` +
                      `New live entries blocked until persistence recovers. ` +
                      `Fault: ${this.persistenceFault}`,
                    userId,
                  );
                }

                // Send Telegram entry alert
                this.sendEntryAlert(user, newPos, symbol, {
                  strikePrice: selectedContract.strike,
                  expiry: optionChain[0]?.expiry,
                });
              } else if (
                orderRes.success &&
                (orderRes.status === "pending" || orderRes.status === "unknown")
              ) {
                // CR-02: submitted but NOT confirmed. The order may be at the
                // broker — do NOT create a position, do NOT increment counts,
                // do NOT block the symbol. Reconciliation (CR-04) or the next
                // tick's position check will handle the outcome. The order id
                // is retained in the error for operator follow-up.
                this.log(
                  "warn",
                  "entry",
                  `[${symbol}] Order submitted but UNCONFIRMED (broker order ${orderRes.brokerOrderId ?? "?"}) — no position created; will reconcile on the next evaluation`,
                  userId,
                );
                user.error = `Pending entry for ${symbol}: broker order ${orderRes.brokerOrderId ?? "?"} awaiting confirmation`;
                this.emitUserUpdate(user);
              } else {
                user.error = orderRes.error;
                this.log(
                  "error",
                  "entry",
                  `[${symbol}] Order failed: ${orderRes.error}`,
                  userId,
                );
                this.emitUserUpdate(user);
              }
            }
          }
        }
      }

      // After all symbols processed: check daily summary (after EOD, no positions)
      if (afterCutoff) {
        this.checkDailySummary(user, istInfo);
      }
    }
  }

  /**
   * Appends a line to the bot activity log. CR-18: pass userId for
   * user-scoped events (entries, exits, config) so the WS broadcast can
   * deliver them ONLY to that user's sockets; omit it for system-wide
   * events (stream, recovery, persistence) that every client may see.
   */
  private log(
    level: "info" | "warn" | "error" | "debug",
    source: string,
    msg: string,
    userId?: string,
  ): void {
    this.botLogs?.add(level, source, msg, userId);
  }

  /** Logs a line only when the evaluated entry signal for a symbol changes. */
  private trackSignalChange(
    symbol: UnderlyingSymbol,
    signal: string,
    confidence: string,
  ): void {
    const prev = this.lastSignalBySymbol.get(symbol);
    if (prev === signal) return;
    this.lastSignalBySymbol.set(symbol, signal);
    if (
      signal === "BUY_CE" ||
      signal === "BUY_PE" ||
      (prev && (prev === "BUY_CE" || prev === "BUY_PE"))
    ) {
      this.log("info", "signal", `[${symbol}] ${signal} (${confidence})`);
    }
  }

  private emitUserUpdate(user: UserBotState) {
    this.emit("userStateUpdate", { userId: user.userId, state: user });
  }
}
