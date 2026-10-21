import type { FastifyPluginAsync } from 'fastify'
import type { MasterIngestionEngine } from '../services/masterIngestor'
import type { TenantManager } from '../services/tenantManager'
import type { OrderGateway } from '../services/orderGateway'
import type { ActivityLog } from '../services/activityLog'
import type { UnderlyingSymbol, UserBotState } from '../types'
import type { WebSocket } from 'ws'

/** Strip sensitive credentials before sending state to clients */
function sanitizeUserState(state: UserBotState): Omit<UserBotState, 'upstoxToken'> {
  const { upstoxToken: _token, ...safe } = state
  return safe
}

export interface BotRoutesOptions {
  masterIngestor: MasterIngestionEngine
  tenantManager: TenantManager
  orderGateway: OrderGateway
  /** In-memory daemon activity log streamed to the window (optional). */
  activityLog?: ActivityLog | null
}

export const botRoutes: FastifyPluginAsync<BotRoutesOptions> = async (
  fastify,
  opts,
) => {
  const { masterIngestor, tenantManager, orderGateway, activityLog = null } = opts

  // Connected WebSocket clients: Map<userId, Set<WebSocket>>
  const activeSockets = new Map<string, Set<WebSocket>>()

  // Periodic heartbeat every 30s to purge dead sockets
  const heartbeatInterval = setInterval(() => {
    for (const [userId, sockets] of activeSockets.entries()) {
      for (const ws of sockets) {
        if (ws.readyState === 1 /* OPEN */) {
          ws.ping()
        } else if (ws.readyState === 3 /* CLOSED */ || ws.readyState === 2 /* CLOSING */) {
          sockets.delete(ws)
        }
      }
      if (sockets.size === 0) {
        activeSockets.delete(userId)
      }
    }
  }, 30000)

  fastify.addHook('onClose', async () => {
    clearInterval(heartbeatInterval)
    for (const sockets of activeSockets.values()) {
      for (const ws of sockets) {
        try {
          ws.close()
        } catch {
          // Ignore close errors on shutdown
        }
      }
    }
    activeSockets.clear()
  })

  // Broadcast market ticks to all connected sockets
  masterIngestor.on('marketTick', (tick) => {
    const payload = JSON.stringify({ type: 'MARKET_TICK', data: tick })
    for (const sockets of activeSockets.values()) {
      for (const ws of sockets) {
        if (ws.readyState === 1 /* OPEN */) {
          try {
            ws.send(payload)
          } catch {
            sockets.delete(ws)
          }
        }
      }
    }
  })

  // Broadcast individual user state updates to their specific sockets
  tenantManager.on('userStateUpdate', ({ userId, state }) => {
    const sockets = activeSockets.get(userId)
    if (sockets) {
      // Never leak credentials over the wire (the window may have many clients)
      const payload = JSON.stringify({
        type: 'USER_STATE_UPDATE',
        data: sanitizeUserState(state),
      })
      for (const ws of sockets) {
        if (ws.readyState === 1 /* OPEN */) {
          try {
            ws.send(payload)
          } catch {
            sockets.delete(ws)
          }
        }
      }
    }
  })

  // ── GET /api/bot/status ────────────────────────────────────────────────────
  fastify.get('/api/bot/status', async (request, reply) => {
    const query = request.query as { userId?: string }
    const userId = query.userId || 'default_user'
    const snapshots = masterIngestor.getAllSnapshots()
    const userState = tenantManager.getOrCreateUser(userId)
    const paperTrades = orderGateway.getPaperTrades(userId)

    return reply.send({
      serverTime: new Date().toISOString(),
      snapshots,
      userState: sanitizeUserState(userState),
      paperTrades,
      // CR-15: null when healthy; a message means live entries are blocked
      // until the state store recovers (paper continues in-memory).
      persistenceFault: tenantManager.getPersistenceFault(),
      // Boolean only — the master token itself never leaves the daemon.
      hasToken: Boolean(masterIngestor.getMasterToken()),
      // Boolean only — whether this user has a per-user order-token override.
      hasOrderTokenOverride: Boolean(userState.upstoxToken),
    })
  })

  // ── GET /api/bot/signal-snapshots ──────────────────────────────────────────
  // Replayable entry-evaluation records (filter on/off, V3/V4/VRD/HTF).
  // Loopback window only; no broker credentials are stored in these rows.
  fastify.get('/api/bot/signal-snapshots', async (request, reply) => {
    const query = request.query as {
      userId?: string
      date?: string
      limit?: string
    }
    const userId = query.userId || 'default_user'
    if (query.date && !/^\d{4}-\d{2}-\d{2}$/.test(query.date)) {
      return reply.status(400).send({ error: 'date must be YYYY-MM-DD' })
    }
    const parsedLimit = Number(query.limit)
    const limit = Number.isFinite(parsedLimit)
      ? Math.min(Math.max(Math.trunc(parsedLimit), 1), 5000)
      : 200
    const snapshots = tenantManager.getSignalSnapshots(
      userId,
      query.date,
      limit,
    )
    return reply.send({
      userId,
      date: query.date ?? null,
      count: snapshots.length,
      snapshots,
    })
  })

  // ── POST /api/bot/start ────────────────────────────────────────────────────
  fastify.post('/api/bot/start', async (request, reply) => {
    const body = request.body as { userId?: string; executionMode?: 'paper' | 'live' } | null
    const userId = body?.userId || 'default_user'
    try {
      const userState = tenantManager.startBot(userId, body?.executionMode)
      return reply.send({ success: true, userState: sanitizeUserState(userState) })
    } catch (err) {
      // Live-arming / single-active-trader rejections are 403s, not crashes.
      return reply.code(403).send({ error: (err as Error).message })
    }
  })

  // ── POST /api/bot/stop ─────────────────────────────────────────────────────
  fastify.post('/api/bot/stop', async (request, reply) => {
    const body = request.body as { userId?: string } | null
    const userId = body?.userId || 'default_user'
    const userState = tenantManager.stopBot(userId)
    return reply.send({ success: true, userState: sanitizeUserState(userState) })
  })

  // ── POST /api/bot/config ───────────────────────────────────────────────────
  fastify.post('/api/bot/config', async (request, reply) => {
    const body = request.body as { userId?: string; config: any } | null
    const userId = body?.userId || 'default_user'
    if (!body?.config) {
      return reply.status(400).send({ error: 'Missing config payload' })
    }
    try {
      const userState = tenantManager.updateConfig(userId, body.config)
      return reply.send({ success: true, userState: sanitizeUserState(userState) })
    } catch (err) {
      // Live-arming / mid-session mode-switch rejections are 403s.
      return reply.code(403).send({ error: (err as Error).message })
    }
  })

  // ── POST /api/bot/token ────────────────────────────────────────────────────
  fastify.post('/api/bot/token', async (request, reply) => {
    const body = request.body as {
      userId?: string
      token?: string
      alsoMaster?: boolean
      clear?: boolean
    } | null
    const userId = body?.userId || 'default_user'

    // Explicitly drop the per-user order-token override (falls back to the
    // master ingestion token). Used by the Broker Accounts window.
    if (body?.clear) {
      const userState = tenantManager.clearToken(userId)
      return reply.send({ success: true, userState: sanitizeUserState(userState) })
    }

    if (!body?.token) {
      return reply.status(400).send({ error: 'Missing token' })
    }

    // Expired-token guard (Oct 14 incident: a stale token replaced a working
    // one and the daemon went blind all day). A JWT with a past exp is
    // rejected so a stale paste can never evict a usable token.
    try {
      const payload = JSON.parse(
        Buffer.from(body.token.split('.')[1], 'base64url').toString('utf-8'),
      ) as { exp?: number }
      if (typeof payload.exp === 'number' && payload.exp * 1000 < Date.now()) {
        return reply.status(400).send({
          error: `Token EXPIRED at ${new Date(payload.exp * 1000).toISOString()} — run a fresh Upstox OAuth and paste the new token`,
        })
      }
    } catch {
      // Not a decodable JWT — accept (defensive; Upstox tokens are JWTs).
    }

    // Optional: also refresh the master token driving ALL market data
    // (quotes, candles, chains, VIX). Off by default because this field is
    // documented as a per-user order-token override.
    if (body.alsoMaster) {
      masterIngestor.setToken(body.token)
    }
    const userState = tenantManager.setToken(userId, body.token)
    return reply.send({ success: true, userState: sanitizeUserState(userState) })
  })

  // ── POST /api/bot/paper-reset ──────────────────────────────────────────────
  fastify.post('/api/bot/paper-reset', async (request, reply) => {
    const body = request.body as { userId?: string } | null
    const userId = body?.userId || 'default_user'
    const account = orderGateway.resetPaperAccount(userId)
    const userState = tenantManager.getOrCreateUser(userId)
    return reply.send({ success: true, balance: account.balance, userState: sanitizeUserState(userState) })
  })

  // ── POST /api/bot/trade/exit ───────────────────────────────────────────────
  fastify.post('/api/bot/trade/exit', async (request, reply) => {
    const body = request.body as { userId?: string; symbol: UnderlyingSymbol; reason?: string } | null
    const userId = body?.userId || 'default_user'
    if (!body?.symbol) {
      return reply.status(400).send({ error: 'Missing symbol' })
    }
    const userState = await tenantManager.manualExit(userId, body.symbol, body.reason || 'Manual Web Exit')
    return reply.send({ success: true, userState: sanitizeUserState(userState) })
  })

  // In-memory daemon activity log for the window's Bot Logs panel. A freshly
  // loaded window fetches this backlog, then receives live LOG frames over /ws
  // (deduped client-side by `seq`).
  fastify.get('/api/bot/logs', async (request, reply) => {
    if (!activityLog) return reply.send({ entries: [], debugEnabled: false })
    const query = request.query as { limit?: string }
    const parsed = Number(query.limit)
    const limit = Number.isFinite(parsed)
      ? Math.min(Math.max(Math.trunc(parsed), 1), 500)
      : 200
    return reply.send({
      entries: activityLog.backlog(limit),
      debugEnabled: activityLog.isDebugEnabled(),
    })
  })

  // ── WebSocket /ws ──────────────────────────────────────────────────────────
  fastify.get('/ws', { websocket: true }, (connection, req) => {
    const query = req.query as { userId?: string }
    const userId = query.userId || 'default_user'
    const ws = (connection as any).socket || connection

    if (!activeSockets.has(userId)) {
      activeSockets.set(userId, new Set())
    }
    activeSockets.get(userId)!.add(ws)

    // Stream daemon activity entries to this window as LOG frames. Entries are
    // deduped client-side by `seq` against the /api/bot/logs backlog.
    const unsubscribeLogs = activityLog?.subscribe((entry) => {
      if (ws.readyState !== 1) return
      try {
        ws.send(JSON.stringify({ type: 'LOG', data: entry }))
      } catch {
        // Dead socket — the close handler unsubscribes.
      }
    })

    // Send immediate initial sync
    const initialSnapshots = masterIngestor.getAllSnapshots()
    const userState = tenantManager.getOrCreateUser(userId)
    ws.send(
      JSON.stringify({
        type: 'INITIAL_STATE',
        data: {
          snapshots: initialSnapshots,
          userState: sanitizeUserState(userState),
        },
      }),
    )

    ws.on('close', () => {
      unsubscribeLogs?.()
      const set = activeSockets.get(userId)
      if (set) {
        set.delete(ws)
        if (set.size === 0) activeSockets.delete(userId)
      }
    })

    ws.on('error', () => {
      unsubscribeLogs?.()
      const set = activeSockets.get(userId)
      if (set) {
        set.delete(ws)
        if (set.size === 0) activeSockets.delete(userId)
      }
    })

    ws.on('message', async (raw: any) => {
      try {
        const msg = JSON.parse(raw.toString())
        if (msg.action === 'START') {
          tenantManager.startBot(userId, msg.executionMode)
        } else if (msg.action === 'STOP') {
          tenantManager.stopBot(userId)
        } else if (msg.action === 'CONFIG') {
          tenantManager.updateConfig(userId, msg.config)
        }
      } catch {
        // Ignore malformed messages
      }
    })
  })
}
