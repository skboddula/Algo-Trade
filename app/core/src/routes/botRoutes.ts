import { randomUUID } from "crypto";
import type { FastifyPluginAsync } from "fastify";
import type { MasterIngestionEngine } from "../services/masterIngestor";
import type { TenantManager } from "../services/tenantManager";
import type { OrderGateway } from "../services/orderGateway";
import type { BotLogService, BotLog } from "../services/botLogService";
import type { UnderlyingSymbol, UserBotState } from "../types";
import { UNDERLYING_INSTRUMENT_KEYS } from "../types";
import { DEFAULT_INITIAL_PAPER_BALANCE } from "../constants";
import {
  fetchHistoricalCandles,
  getBacktestDefaults,
  runBacktest,
} from "../services/backtestEngine";
import type { WebSocket } from "ws";

/** Strip sensitive credentials before sending state to clients */
/**
 * CR-06: explicit ALLOWLIST DTO for user state sent to clients. Fields are
 * PICKED, never omitted-by-deletion — new UserBotState fields do not leak
 * into client payloads by default; they must be added here deliberately.
 */
export interface PublicUserState {
  userId: string;
  state: UserBotState["state"];
  executionMode: "paper" | "live";
  config: UserBotState["config"];
  positions: UserBotState["positions"];
  tradesCountToday: number;
  tradesCountPerSymbol: Record<string, number>;
  lastTradeDate: string;
  lastExitTimes: Record<string, number>;
  totalRealizedPnl: number;
  paperBalance: number;
  error?: string;
  updatedAt: string;
}

function sanitizeUserState(state: UserBotState): PublicUserState {
  return {
    userId: state.userId,
    state: state.state,
    executionMode: state.executionMode === "live" ? "live" : "paper",
    config: state.config,
    positions: state.positions,
    tradesCountToday: state.tradesCountToday ?? 0,
    tradesCountPerSymbol: state.tradesCountPerSymbol ?? {},
    lastTradeDate: state.lastTradeDate,
    lastExitTimes: state.lastExitTimes ?? {},
    totalRealizedPnl: state.totalRealizedPnl ?? 0,
    paperBalance: state.paperBalance ?? 0,
    error: state.error,
    updatedAt: state.updatedAt,
  };
}

export interface BotRoutesOptions {
  masterIngestor: MasterIngestionEngine;
  tenantManager: TenantManager;
  orderGateway: OrderGateway;
  botLogs: BotLogService;
}

export const botRoutes: FastifyPluginAsync<BotRoutesOptions> = async (
  fastify,
  opts,
) => {
  const { masterIngestor, tenantManager, orderGateway, botLogs } = opts;

  // Connected WebSocket clients: Map<userId, Set<WebSocket>>
  const activeSockets = new Map<string, Set<WebSocket>>();

  // ── CR-05: one-time WS tickets — long-lived API keys never appear in
  // URLs (which leak into logs/proxy histories). A client POSTs
  // /api/bot/ws-ticket (header-authenticated) and connects with the
  // returned short-lived, single-use ticket.
  const wsTickets = new Map<string, { expiresAt: number }>();
  const WS_TICKET_TTL_MS = 30_000;
  function issueWsTicket(): string {
    // Prune expired tickets (bounded map)
    const now = Date.now();
    for (const [t, entry] of wsTickets.entries()) {
      if (entry.expiresAt <= now) wsTickets.delete(t);
    }
    const ticket = randomUUID();
    wsTickets.set(ticket, { expiresAt: now + WS_TICKET_TTL_MS });
    return ticket;
  }
  function consumeWsTicket(ticket: string | undefined): boolean {
    if (!ticket) return false;
    const entry = wsTickets.get(ticket);
    if (!entry) return false;
    wsTickets.delete(ticket); // single-use
    return entry.expiresAt > Date.now();
  }

  // Periodic heartbeat every 30s to purge dead sockets
  const heartbeatInterval = setInterval(() => {
    for (const [userId, sockets] of activeSockets.entries()) {
      for (const ws of sockets) {
        if (ws.readyState === 1 /* OPEN */) {
          ws.ping();
        } else if (
          ws.readyState === 3 /* CLOSED */ ||
          ws.readyState === 2 /* CLOSING */
        ) {
          sockets.delete(ws);
        }
      }
      if (sockets.size === 0) {
        activeSockets.delete(userId);
      }
    }
  }, 30000);

  fastify.addHook("onClose", async () => {
    clearInterval(heartbeatInterval);
    for (const sockets of activeSockets.values()) {
      for (const ws of sockets) {
        try {
          ws.close();
        } catch {
          // Ignore close errors on shutdown
        }
      }
    }
    activeSockets.clear();
  });

  // Broadcast market ticks to all connected sockets
  masterIngestor.on("marketTick", (tick) => {
    const payload = JSON.stringify({ type: "MARKET_TICK", data: tick });
    for (const sockets of activeSockets.values()) {
      for (const ws of sockets) {
        if (ws.readyState === 1 /* OPEN */) {
          try {
            ws.send(payload);
          } catch {
            sockets.delete(ws);
          }
        }
      }
    }
  });

  // Broadcast individual user state updates to their specific sockets
  tenantManager.on("userStateUpdate", ({ userId, state }) => {
    const sockets = activeSockets.get(userId);
    if (sockets) {
      const payload = JSON.stringify({
        type: "USER_STATE_UPDATE",
        // Sanitized like the REST /status response — never leak upstoxToken
        data: sanitizeUserState(state),
      });
      for (const ws of sockets) {
        if (ws.readyState === 1 /* OPEN */) {
          try {
            ws.send(payload);
          } catch {
            sockets.delete(ws);
          }
        }
      }
    }
  });

  // ── GET /api/bot/status ────────────────────────────────────────────────────
  fastify.get("/api/bot/status", async (request, reply) => {
    const query = request.query as { userId?: string };
    const userId = query.userId;
    if (!userId) {
      return reply.status(400).send({
        error: "userId is required — the implicit default_user fallback was removed",
      });
    }
    const snapshots = masterIngestor.getAllSnapshots();
    const userState = tenantManager.getOrCreateUser(userId);
    const paperTrades = orderGateway.getPaperTrades(userId);

    return reply.send({
      serverTime: new Date().toISOString(),
      snapshots,
      userState: sanitizeUserState(userState),
      paperTrades,
      recovery: tenantManager.getRecoveryStatus(),
      persistenceFault: tenantManager.getPersistenceFault(),
      // Boolean only — the token itself never leaves the daemon.
      hasToken: Boolean(masterIngestor.getPrimaryToken()),
    });
  });

  // ── CR-17: runtime validation schemas (TypeScript casts are not
  // runtime validation — malformed bodies must fail with 400s, not casts)
  const START_SCHEMA = {
    type: "object",
    additionalProperties: false,
    properties: {
      userId: { type: "string", minLength: 1, maxLength: 64 },
      executionMode: { type: "string", enum: ["paper", "live"] },
    },
  } as const;
  const USER_ID_SCHEMA = {
    type: "object",
    additionalProperties: false,
    properties: { userId: { type: "string", minLength: 1, maxLength: 64 } },
  } as const;
  const CONFIG_SCHEMA = {
    type: "object",
    required: ["config"],
    additionalProperties: false,
    properties: {
      userId: { type: "string", minLength: 1, maxLength: 64 },
      config: {
        type: "object",
        additionalProperties: true, // strategy config is a partial merge
        properties: {
          strongThreshold: { type: "number", minimum: 1, maximum: 100 },
          moderateThreshold: { type: "number", minimum: 1, maximum: 100 },
          maxProfitPct: { type: "number", minimum: 0.1, maximum: 100 },
          maxLossPct: { type: "number", minimum: 0.1, maximum: 100 },
          trailPct: { type: "number", minimum: 0.1, maximum: 50 },
          maxTradesPerDay: { type: "integer", minimum: 1, maximum: 50 },
          maxTotalTradesPerDay: { type: "integer", minimum: 1, maximum: 150 },
          otmSkip: { type: "integer", minimum: 0, maximum: 10 },
          exitCooldownSec: { type: "integer", minimum: 0, maximum: 3600 },
          minConfidence: { type: "string", enum: ["strong", "moderate"] },
          executionMode: { type: "string", enum: ["paper", "live"] },
          tradeType: { type: "string", enum: ["buying", "selling"] },
          underlyingMode: { type: "string" },
        },
      },
    },
  } as const;
  const TOKEN_SCHEMA = {
    type: "object",
    required: ["token"],
    additionalProperties: false,
    properties: {
      userId: { type: "string", minLength: 1, maxLength: 64 },
      token: { type: "string", minLength: 10, maxLength: 4096 },
    },
  } as const;
  const TRADE_EXIT_SCHEMA = {
    type: "object",
    additionalProperties: false,
    properties: {
      userId: { type: "string", minLength: 1, maxLength: 64 },
      symbol: { type: "string", enum: ["NIFTY 50", "BANKNIFTY", "FINNIFTY"] },
      reason: { type: "string", maxLength: 200 },
    },
  } as const;

  // ── POST /api/bot/start ────────────────────────────────────────────────────
  fastify.post(
    "/api/bot/start",
    { schema: { body: START_SCHEMA } },
    async (request, reply) => {
      const body = request.body as {
        userId?: string;
        executionMode?: "paper" | "live";
      } | null;
      const userId = body?.userId;
    if (!userId) {
      return reply.status(400).send({
        error: "userId is required — the implicit default_user fallback was removed",
      });
    }
      try {
        const userState = tenantManager.startBot(userId, body?.executionMode);
        return reply.send({
          success: true,
          userState: sanitizeUserState(userState),
        });
      } catch (err) {
        // CR-08: live-trading arming / recovery / persistence rejections
        return reply.code(403).send({ error: (err as Error).message });
      }
    },
  );

  // ── POST /api/bot/stop ─────────────────────────────────────────────────────
  fastify.post(
    "/api/bot/stop",
    { schema: { body: USER_ID_SCHEMA } },
    async (request, reply) => {
      const body = request.body as { userId?: string } | null;
      const userId = body?.userId;
    if (!userId) {
      return reply.status(400).send({
        error: "userId is required — the implicit default_user fallback was removed",
      });
    }
      const userState = tenantManager.stopBot(userId);
      return reply.send({
        success: true,
        userState: sanitizeUserState(userState),
      });
    },
  );

  // ── POST /api/bot/config ───────────────────────────────────────────────────
  fastify.post(
    "/api/bot/config",
    { schema: { body: CONFIG_SCHEMA } },
    async (request, reply) => {
      const body = request.body as { userId?: string; config: any } | null;
      const userId = body?.userId;
    if (!userId) {
      return reply.status(400).send({
        error: "userId is required — the implicit default_user fallback was removed",
      });
    }
      if (!body?.config) {
        return reply.status(400).send({ error: "Missing config payload" });
      }
      const userState = tenantManager.updateConfig(userId, body.config);
      return reply.send({
        success: true,
        userState: sanitizeUserState(userState),
      });
    },
  );

  // ── POST /api/bot/token ────────────────────────────────────────────────────
  fastify.post(
    "/api/bot/token",
    { schema: { body: TOKEN_SCHEMA } },
    async (request, reply) => {
      const body = request.body as { userId?: string; token: string } | null;
      const userId = body?.userId;
    if (!userId) {
      return reply.status(400).send({
        error: "userId is required — the implicit default_user fallback was removed",
      });
    }
      if (!body?.token) {
        return reply.status(400).send({ error: "Missing token" });
      }
      // Update BOTH token surfaces:
      //  - masterIngestor: the primary token driving ALL market data
      //    (quotes, candles, chains, VIX, sentiment) — the daily expiry
      //    would otherwise silently kill data feeds tomorrow morning.
      //  - tenant user: the per-user token for live order placement.
      masterIngestor.setToken(body.token);
      const userState = tenantManager.setToken(userId, body.token);
      return reply.send({
        success: true,
        userState: sanitizeUserState(userState),
      });
    },
  );

  // ── POST /api/bot/paper-reset ──────────────────────────────────────────────
  fastify.post("/api/bot/paper-reset", async (request, reply) => {
    const body = request.body as { userId?: string } | null;
    const userId = body?.userId;
    if (!userId) {
      return reply.status(400).send({
        error: "userId is required — the implicit default_user fallback was removed",
      });
    }
    const account = orderGateway.resetPaperAccount(userId);
    const userState = tenantManager.getOrCreateUser(userId);
    return reply.send({
      success: true,
      balance: account.balance,
      userState: sanitizeUserState(userState),
    });
  });

  // ── POST /api/bot/account/adjust ──────────────────────────────────────────
  // Manual capital adjustment — unified with the browser reference
  // (worker/paperTrading.ts handlePaperAccountAdjust): amount in RUPEES,
  // mode 'set' (absolute, default) or 'adjust' (relative delta).
  const ACCOUNT_ADJUST_SCHEMA = {
    type: "object",
    required: ["userId", "amount"],
    properties: {
      userId: { type: "string", minLength: 1, maxLength: 64 },
      amount: { type: "number" },
      mode: { type: "string", enum: ["set", "adjust"] },
      note: { type: "string", maxLength: 200 },
    },
  } as const;
  fastify.post(
    "/api/bot/account/adjust",
    { schema: { body: ACCOUNT_ADJUST_SCHEMA } },
    async (request, reply) => {
      const body = request.body as {
        userId: string;
        amount: number;
        mode?: "set" | "adjust";
        note?: string;
      };
      const amountPaise = Math.round(body.amount * 100);
      if (amountPaise === 0 && body.mode !== "set") {
        return reply
          .status(400)
          .send({ error: "Adjustment amount cannot be zero" });
      }
      try {
        const { account } = orderGateway.adjustPaperAccount(
          body.userId,
          amountPaise,
          body.mode ?? "set",
          body.note,
        );
        const userState = tenantManager.syncPaperBalance(body.userId);
        return reply.send({
          success: true,
          balance: account.balance,
          startingBalance: account.startingBalance,
          userState: sanitizeUserState(userState),
        });
      } catch (error) {
        return reply.status(400).send({ error: (error as Error).message });
      }
    },
  );

  // ── GET /api/bot/equity-curve ─────────────────────────────────────────────
  // Returns trade history formatted for charting: running balance over time
  fastify.get("/api/bot/equity-curve", async (request, reply) => {
    const query = request.query as { userId?: string };
    const userId = query.userId;
    if (!userId) {
      return reply.status(400).send({
        error: "userId is required — the implicit default_user fallback was removed",
      });
    }
    const account = orderGateway.getOrCreatePaperAccount(userId);
    const trades = orderGateway.getPaperTrades(userId);

    // Filter to CLOSED trades, sorted chronologically
    const closed = trades
      .filter((t) => t.status === "CLOSED" && t.closedAt)
      .sort(
        (a, b) =>
          new Date(a.closedAt!).getTime() - new Date(b.closedAt!).getTime(),
      );

    if (closed.length === 0) {
      return reply.send({
        points: [],
        stats: {
          totalTrades: 0,
          wins: 0,
          losses: 0,
          realizedPnl: 0,
          balance: account.balance,
        },
      });
    }

    // Reconstruct starting balance: current balance minus all realized P&L
    const totalRealizedPnl = closed.reduce(
      (s, t) => s + (t.realizedPnl ?? 0),
      0,
    );
    // CR-20: the account's own startingBalance is authoritative (it
    // survives resets and adjustments); the default is only a fallback
    // for accounts created before the field existed.
    const startBalance =
      account.startingBalance ?? DEFAULT_INITIAL_PAPER_BALANCE;

    let running = startBalance;
    let peak = startBalance;
    let maxDrawdownPct = 0;
    let wins = 0;
    let losses = 0;

    const points = [{ time: "Start", balance: startBalance, pnl: 0 }];
    for (const t of closed) {
      const pnl = t.realizedPnl ?? 0;
      running += pnl;
      peak = Math.max(peak, running);
      const dd = peak > 0 ? ((peak - running) / peak) * 100 : 0;
      maxDrawdownPct = Math.max(maxDrawdownPct, dd);
      if (pnl > 0) wins++;
      else losses++;
      points.push({
        time: t.closedAt!,
        balance: running,
        pnl,
      });
    }

    return reply.send({
      points,
      stats: {
        startBalance,
        currentBalance: account.balance,
        totalTrades: closed.length,
        wins,
        losses,
        winRatePct:
          closed.length > 0
            ? Math.round((wins / closed.length) * 1000) / 10
            : 0,
        realizedPnl: totalRealizedPnl,
        roiPct:
          startBalance > 0
            ? Math.round((totalRealizedPnl / startBalance) * 10000) / 100
            : 0,
        maxDrawdownPct: Math.round(maxDrawdownPct * 100) / 100,
      },
    });
  });

  // ── GET /api/bot/stream-health ─────────────────────────────────────────────
  // Returns the current WebSocket market stream status
  fastify.get("/api/bot/stream-health", async (_request, reply) => {
    const health = tenantManager.getStreamHealth();
    return reply.send(health);
  });

  // ── GET /api/bot/signals ───────────────────────────────────────────────────
  // Returns recent signal evaluations from the master ingestor snapshots
  fastify.get("/api/bot/signals", async (request, reply) => {
    const query = request.query as { limit?: string };
    const limit = Math.min(parseInt(query.limit || "50", 10) || 50, 200);
    const snapshots = masterIngestor.getAllSnapshots();
    const signals: Array<{
      symbol: string;
      signal: string;
      confidence: string;
      bullScore: number;
      bearScore: number;
      timestamp: string;
    }> = [];

    for (const [symbol, snapshot] of Object.entries(snapshots)) {
      if (snapshot?.signal) {
        signals.push({
          symbol,
          signal: snapshot.signal.signal,
          confidence: snapshot.signal.confidence,
          bullScore: snapshot.signal.bullScore,
          bearScore: snapshot.signal.bearScore,
          timestamp: snapshot.timestamp,
        });
      }
    }

    return reply.send({
      count: signals.length,
      signals: signals.slice(0, limit),
    });
  });

  // ── POST /api/bot/trade/exit ───────────────────────────────────────────────
  fastify.post(
    "/api/bot/trade/exit",
    { schema: { body: TRADE_EXIT_SCHEMA } },
    async (request, reply) => {
      const body = request.body as {
        userId?: string;
        symbol: UnderlyingSymbol;
        reason?: string;
      } | null;
      const userId = body?.userId;
    if (!userId) {
      return reply.status(400).send({
        error: "userId is required — the implicit default_user fallback was removed",
      });
    }
      if (!body?.symbol) {
        return reply.status(400).send({ error: "Missing symbol" });
      }
      const userState = await tenantManager.manualExit(
        userId,
        body.symbol,
        body.reason || "Manual Web Exit",
      );
      return reply.send({
        success: true,
        userState: sanitizeUserState(userState),
      });
    },
  );

  // ── POST /api/bot/backtest ────────────────────────────────────────────────
  // Runs the strategy against real historical 1-minute candles. Read-only:
  // never places orders, never touches bot state, never sends alerts.
  fastify.post("/api/bot/backtest", async (request, reply) => {
    const body = (request.body ?? {}) as {
      symbol?: UnderlyingSymbol;
      fromDate?: string; // YYYY-MM-DD
      toDate?: string; // YYYY-MM-DD
      token?: string; // optional per-request token; falls back to primary
      avgOptionPremium?: number;
      deltaLeverage?: number;
      lotSize?: number;
      startingBalance?: number;
      strategy?: Record<string, unknown>;
    };

    const symbol = body.symbol || "NIFTY 50";
    const instrumentKey = UNDERLYING_INSTRUMENT_KEYS[symbol];
    if (!instrumentKey) {
      return reply
        .status(400)
        .send({ error: `Unknown symbol: ${String(symbol)}` });
    }
    if (!body.fromDate || !body.toDate) {
      return reply
        .status(400)
        .send({ error: "Missing fromDate or toDate (YYYY-MM-DD)" });
    }

    const token = body.token || masterIngestor.getPrimaryToken();
    if (!token) {
      return reply
        .status(400)
        .send({ error: "No Upstox token available for backtest" });
    }

    const defaults = getBacktestDefaults(symbol);
    try {
      const candles = await fetchHistoricalCandles(
        token,
        instrumentKey,
        body.fromDate,
        body.toDate,
      );
      if (!candles.length) {
        return reply
          .status(502)
          .send({ error: "No candles returned for the requested range" });
      }

      const result = runBacktest(candles, {
        symbol,
        instrumentKey,
        fromDate: body.fromDate,
        toDate: body.toDate,
        token,
        strategy: {
          strongThreshold: 14,
          moderateThreshold: 10,
          strongGap: 6,
          moderateGap: 3,
          minConfidence: "moderate",
          maxProfitPct: 20,
          maxLossPct: 15,
          trailPct: 5,
          otmSkip: 0,
          lastEntryTime: "15:15",
          executionMode: "paper",
          tradeType: "buying",
          underlyingMode: symbol,
          ...(body.strategy ?? {}),
        } as never,
        avgOptionPremium: body.avgOptionPremium ?? defaults.premium,
        deltaLeverage: body.deltaLeverage ?? defaults.leverage,
        lotSize: body.lotSize ?? defaults.lotSize,
        startingBalance: body.startingBalance ?? 100000,
      });

      // Trim heavy payloads for API responses
      return reply.send({
        ...result,
        trades: result.trades.slice(-50),
        signalLog: result.signalLog.slice(-50),
      });
    } catch (err) {
      return reply.status(502).send({
        error: `Backtest failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });

  // ── POST /api/bot/ws-ticket ──────────────────────────────────────────────
  // Header-authenticated exchange: returns a single-use, 30-second ticket
  // for the WebSocket handshake so the API key never appears in a URL.
  fastify.post("/api/bot/ws-ticket", async (_request, reply) => {
    const ticket = issueWsTicket();
    return reply.send({ ticket, expiresAt: Date.now() + WS_TICKET_TTL_MS });
  });

  // ── GET /api/bot/statements ────────────────────────────────────────────────
  // Broker-style paper account ledger (entries, exits, balance walk).
  fastify.get("/api/bot/statements", async (request, reply) => {
    const query = request.query as { userId?: string; limit?: string };
    const userId = query.userId;
    if (!userId) {
      return reply.status(400).send({
        error: "userId is required — the implicit default_user fallback was removed",
      });
    }
    const limit = Math.min(parseInt(query.limit || "50", 10) || 50, 200);
    return reply.send({
      statements: orderGateway.getStatements(userId, limit),
    });
  });

  // ── GET /api/bot/logs ───────────────────────────────────────────────────────
  // Recent bot activity lines (bounded ring buffer, oldest first).
  fastify.get("/api/bot/logs", async (request, reply) => {
    const query = request.query as { limit?: string };
    const limit = Math.min(parseInt(query.limit || "200", 10) || 200, 500);
    return reply.send({ logs: botLogs.get(limit) });
  });

  // CR-18: user-SCOPED log delivery — a line tagged with a userId goes
  // ONLY to that user's sockets (one user must never receive another
  // user's trade activity). System-wide lines (no userId) go to everyone.
  botLogs.on("log", (line: BotLog) => {
    const payload = JSON.stringify({ type: "BOT_LOG", data: line });
    const targets = line.userId
      ? [activeSockets.get(line.userId)]
      : Array.from(activeSockets.values());
    for (const sockets of targets) {
      if (!sockets) continue;
      for (const ws of sockets) {
        if (ws.readyState === 1 /* OPEN */) {
          try {
            ws.send(payload);
          } catch {
            // Ignore send errors — heartbeat purges dead sockets
          }
        }
      }
    }
  });

  // ── WebSocket /ws ──────────────────────────────────────────────────────────
  fastify.get("/ws", { websocket: true }, (connection, req) => {
    const query = req.query as { userId?: string; ticket?: string };
    if (!query.userId) {
      const ws = (connection as any).socket || connection;
      try {
        ws.close(4008, "userId required");
      } catch {
        // socket may be gone
      }
      return;
    }
    const userId = query.userId;
    const ws = (connection as any).socket || connection;

    // Handshake auth (CR-05): browsers cannot set WebSocket headers, so the
    // client first POSTs /api/bot/ws-ticket (header-authenticated) and
    // connects with the single-use, short-lived ?ticket=. The long-lived API
    // key never appears in a URL. WebSocket connections are NOT covered by
    // CORS — this is the cross-site-control guard.
    const expectedKey = process.env.DAEMON_API_KEY?.trim();
    const authorized = expectedKey ? consumeWsTicket(query.ticket) : true; // loopback dev without a configured key
    if (!authorized) {
      try {
        ws.close(4001, "unauthorized");
      } catch {
        // Socket may already be gone
      }
      return;
    }

    if (!activeSockets.has(userId)) {
      activeSockets.set(userId, new Set());
    }
    activeSockets.get(userId)!.add(ws);

    // Send immediate initial sync — SANITIZED exactly like the REST status
    // response and the USER_STATE_UPDATE broadcasts: the raw UserBotState
    // carries the user's Upstox token and must never leave the daemon.
    const initialSnapshots = masterIngestor.getAllSnapshots();
    const userState = tenantManager.getOrCreateUser(userId);
    ws.send(
      JSON.stringify({
        type: "INITIAL_STATE",
        data: {
          snapshots: initialSnapshots,
          userState: sanitizeUserState(userState),
        },
      }),
    );

    ws.on("close", () => {
      const set = activeSockets.get(userId);
      if (set) {
        set.delete(ws);
        if (set.size === 0) activeSockets.delete(userId);
      }
    });

    ws.on("error", () => {
      const set = activeSockets.get(userId);
      if (set) {
        set.delete(ws);
        if (set.size === 0) activeSockets.delete(userId);
      }
    });

    ws.on("message", async (raw: any) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.action === "START") {
          tenantManager.startBot(userId, msg.executionMode);
        } else if (msg.action === "STOP") {
          tenantManager.stopBot(userId);
        } else if (msg.action === "CONFIG") {
          tenantManager.updateConfig(userId, msg.config);
        }
      } catch {
        // Ignore malformed messages
      }
    });
  });
};
