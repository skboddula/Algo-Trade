// Daemon settings routes — window-managed Upstox account details.
//
//   GET  /api/daemon/settings          → masked view (never returns secrets)
//   POST /api/daemon/settings/upstox   → save API key / secret / redirect URI
//
// Values live in the daemon's SQLite (StateStore `daemon_settings` table) so
// the Broker Accounts window can manage the account without editing
// app/core/.env. The environment remains a fallback for headless deployments;
// saved settings win over env, and explicit route options (tests) win over
// both — the same precedence the OAuth routes use.

import type { FastifyPluginAsync } from 'fastify'
import { DAEMON_SETTING_KEYS, type SettingsStore } from '../services/daemonSettings'

export interface SettingsRoutesOptions {
  store?: SettingsStore | null
}

export interface DaemonUpstoxSettingsView {
  hasApiKey: boolean
  /** Masked prefix of the API key (client id) — never the full key. */
  apiKeyHint: string | null
  hasApiSecret: boolean
  redirectUri: string | null
  hasMasterToken: boolean
}

/** Masked, browser-safe view of the Upstox settings (secrets as booleans only). */
export function buildUpstoxSettingsView(store: SettingsStore | null): DaemonUpstoxSettingsView {
  // Treat blank values (e.g. `UPSTOX_API_KEY=` lines in .env) as unset.
  const clean = (value: string | undefined): string | undefined =>
    value && value.trim() !== '' ? value : undefined

  const apiKey = clean(store?.getSetting(DAEMON_SETTING_KEYS.upstoxApiKey)) ?? clean(process.env.UPSTOX_API_KEY)
  const apiSecret = clean(store?.getSetting(DAEMON_SETTING_KEYS.upstoxApiSecret)) ?? clean(process.env.UPSTOX_API_SECRET)
  const redirectUri = clean(store?.getSetting(DAEMON_SETTING_KEYS.upstoxRedirectUri)) ?? clean(process.env.UPSTOX_REDIRECT_URI)
  const masterToken = clean(store?.getSetting(DAEMON_SETTING_KEYS.upstoxMasterToken)) ?? clean(process.env.PRIMARY_UPSTOX_TOKEN)

  return {
    hasApiKey: Boolean(apiKey),
    apiKeyHint: apiKey ? `${apiKey.slice(0, 8)}${apiKey.length > 8 ? '…' : ''}` : null,
    hasApiSecret: Boolean(apiSecret),
    redirectUri: redirectUri ?? null,
    hasMasterToken: Boolean(masterToken),
  }
}

export const settingsRoutes: FastifyPluginAsync<SettingsRoutesOptions> = async (fastify, opts) => {
  const store = opts.store ?? null

  // ── GET /api/daemon/settings ───────────────────────────────────────────────
  fastify.get('/api/daemon/settings', async (_request, reply) => {
    return reply.send({ upstox: buildUpstoxSettingsView(store) })
  })

  // ── POST /api/daemon/settings/upstox ───────────────────────────────────────
  fastify.post('/api/daemon/settings/upstox', async (request, reply) => {
    if (!store) {
      return reply.status(503).send({
        error: 'State store unavailable — settings cannot be saved in this mode.',
      })
    }

    const body = (request.body ?? {}) as {
      apiKey?: unknown
      apiSecret?: unknown
      redirectUri?: unknown
      clearApiSecret?: unknown
    }

    // Fields are optional: omit to keep the saved value; empty strings are
    // rejected (re-saving a new value replaces it). Explicit
    // `clearApiSecret: true` drops the saved secret.
    const readField = (raw: unknown): string | null =>
      typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null

    const apiKey = readField(body.apiKey)
    const apiSecret = readField(body.apiSecret)
    const redirectUri = readField(body.redirectUri)

    if (body.apiKey !== undefined && apiKey === null) {
      return reply.status(400).send({ error: 'API key cannot be empty' })
    }
    if (body.apiSecret !== undefined && apiSecret === null) {
      return reply.status(400).send({ error: 'API secret cannot be empty' })
    }
    if (body.redirectUri !== undefined && redirectUri === null) {
      return reply.status(400).send({ error: 'Redirect URI cannot be empty' })
    }
    if (redirectUri !== null) {
      let parsed: URL
      try {
        parsed = new URL(redirectUri)
      } catch {
        return reply.status(400).send({ error: 'Redirect URI must be a valid http(s) URL' })
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return reply.status(400).send({ error: 'Redirect URI must be a valid http(s) URL' })
      }
    }

    if (apiKey !== null) store.setSetting(DAEMON_SETTING_KEYS.upstoxApiKey, apiKey)
    if (apiSecret !== null) store.setSetting(DAEMON_SETTING_KEYS.upstoxApiSecret, apiSecret)
    if (redirectUri !== null) store.setSetting(DAEMON_SETTING_KEYS.upstoxRedirectUri, redirectUri)
    if (body.clearApiSecret === true) store.deleteSetting(DAEMON_SETTING_KEYS.upstoxApiSecret)

    return reply.send({ success: true, upstox: buildUpstoxSettingsView(store) })
  })
}
