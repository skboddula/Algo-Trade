// Upstox OAuth routes — daily access-token refresh from the browser.
//
// Upstox access tokens expire daily (~03:30 IST; no refresh tokens by design).
// Instead of copy-pasting a token into .env, open:
//
//     http://127.0.0.1:3000/auth/upstox/start
//
// Flow: /auth/upstox/start → Upstox login dialog → /auth/upstox/callback.
// The callback exchanges the code server-side (the API secret never reaches
// the browser), writes PRIMARY_UPSTOX_TOKEN into .env (timestamped backup
// kept), and hot-swaps the running feed via masterIngestor.setToken() — no
// daemon restart required.
//
// One-time setup (app/core/.env): UPSTOX_API_KEY, UPSTOX_API_SECRET and
// UPSTOX_REDIRECT_URI; the same redirect URI must be registered in the
// Upstox developer app (https://account.upstox.com/developer/apps).

import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { MasterIngestionEngine } from '../services/masterIngestor'

export interface UpstoxAuthRoutesOptions {
  masterIngestor: MasterIngestionEngine
  apiKey?: string
  apiSecret?: string
  redirectUri?: string
  /** File whose PRIMARY_UPSTOX_TOKEN line is updated (default: ./.env). */
  envFilePath?: string
  /** Upstox API base for the dialog + token endpoints (default https://api.upstox.com/v2). */
  upstoxApiBaseUrl?: string
  /** Test seam (defaults to global fetch). */
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>
  /** Login-state validity window (default 10 minutes). */
  stateTtlMs?: number
}

const DEFAULT_STATE_TTL_MS = 10 * 60_000
const TOKEN_EXCHANGE_TIMEOUT_MS = 10_000

export const upstoxAuthRoutes: FastifyPluginAsync<UpstoxAuthRoutesOptions> = async (fastify, opts) => {
  const {
    masterIngestor,
    apiKey = process.env.UPSTOX_API_KEY,
    apiSecret = process.env.UPSTOX_API_SECRET,
    redirectUri = process.env.UPSTOX_REDIRECT_URI,
    envFilePath = path.resolve(process.env.DOTENV_CONFIG_PATH || '.env'),
    upstoxApiBaseUrl = process.env.UPSTOX_API_URL || 'https://api.upstox.com/v2',
  } = opts
  const fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init))
  const stateTtlMs = opts.stateTtlMs ?? DEFAULT_STATE_TTL_MS

  // Single-use login states (CSRF guard). In-memory: a daemon restart simply
  // requires opening /auth/upstox/start again.
  const pendingStates = new Map<string, number>()

  const wantsJson = (request: FastifyRequest): boolean =>
    (request.headers.accept ?? '').includes('application/json')

  const missingConfig = (): string[] => {
    const missing: string[] = []
    if (!apiKey) missing.push('UPSTOX_API_KEY')
    if (!apiSecret) missing.push('UPSTOX_API_SECRET')
    if (!redirectUri) missing.push('UPSTOX_REDIRECT_URI')
    return missing
  }

  fastify.get('/auth/upstox/start', async (request, reply) => {
    const missing = missingConfig()
    if (missing.length > 0) {
      const message =
        `Upstox OAuth is not configured. Add ${missing.join(', ')} to app/core/.env ` +
        `and restart, then register ${redirectUri || 'the redirect URI'} in your Upstox app ` +
        `(account.upstox.com/developer/apps).`
      if (wantsJson(request)) return reply.status(400).send({ error: message, missing })
      return reply.status(400).type('text/html').send(renderPage('Upstox OAuth not configured', message, false))
    }

    const now = Date.now()
    for (const [state, createdAt] of pendingStates) {
      if (now - createdAt > stateTtlMs) pendingStates.delete(state)
    }
    const state = crypto.randomBytes(16).toString('hex')
    pendingStates.set(state, now)

    const url = new URL(`${upstoxApiBaseUrl}/login/authorization/dialog`)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('client_id', apiKey!)
    url.searchParams.set('redirect_uri', redirectUri!)
    url.searchParams.set('state', state)

    if (wantsJson(request)) return reply.send({ authorizationUrl: url.toString(), redirectUri })
    return reply.redirect(url.toString())
  })

  fastify.get('/auth/upstox/callback', async (request, reply) => {
    const query = request.query as {
      code?: string
      state?: string
      error?: string
      error_description?: string
    }

    if (query.error || !query.code) {
      const message = query.error
        ? `Upstox login was not completed (${query.error}${query.error_description ? `: ${query.error_description}` : ''}).`
        : 'Missing authorization code — start again at /auth/upstox/start.'
      return reply.status(400).type('text/html').send(renderPage('Upstox login failed', message, false))
    }

    const missing = missingConfig()
    if (missing.length > 0) {
      const message = `Upstox OAuth is not configured (missing ${missing.join(', ')}). See deploy/README.md.`
      return reply.status(400).type('text/html').send(renderPage('Upstox OAuth not configured', message, false))
    }

    const state = query.state
    const stateCreatedAt = state ? pendingStates.get(state) : undefined
    if (!state || stateCreatedAt === undefined || Date.now() - stateCreatedAt > stateTtlMs) {
      const message = 'Invalid or expired login state. Open /auth/upstox/start again to restart the flow.'
      if (state) pendingStates.delete(state)
      return reply.status(400).type('text/html').send(renderPage('Upstox login failed', message, false))
    }
    pendingStates.delete(state) // single use

    try {
      const res = await fetchImpl(`${upstoxApiBaseUrl}/login/authorization/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({
          code: query.code,
          client_id: apiKey!,
          client_secret: apiSecret!,
          redirect_uri: redirectUri!,
          grant_type: 'authorization_code',
        }).toString(),
        signal: AbortSignal.timeout(TOKEN_EXCHANGE_TIMEOUT_MS),
      })

      const payload = (await res.json().catch(() => null)) as { access_token?: unknown } | null
      const token = typeof payload?.access_token === 'string' ? payload.access_token : null

      if (!res.ok || !token) {
        const detail = describeUpstoxError(payload) ?? `HTTP ${res.status}`
        fastify.log.warn({ status: res.status }, `Upstox token exchange rejected: ${detail}`)
        const message = `Upstox rejected the token exchange (${detail}). Open /auth/upstox/start and try again.`
        return reply.status(502).type('text/html').send(renderPage('Token exchange failed', message, false))
      }

      const backupPath = persistPrimaryToken(envFilePath, token)
      masterIngestor.setToken(token)
      fastify.log.info({ envFilePath, backupPath }, 'Upstox token refreshed via OAuth — feed hot-swapped')

      return reply
        .type('text/html')
        .send(
          renderPage(
            'Upstox token refreshed',
            'The daemon saved the new token and the live feed is reconnecting (usually a few seconds). You can close this tab.',
            true,
          ),
        )
    } catch (err) {
      fastify.log.error(err, 'Upstox token exchange failed')
      const message = 'Could not reach the Upstox token endpoint. Check connectivity and try again.'
      return reply.status(502).type('text/html').send(renderPage('Token exchange failed', message, false))
    }
  })
}

/**
 * Replace (or append) PRIMARY_UPSTOX_TOKEN in an .env file, keeping a
 * timestamped backup of the previous contents. Returns the backup path, or
 * null when the file did not exist yet.
 */
export function persistPrimaryToken(envFilePath: string, token: string): string | null {
  let content = ''
  let backupPath: string | null = null

  if (fs.existsSync(envFilePath)) {
    content = fs.readFileSync(envFilePath, 'utf8')
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
    backupPath = `${envFilePath}.bak-${stamp}`
    fs.copyFileSync(envFilePath, backupPath)
    fs.chmodSync(backupPath, 0o600)
  }

  const line = `PRIMARY_UPSTOX_TOKEN=${token}`
  const next = /^[ \t]*PRIMARY_UPSTOX_TOKEN=.*$/m.test(content)
    ? content.replace(/^[ \t]*PRIMARY_UPSTOX_TOKEN=.*$/m, line)
    : `${content}${content === '' || content.endsWith('\n') ? '' : '\n'}${line}\n`

  const tmpPath = `${envFilePath}.tmp-${process.pid}`
  fs.writeFileSync(tmpPath, next, { mode: 0o600 })
  fs.renameSync(tmpPath, envFilePath)
  fs.chmodSync(envFilePath, 0o600)

  return backupPath
}

function describeUpstoxError(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null
  const record = payload as Record<string, unknown>
  if (typeof record.error === 'string' && record.error) return record.error
  const errors = Array.isArray(record.errors) ? record.errors : []
  const messages = errors
    .map((entry) =>
      entry && typeof entry === 'object' && typeof (entry as Record<string, unknown>).message === 'string'
        ? ((entry as Record<string, unknown>).message as string)
        : null,
    )
    .filter((message): message is string => Boolean(message))
  return messages.length > 0 ? messages.join('; ') : null
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function renderPage(title: string, message: string, ok: boolean): string {
  const accent = ok ? '#22c55e' : '#ef4444'
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    `<title>${escapeHtml(title)}</title>` +
    '<style>body{background:#0b0f17;color:#e5e7eb;font-family:system-ui,-apple-system,sans-serif;' +
    'display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}' +
    `.card{max-width:440px;padding:32px;text-align:center}h1{font-size:18px;color:${accent};margin:0 0 12px}` +
    'p{font-size:14px;color:#9ca3af;line-height:1.55;margin:0}</style></head>' +
    `<body><div class="card"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></div></body></html>`
  )
}
