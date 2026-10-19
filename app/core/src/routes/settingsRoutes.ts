// Daemon settings routes — window-managed account details + alert config.
//
//   GET  /api/daemon/settings               → masked view (never returns secrets)
//   POST /api/daemon/settings/upstox        → save API key / secret / redirect URI
//   POST /api/daemon/settings/telegram      → save Telegram bot token / chat id
//   POST /api/daemon/settings/telegram/test → deliver a test alert message
//
// Values live in the daemon's SQLite (StateStore `daemon_settings` table) so
// the Broker Accounts window can manage the account without editing
// app/core/.env. The environment remains a fallback for headless deployments;
// saved settings win over env, and explicit route options (tests) win over
// both — the same precedence the OAuth routes use.

import type { FastifyPluginAsync } from 'fastify'
import { DAEMON_SETTING_KEYS, type SettingsStore } from '../services/daemonSettings'
import { resolveTelegramConfig, sendTelegramMessage } from '../services/notifier'

/** Treat blank values (e.g. `UPSTOX_API_KEY=` lines in .env) as unset. */
function clean(value: string | undefined | null): string | undefined {
  return value && value.trim() !== '' ? value.trim() : undefined
}

/** Trim a body field; null when absent or blank. */
const readField = (raw: unknown): string | null =>
  typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null

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

export interface DaemonTelegramSettingsView {
  hasBotToken: boolean
  /** Masked prefix of the saved bot token — never the full token. */
  botTokenHint: string | null
  hasChatId: boolean
  /** Masked suffix of the chat id (e.g. ••••6003) — never the full id. */
  chatIdHint: string | null
}

/** Masked, browser-safe view of the Telegram alert settings. */
export function buildTelegramSettingsView(store: SettingsStore | null): DaemonTelegramSettingsView {
  const botToken = clean(store?.getSetting(DAEMON_SETTING_KEYS.telegramBotToken)) ?? clean(process.env.TELEGRAM_BOT_TOKEN)
  const chatId = clean(store?.getSetting(DAEMON_SETTING_KEYS.telegramChatId)) ?? clean(process.env.TELEGRAM_CHAT_ID)

  return {
    hasBotToken: Boolean(botToken),
    botTokenHint: botToken ? `${botToken.slice(0, 8)}${botToken.length > 8 ? '…' : ''}` : null,
    hasChatId: Boolean(chatId),
    chatIdHint: chatId ? `${'•'.repeat(Math.max(0, chatId.length - 4))}${chatId.slice(-4)}` : null,
  }
}

export const settingsRoutes: FastifyPluginAsync<SettingsRoutesOptions> = async (fastify, opts) => {
  const store = opts.store ?? null

  // ── GET /api/daemon/settings ───────────────────────────────────────────────
  fastify.get('/api/daemon/settings', async (_request, reply) => {
    return reply.send({
      upstox: buildUpstoxSettingsView(store),
      telegram: buildTelegramSettingsView(store),
    })
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

  // ── POST /api/daemon/settings/telegram ─────────────────────────────────────
  // Saves the alert bot token / chat id. Omitted fields keep their value.
  fastify.post('/api/daemon/settings/telegram', async (request, reply) => {
    if (!store) {
      return reply.status(503).send({
        error: 'State store unavailable — settings cannot be saved in this mode.',
      })
    }

    const body = (request.body ?? {}) as { botToken?: unknown; chatId?: unknown }
    const botToken = readField(body.botToken)
    const chatId = readField(body.chatId)

    if (body.botToken !== undefined && botToken === null) {
      return reply.status(400).send({ error: 'Bot token cannot be empty' })
    }
    if (botToken !== null && !/^\d+:[A-Za-z0-9_-]+$/.test(botToken)) {
      return reply.status(400).send({
        error: 'Bot token must look like 123456789:AA… (from @BotFather)',
      })
    }
    if (body.chatId !== undefined && chatId === null) {
      return reply.status(400).send({ error: 'Chat id cannot be empty' })
    }
    if (chatId !== null && !/^-?\d+$/.test(chatId)) {
      return reply.status(400).send({
        error: 'Chat id must be numeric (negative for group chats)',
      })
    }

    if (botToken !== null) store.setSetting(DAEMON_SETTING_KEYS.telegramBotToken, botToken)
    if (chatId !== null) store.setSetting(DAEMON_SETTING_KEYS.telegramChatId, chatId)

    return reply.send({ success: true, telegram: buildTelegramSettingsView(store) })
  })

  // ── POST /api/daemon/settings/telegram/test ────────────────────────────────
  // Delivers through the same config resolution the daemon's notifier uses,
  // so a green result proves end-to-end delivery for every future alert.
  fastify.post('/api/daemon/settings/telegram/test', async (_request, reply) => {
    const config = resolveTelegramConfig(process.env, () => ({
      botToken: store?.getSetting(DAEMON_SETTING_KEYS.telegramBotToken),
      chatId: store?.getSetting(DAEMON_SETTING_KEYS.telegramChatId),
    }))
    if (!config) {
      return reply.status(400).send({
        error:
          'Telegram is not configured yet — save the bot token and chat id first.',
      })
    }

    const result = await sendTelegramMessage(
      config,
      '✅ Algo-Trade: test alert from the daemon window — Telegram alerts are working.',
    )
    if (!result.ok) {
      return reply.status(502).send({ error: result.error ?? 'Telegram send failed.' })
    }
    return reply.send({ success: true })
  })
}
