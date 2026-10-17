import fastify from 'fastify'
import cors from '@fastify/cors'
import websocket from '@fastify/websocket'
import rateLimit from '@fastify/rate-limit'
import dotenv from 'dotenv'
import path from 'path'
import { MasterIngestionEngine } from './services/masterIngestor'
import { OrderGateway } from './services/orderGateway'
import { TenantManager } from './services/tenantManager'
import { StateStore } from './services/stateStore'
import { createTelegramNotifier } from './services/notifier'
import { botRoutes } from './routes/botRoutes'

dotenv.config()

export function buildServer(opts?: { mockMode?: boolean; primaryToken?: string; store?: StateStore | null }) {
  const app = fastify({
    logger: {
      level: process.env.LOG_LEVEL || 'info',
      transport:
        process.env.NODE_ENV !== 'production'
          ? {
              target: 'pino-pretty',
              options: {
                translateTime: 'HH:MM:ss Z',
                ignore: 'pid,hostname',
              },
            }
          : undefined,
    },
  })

  // Register Plugins
  app.register(cors, {
    origin: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  })

  app.register(rateLimit, {
    max: 200,
    timeWindow: '1 minute',
  })

  app.register(websocket)

  // Initialize Core Services
  const notifier = createTelegramNotifier()

  // Optional non-negative integer env knob: undefined when unset/blank/invalid.
  // 0 is meaningful for the WS tuning knobs below — it disables the feature.
  const optionalCountEnv = (name: string): number | undefined => {
    const raw = process.env[name]
    if (raw === undefined || raw.trim() === '') return undefined
    const parsed = Number(raw)
    return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : undefined
  }

  const masterIngestor = new MasterIngestionEngine({
    pollingIntervalMs: parseInt(process.env.POLLING_INTERVAL_MS || '2000', 10),
    upstoxApiBaseUrl: process.env.UPSTOX_API_URL || 'https://api.upstox.com/v2',
    primaryUpstoxToken: opts?.primaryToken || process.env.PRIMARY_UPSTOX_TOKEN,
    mockMode: opts?.mockMode ?? (process.env.NODE_ENV === 'test' || !process.env.PRIMARY_UPSTOX_TOKEN),
    liveSource: process.env.MARKET_FEED_SOURCE === 'ws' ? 'ws' : 'rest',
    optionChainRefreshMs: optionalCountEnv('OPTION_CHAIN_REFRESH_MS'),
    atmWindowStrikes: optionalCountEnv('ATM_WINDOW_STRIKES'),
    notifier,
  })

  masterIngestor.on('error', (err) => {
    app.log.error(err, 'Master Ingestion Engine error')
  })

  const orderGateway = new OrderGateway(
    process.env.UPSTOX_API_URL || 'https://api.upstox.com/v2',
    opts?.store ?? null,
  )
  const tenantManager = new TenantManager(masterIngestor, orderGateway, {
    store: opts?.store ?? null,
    notifier,
  })

  tenantManager.on('error', (err) => {
    app.log.error(err, 'Tenant Manager tick processing error')
  })

  // Register Bot Routes
  app.register(botRoutes, {
    masterIngestor,
    tenantManager,
    orderGateway,
  })

  // Health check route
  app.get('/health', async () => {
    return {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      memoryUsage: process.memoryUsage(),
      feed: masterIngestor.getFeedStats(),
    }
  })

  // Graceful shutdown hooks
  app.addHook('onClose', async () => {
    masterIngestor.stop()
    opts?.store?.close()
  })

  return { app, masterIngestor, tenantManager, orderGateway, notifier }
}

export const REQUIRED_ENV_VARS = ['PRIMARY_UPSTOX_TOKEN'] as const

export function validateEnvironment(env: Record<string, string | undefined> = process.env): {
  valid: boolean
  missing: string[]
} {
  const isMock = env.MOCK_MODE === 'true' || env.NODE_ENV === 'test'
  if (isMock) {
    return { valid: true, missing: [] }
  }

  const missing = REQUIRED_ENV_VARS.filter((key) => !env[key] || env[key]?.trim() === '')
  return {
    valid: missing.length === 0,
    missing: [...missing],
  }
}

// Start server if run directly
if (require.main === module) {
  const PORT = parseInt(process.env.PORT || '3000', 10)
  // Safety default: bind loopback unless explicitly overridden (e.g. behind a firewall / reverse proxy)
  const HOST = process.env.HOST || '127.0.0.1'

  // ── Required env validation ──────────────────────────────────────────────
  const { valid, missing } = validateEnvironment()

  if (!valid) {
    console.error(`\n❌ Fatal: Core service cannot start because required environment variable(s) are missing:\n`)
    for (const key of missing) {
      console.error(`   • ${key}`)
    }
    console.error(`\n   Please configure them in your .env file or environment before starting.\n`)
    process.exit(1)
  }

  const dataDir = path.resolve(process.env.DATA_DIR || 'data')
  const store = new StateStore(dataDir)
  const { app, masterIngestor, notifier } = buildServer({ store })

  app.listen({ port: PORT, host: HOST }, (err, address) => {
    if (err) {
      app.log.error(err)
      process.exit(1)
    }
    app.log.info(`⚡ Algo-Trade Fastify Daemon listening at ${address}`)
    app.log.info(`💾 State store active at ${dataDir}`)
    masterIngestor.start()
    app.log.info(`📡 Master Ingestion Engine started (Single 1-API fetch loop active)`)
    void notifier(
      `🟢 Algo-Trade daemon started at ${address} ` +
        `(mode: ${process.env.MOCK_MODE === 'true' ? 'MOCK' : 'live feed'}).`,
    )
  })

  // Process termination signals
  const shutdown = async () => {
    app.log.info('Shutting down gracefully...')
    // Best-effort stop alert with a bounded wait so shutdown never hangs
    await Promise.race([
      notifier('🔴 Algo-Trade daemon stopping (graceful shutdown).'),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ])
    await app.close()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
