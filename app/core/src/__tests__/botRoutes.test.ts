import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "../server";

describe("Fastify Bot Routes & API Suite", () => {
  let server: ReturnType<typeof buildServer>;

  beforeAll(async () => {
    // Route-behavior suite: build with auth disabled (server.ts loads .env
    // at module scope, which now carries a real DAEMON_API_KEY). Enforcement
    // has its own suite below.
    delete process.env.DAEMON_API_KEY;
    server = buildServer({ mockMode: true });
    await server.app.ready();
    await server.masterIngestor.fetchAndComputeMarketData();
  });

  afterAll(async () => {
    await server.app.close();
  });

  it("GET /health returns healthy status and memory usage", async () => {
    const res = await server.app.inject({
      method: "GET",
      url: "/health",
    });
    expect(res.statusCode).toBe(200);
    const json = JSON.parse(res.body);
    expect(json.status).toBe("healthy");
    expect(json.memoryUsage).toBeDefined();
  });

  it("GET /api/bot/status returns snapshots, user state, and paper trades", async () => {
    const res = await server.app.inject({
      method: "GET",
      url: "/api/bot/status?userId=test_trader",
    });
    expect(res.statusCode).toBe(200);
    const json = JSON.parse(res.body);
    expect(json.snapshots).toBeDefined();
    expect(json.snapshots["NIFTY 50"]).toBeDefined();
    expect(json.userState).toBeDefined();
    expect(json.userState.userId).toBe("test_trader");
    expect(Array.isArray(json.paperTrades)).toBe(true);
  });

  it("POST /api/bot/start arms the user bot", async () => {
    const res = await server.app.inject({
      method: "POST",
      url: "/api/bot/start",
      payload: { userId: "test_trader", executionMode: "paper" },
    });
    expect(res.statusCode).toBe(200);
    const json = JSON.parse(res.body);
    expect(json.success).toBe(true);
    expect(json.userState.state).toBe("RUNNING");
    expect(json.userState.executionMode).toBe("paper");
  });

  it("POST /api/bot/stop stops the user bot", async () => {
    const res = await server.app.inject({
      method: "POST",
      url: "/api/bot/stop",
      payload: { userId: "test_trader" },
    });
    expect(res.statusCode).toBe(200);
    const json = JSON.parse(res.body);
    expect(json.success).toBe(true);
    expect(json.userState.state).toBe("STOPPED");
  });

  it("POST /api/bot/config updates user strategy parameters", async () => {
    const res = await server.app.inject({
      method: "POST",
      url: "/api/bot/config",
      payload: {
        userId: "test_trader",
        config: { strongThreshold: 20, maxTradesPerDay: 8 },
      },
    });
    expect(res.statusCode).toBe(200);
    const json = JSON.parse(res.body);
    expect(json.success).toBe(true);
    expect(json.userState.config.strongThreshold).toBe(20);
    expect(json.userState.config.maxTradesPerDay).toBe(8);
  });

  it("POST /api/bot/paper-reset resets account balance", async () => {
    const res = await server.app.inject({
      method: "POST",
      url: "/api/bot/paper-reset",
      payload: { userId: "test_trader" },
    });
    expect(res.statusCode).toBe(200);
    const json = JSON.parse(res.body);
    expect(json.success).toBe(true);
    expect(json.balance).toBe(10000000);
  });

  describe("Environment Validation", () => {
    it("fails validation when required PRIMARY_UPSTOX_TOKEN is missing in production", async () => {
      const { validateEnvironment } = await import("../server");
      const result = validateEnvironment({ NODE_ENV: "production" });
      expect(result.valid).toBe(false);
      expect(result.missing).toContain("PRIMARY_UPSTOX_TOKEN");
    });

    it("fails validation when PRIMARY_UPSTOX_TOKEN is whitespace only", async () => {
      const { validateEnvironment } = await import("../server");
      const result = validateEnvironment({
        NODE_ENV: "production",
        PRIMARY_UPSTOX_TOKEN: "   ",
      });
      expect(result.valid).toBe(false);
      expect(result.missing).toContain("PRIMARY_UPSTOX_TOKEN");
    });

    it("passes validation when PRIMARY_UPSTOX_TOKEN is provided", async () => {
      const { validateEnvironment } = await import("../server");
      const result = validateEnvironment({
        NODE_ENV: "production",
        PRIMARY_UPSTOX_TOKEN: "valid_jwt_token",
      });
      expect(result.valid).toBe(true);
      expect(result.missing).toHaveLength(0);
    });

    it("bypasses validation in test or mock mode", async () => {
      const { validateEnvironment } = await import("../server");
      const resultTest = validateEnvironment({ NODE_ENV: "test" });
      expect(resultTest.valid).toBe(true);

      const resultMock = validateEnvironment({
        NODE_ENV: "development",
        MOCK_MODE: "true",
      });
      expect(resultMock.valid).toBe(true);
    });
  });
});

// ─── API key enforcement ─────────────────────────────────────────────────────

describe("Daemon API key enforcement", () => {
  it("rejects /api/* without the x-api-key header when DAEMON_API_KEY is set", async () => {
    process.env.DAEMON_API_KEY = "test-secret-key";
    const guarded = buildServer({ mockMode: true });
    await guarded.app.ready();

    const noKey = await guarded.app.inject({
      method: "GET",
      url: "/api/bot/status",
    });
    expect(noKey.statusCode).toBe(401);

    const badKey = await guarded.app.inject({
      method: "GET",
      url: "/api/bot/status",
      headers: { "x-api-key": "wrong" },
    });
    expect(badKey.statusCode).toBe(401);

    const goodKey = await guarded.app.inject({
      method: "GET",
      url: "/api/bot/status",
      headers: { "x-api-key": "test-secret-key" },
    });
    expect(goodKey.statusCode).toBe(200);

    // /health stays open (liveness probe)
    const health = await guarded.app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);

    // Writes are guarded too
    const stop = await guarded.app.inject({
      method: "POST",
      url: "/api/bot/stop",
      headers: { "x-api-key": "wrong" },
    });
    expect(stop.statusCode).toBe(401);

    await guarded.app.close();
    delete process.env.DAEMON_API_KEY;
  });

  it("is inert when DAEMON_API_KEY is unset (loopback-only mode)", async () => {
    const open = buildServer({ mockMode: true });
    await open.app.ready();
    const res = await open.app.inject({
      method: "GET",
      url: "/api/bot/status",
    });
    expect(res.statusCode).toBe(200);
    await open.app.close();
  });
});

// ─── INITIAL_STATE token-leak regression ─────────────────────────────────────

describe("WS INITIAL_STATE must not leak the Upstox token", () => {
  it("sanitizes userState in the initial sync payload", async () => {
    process.env.DAEMON_API_KEY = "ws-leak-test-key";
    const guarded = buildServer({ mockMode: true });
    await guarded.app.ready();

    // Plant a canary token on the user the WS will subscribe to
    guarded.tenantManager.setToken("leak_user", "CANARY-SECRET-TOKEN-xyz");

    await guarded.app.listen({ port: 0, host: "127.0.0.1" });
    const address = guarded.app.server.address() as { port: number };
    // CR-05: WS auth via a single-use ticket (keys never appear in URLs)
    const ticketRes = await guarded.app.inject({
      method: "POST",
      url: "/api/bot/ws-ticket",
      headers: { "x-api-key": "ws-leak-test-key" },
    });
    const { ticket } = JSON.parse(ticketRes.body) as { ticket: string };
    const url = `ws://127.0.0.1:${address.port}/ws?userId=leak_user&ticket=${ticket}`;

    await new Promise<void>((resolve, reject) => {
      const WebSocket = require("ws") as typeof import("ws");
      const ws = new WebSocket(url);
      const finish = () => {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        resolve();
      };
      ws.on("message", (raw: { toString(): string }) => {
        const body = raw.toString();
        // The canary must never appear in ANY WS payload
        if (body.includes("CANARY-SECRET-TOKEN-xyz")) {
          reject(new Error("INITIAL_STATE leaked the Upstox token"));
          return;
        }
        try {
          const msg = JSON.parse(body) as {
            type: string;
            data: { userState?: Record<string, unknown> };
          };
          if (msg.type === "INITIAL_STATE") {
            const userState = msg.data.userState;
            if (userState && "upstoxToken" in userState) {
              reject(new Error("userState contains an upstoxToken field"));
              return;
            }
            finish();
          }
        } catch {
          reject(new Error("non-JSON WS payload"));
        }
      });
      ws.on("error", () => reject(new Error("WS connection failed")));
      setTimeout(() => reject(new Error("INITIAL_STATE never arrived")), 5000);
    });

    await guarded.app.close();
    delete process.env.DAEMON_API_KEY;
  });
});
