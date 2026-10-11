import fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import rateLimit from "@fastify/rate-limit";
import dotenv from "dotenv";
import { MasterIngestionEngine } from "./services/masterIngestor";
import { OrderGateway } from "./services/orderGateway";
import { TenantManager } from "./services/tenantManager";
import { BotLogService } from "./services/botLogService";
import { botRoutes } from "./routes/botRoutes";

dotenv.config();

export function buildServer(opts?: {
  mockMode?: boolean;
  primaryToken?: string;
}) {
  const app = fastify({
    logger: {
      level: process.env.LOG_LEVEL || "info",
      transport:
        process.env.NODE_ENV !== "production"
          ? {
              target: "pino-pretty",
              options: {
                translateTime: "HH:MM:ss Z",
                ignore: "pid,hostname",
              },
            }
          : undefined,
    },
  });

  // Register Plugins
  const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(",").map((o) =>
    o.trim(),
  ) ?? [
    "http://localhost:5173",
    "http://localhost:3000",
    "http://127.0.0.1:5173",
  ];

  app.register(cors, {
    origin: (origin, cb) => {
      if (!origin || allowedOrigins.includes(origin)) {
        cb(null, true);
      } else {
        cb(new Error("Origin not allowed"), false);
      }
    },
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    credentials: true,
  });

  app.register(rateLimit, {
    max: 200,
    timeWindow: "1 minute",
  });

  app.register(websocket);

  // ─── API key guard ──────────────────────────────────────────────────────
  // Enforced on all /api/* routes when DAEMON_API_KEY is configured. The
  // /health liveness probe and the /ws handshake (browsers cannot set
  // WebSocket headers; the key arrives as ?apiKey= and is checked inside
  // the route handler) are exempt from the header check.
  const apiKey = process.env.DAEMON_API_KEY?.trim();
  if (apiKey) {
    app.addHook("onRequest", async (request, reply) => {
      const path = (request.raw.url || "").split("?")[0];
      if (path === "/health" || path === "/ws" || !path.startsWith("/api/")) {
        return;
      }
      if (request.headers["x-api-key"] !== apiKey) {
        return reply
          .code(401)
          .send({ error: "Unauthorized: missing or invalid x-api-key header" });
      }
    });
  }

  // Initialize Core Services
  const masterIngestor = new MasterIngestionEngine({
    pollingIntervalMs: parseInt(process.env.POLLING_INTERVAL_MS || "2000", 10),
    primaryUpstoxToken: opts?.primaryToken || process.env.PRIMARY_UPSTOX_TOKEN,
    mockMode:
      opts?.mockMode ??
      (process.env.NODE_ENV === "test" || !process.env.PRIMARY_UPSTOX_TOKEN),
  });

  masterIngestor.on("error", (err) => {
    app.log.error(err, "Master Ingestion Engine error");
  });

  const orderGateway = new OrderGateway(
    process.env.UPSTOX_API_URL || "https://api.upstox.com/v2",
  );
  const botLogs = new BotLogService();
  const tenantManager = new TenantManager(
    masterIngestor,
    orderGateway,
    botLogs,
  );

  tenantManager.on("error", (err) => {
    app.log.error(err, "Tenant Manager tick processing error");
  });

  // Register Bot Routes
  app.register(botRoutes, {
    masterIngestor,
    tenantManager,
    orderGateway,
    botLogs,
  });

  // Health check route
  app.get("/health", async () => {
    return {
      status: "healthy",
      timestamp: new Date().toISOString(),
      memoryUsage: process.memoryUsage(),
    };
  });

  // Graceful shutdown hooks
  app.addHook("onClose", async () => {
    masterIngestor.stop();
    tenantManager.shutdown();
    botLogs.flush();
  });

  return { app, masterIngestor, tenantManager, orderGateway };
}

export const REQUIRED_ENV_VARS = ["PRIMARY_UPSTOX_TOKEN"] as const;

export function validateEnvironment(
  env: Record<string, string | undefined> = process.env,
): {
  valid: boolean;
  missing: string[];
} {
  const isMock = env.MOCK_MODE === "true" || env.NODE_ENV === "test";
  if (isMock) {
    return { valid: true, missing: [] };
  }

  const missing = REQUIRED_ENV_VARS.filter(
    (key) => !env[key] || env[key]?.trim() === "",
  );
  return {
    valid: missing.length === 0,
    missing: [...missing],
  };
}

/** Non-loopback binds require an API key — fail closed, never open. */
function isLoopboundSafe(isLoopback: boolean, apiKey?: string): boolean {
  if (isLoopback) return true;
  return Boolean(apiKey && apiKey.trim().length > 0);
}

// Start server if run directly
if (require.main === module) {
  const PORT = parseInt(process.env.PORT || "3000", 10);
  // Fail-safe default: loopback only. Network exposure requires an explicit
  // HOST override AND a configured DAEMON_API_KEY (guard below).
  const HOST = process.env.HOST || "127.0.0.1";

  const isLoopback = ["127.0.0.1", "localhost", "::1"].includes(HOST);
  if (!isLoopboundSafe(isLoopback, process.env.DAEMON_API_KEY)) {
    console.error(
      `\n❌ Fatal: refusing to bind ${HOST} without DAEMON_API_KEY configured.\n` +
        `   An unauthenticated trading daemon on a network interface lets anyone\n` +
        `   start/stop the bot, inject tokens, and force-close positions.\n` +
        `   Set HOST=127.0.0.1, or set DAEMON_API_KEY in .env.\n`,
    );
    process.exit(1);
  }

  // ── Required env validation ──────────────────────────────────────────────
  const { valid, missing } = validateEnvironment();

  if (!valid) {
    console.error(
      `\n❌ Fatal: Core service cannot start because required environment variable(s) are missing:\n`,
    );
    for (const key of missing) {
      console.error(`   • ${key}`);
    }
    console.error(
      `\n   Please configure them in your .env file or environment before starting.\n`,
    );
    process.exit(1);
  }

  const { app, masterIngestor } = buildServer();

  app.listen({ port: PORT, host: HOST }, (err, address) => {
    if (err) {
      app.log.error(err);
      process.exit(1);
    }
    app.log.info(`⚡ Algo-Trade Fastify Daemon listening at ${address}`);
    masterIngestor.start();
    app.log.info(
      `📡 Master Ingestion Engine started (Single 1-API fetch loop active)`,
    );
  });

  // Process termination signals
  const shutdown = async () => {
    app.log.info("Shutting down gracefully...");
    await app.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
