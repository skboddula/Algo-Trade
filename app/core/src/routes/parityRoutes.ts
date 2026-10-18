import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import type { OrderGateway } from '../services/orderGateway'
import type { TenantManager } from '../services/tenantManager'
import type { PaperAccountSummary } from '../types'
import { DEFAULT_INITIAL_PAPER_BALANCE } from '../constants'
import {
  fetchUpstoxFunds,
  fetchUpstoxProfile,
  UpstoxRestError,
} from '../../../../packages/shared/src/upstoxRest'

export interface ParityRoutesOptions {
  tenantManager: TenantManager
  orderGateway: OrderGateway
}

/** Paper ledger is in paise; the client contract is in rupees (worker parity). */
const toRupees = (paise: number): number => Math.round(paise) / 100
const toPaise = (rupees: number): number => Math.round(rupees * 100)

/**
 * Same-origin equivalents of the cloud worker's client API paths
 * (`/api/broker/upstox/*`, `/api/paper/*`).
 *
 * The built dashboard is served by the daemon itself, so these routes let the
 * shared pages keep their existing fetch calls in the daemon window. The
 * Upstox calls are shared verbatim with the worker via `packages/shared`;
 * paper data comes from the daemon's own OrderGateway ledger (the worker's
 * D1-backed handlers cannot run here by design — single source of truth).
 */
export const parityRoutes: FastifyPluginAsync<ParityRoutesOptions> = async (
  fastify,
  opts,
) => {
  const { tenantManager, orderGateway } = opts

  const paperSummary = (userId: string): PaperAccountSummary => {
    const account = orderGateway.getOrCreatePaperAccount(userId)
    const trades = orderGateway.getPaperTrades(userId)
    return {
      account: {
        id: account.id,
        mode: 'paper',
        userId,
        balance: toRupees(account.balance),
        currency: account.currency,
        updatedAt: account.updatedAt,
      },
      // The daemon ledger has no statement journal; the profile cards only
      // read account.balance (trade history has its own daemon views).
      recentEntries: [],
      openTradeCount: trades.filter((trade) => trade.status === 'OPEN').length,
      // Reset target in rupees — the window labels its reset button with it.
      startingBalance: toRupees(DEFAULT_INITIAL_PAPER_BALANCE),
    }
  }

  const sendUpstoxError = (reply: FastifyReply, err: unknown) =>
    reply.status(502).send({
      error:
        err instanceof UpstoxRestError
          ? err.message
          : 'Failed to reach Upstox API',
    })

  // ── POST /api/broker/upstox/profile ───────────────────────────────────────
  // Worker contract: body { token } → upstream payload passed through.
  // The daemon window sends no token: fall back to the daemon's own
  // effective order token (per-user override → master ingestion token).
  fastify.post('/api/broker/upstox/profile', async (request, reply) => {
    const body = request.body as { userId?: string; token?: string } | null
    const userId = body?.userId || 'default_user'
    const token = body?.token || tenantManager.getEffectiveOrderToken(userId)
    if (!token) {
      return reply.status(400).send({
        error:
          'No Upstox token available — paste one on the Broker Accounts page or refresh via OAuth',
      })
    }
    try {
      const { status, data } = await fetchUpstoxProfile(token)
      return reply.status(status).send(data)
    } catch (err) {
      return sendUpstoxError(reply, err)
    }
  })

  // ── POST /api/broker/upstox/funds ─────────────────────────────────────────
  fastify.post('/api/broker/upstox/funds', async (request, reply) => {
    const body = request.body as { userId?: string; token?: string } | null
    const userId = body?.userId || 'default_user'
    const token = body?.token || tenantManager.getEffectiveOrderToken(userId)
    if (!token) {
      return reply.status(400).send({
        error:
          'No Upstox token available — paste one on the Broker Accounts page or refresh via OAuth',
      })
    }
    try {
      const { status, data } = await fetchUpstoxFunds(token)
      return reply.status(status).send(data)
    } catch (err) {
      return sendUpstoxError(reply, err)
    }
  })

  // ── GET /api/paper/account ────────────────────────────────────────────────
  fastify.get('/api/paper/account', async (request, reply) => {
    const query = request.query as { userId?: string }
    return reply.send(paperSummary(query.userId || 'default_user'))
  })

  // ── POST /api/paper/account/adjust ────────────────────────────────────────
  // Worker contract: { mode: 'set' | 'adjust', amount (₹), note? }
  fastify.post('/api/paper/account/adjust', async (request, reply) => {
    const body = request.body as {
      userId?: string
      mode?: 'set' | 'adjust'
      amount?: number
    } | null
    const userId = body?.userId || 'default_user'
    const mode = body?.mode ?? 'set'
    const amount = Number(body?.amount)
    if (!Number.isFinite(amount)) {
      return reply.status(400).send({ error: 'Amount must be a valid number' })
    }
    if (mode !== 'set' && mode !== 'adjust') {
      return reply.status(400).send({ error: 'Mode must be set or adjust' })
    }
    try {
      orderGateway.adjustPaperAccount(userId, mode, toPaise(amount))
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message })
    }
    tenantManager.syncPaperBalance(userId)
    return reply.send(paperSummary(userId))
  })

  // ── POST /api/paper/reset ─────────────────────────────────────────────────
  fastify.post('/api/paper/reset', async (request, reply) => {
    const body = request.body as { userId?: string } | null
    const userId = body?.userId || 'default_user'
    orderGateway.resetPaperAccount(userId)
    tenantManager.syncPaperBalance(userId)
    return reply.send(paperSummary(userId))
  })
}
