import type { FastifyPluginAsync } from "fastify";
import type { MasterIngestionEngine } from "../services/masterIngestor";
import type { TenantManager } from "../services/tenantManager";
import type { OrderGateway } from "../services/orderGateway";
import type { BotLogService, BotLog } from "../services/botLogService";
import type { UnderlyingSymbol, UserBotState } from "../types";
import { UNDERLYING_INSTRUMENT_KEYS } from "../types";
import {
  fetchHistoricalCandles,
  getBacktestDefaults,
  runBacktest,
} from "../services/backtestEngine";
import type { WebSocket } from "ws";

/** Strip sensitive credentials before sending state to clients */
function sanitizeUserState(
  state: UserBotState,
): Omit<UserBotState, "upstoxToken"> {
  const { upstoxToken: _token, ...safe } = state;
  return safe;
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
    const userId = query.userId || "default_user";
    const snapshots = masterIngestor.getAllSnapshots();
    const userState = tenantManager.getOrCreateUser(userId);
    const paperTrades = orderGateway.getPaperTrades(userId);

    return reply.send({
      serverTime: new Date().toISOString(),
      snapshots,
      userState: sanitizeUserState(userState),
      paperTrades,
    });
  });

  // ── POST /api/bot/start ────────────────────────────────────────────────────
  fastify.post("/api/bot/start", async (request, reply) => {
    const body = request.body as {
      userId?: string;
      executionMode?: "paper" | "live";
    } | null;
    const userId = body?.userId || "default_user";
    const userState = tenantManager.startBot(userId, body?.executionMode);
    return reply.send({
      success: true,
      userState: sanitizeUserState(userState),
    });
  });

  // ── POST /api/bot/stop ─────────────────────────────────────────────────────
  fastify.post("/api/bot/stop", async (request, reply) => {
    const body = request.body as { userId?: string } | null;
    const userId = body?.userId || "default_user";
    const userState = tenantManager.stopBot(userId);
    return reply.send({
      success: true,
      userState: sanitizeUserState(userState),
    });
  });

  // ── POST /api/bot/config ───────────────────────────────────────────────────
  fastify.post("/api/bot/config", async (request, reply) => {
    const body = request.body as { userId?: string; config: any } | null;
    const userId = body?.userId || "default_user";
    if (!body?.config) {
      return reply.status(400).send({ error: "Missing config payload" });
    }
    const userState = tenantManager.updateConfig(userId, body.config);
    return reply.send({
      success: true,
      userState: sanitizeUserState(userState),
    });
  });

  // ── POST /api/bot/token ────────────────────────────────────────────────────
  fastify.post("/api/bot/token", async (request, reply) => {
    const body = request.body as { userId?: string; token: string } | null;
    const userId = body?.userId || "default_user";
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
  });

  // ── POST /api/bot/paper-reset ──────────────────────────────────────────────
  fastify.post("/api/bot/paper-reset", async (request, reply) => {
    const body = request.body as { userId?: string } | null;
    const userId = body?.userId || "default_user";
    const account = orderGateway.resetPaperAccount(userId);
    const userState = tenantManager.getOrCreateUser(userId);
    return reply.send({
      success: true,
      balance: account.balance,
      userState: sanitizeUserState(userState),
    });
  });

  // ── GET /api/bot/equity-curve ─────────────────────────────────────────────
  // Returns trade history formatted for charting: running balance over time
  fastify.get("/api/bot/equity-curve", async (request, reply) => {
    const query = request.query as { userId?: string };
    const userId = query.userId || "default_user";
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
    const startBalance = account.balance - totalRealizedPnl;

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
  fastify.post("/api/bot/trade/exit", async (request, reply) => {
    const body = request.body as {
      userId?: string;
      symbol: UnderlyingSymbol;
      reason?: string;
    } | null;
    const userId = body?.userId || "default_user";
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
  });

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
      return reply
        .status(502)
        .send({
          error: `Backtest failed: ${err instanceof Error ? err.message : String(err)}`,
        });
    }
  });

  // ── GET /api/bot/logs ───────────────────────────────────────────────────────
  // Recent bot activity lines (bounded ring buffer, oldest first).
  fastify.get("/api/bot/logs", async (request, reply) => {
    const query = request.query as { limit?: string };
    const limit = Math.min(parseInt(query.limit || "200", 10) || 200, 500);
    return reply.send({ logs: botLogs.get(limit) });
  });

  // Broadcast every bot log line to ALL connected dashboards
  botLogs.on("log", (line: BotLog) => {
    const payload = JSON.stringify({ type: "BOT_LOG", data: line });
    for (const sockets of activeSockets.values()) {
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
    const query = req.query as { userId?: string };
    const userId = query.userId || "default_user";
    const ws = (connection as any).socket || connection;

    if (!activeSockets.has(userId)) {
      activeSockets.set(userId, new Set());
    }
    activeSockets.get(userId)!.add(ws);

    // Send immediate initial sync
    const initialSnapshots = masterIngestor.getAllSnapshots();
    const userState = tenantManager.getOrCreateUser(userId);
    ws.send(
      JSON.stringify({
        type: "INITIAL_STATE",
        data: { snapshots: initialSnapshots, userState },
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
