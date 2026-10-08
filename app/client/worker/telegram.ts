import type { Env } from './types'

const TELEGRAM_API_BASE = 'https://api.telegram.org'
// Telegram sendMessage hard limit is 4096 chars; leave headroom.
const MAX_MESSAGE_CHARS = 4000

interface TelegramNotifyBody {
  message: string
}

/**
 * Forwards a trade alert message to the configured Telegram chat.
 * Requires TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to be configured
 * (`.dev.vars` locally, Cloudflare secrets in production). Fails closed
 * with a structured error when either value is missing so the client can
 * treat notification delivery as best-effort.
 */
export async function handleTelegramNotify(
  request: Request,
  env: Env,
  userId: string,
): Promise<Response> {
  void userId

  let body: TelegramNotifyBody
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const message = typeof body.message === 'string' ? body.message.trim() : ''
  if (!message) {
    return Response.json({ error: 'message is required' }, { status: 400 })
  }
  if (message.length > MAX_MESSAGE_CHARS) {
    return Response.json(
      { error: `message exceeds ${MAX_MESSAGE_CHARS} characters` },
      { status: 400 },
    )
  }

  const botToken = env.TELEGRAM_BOT_TOKEN
  const chatId = env.TELEGRAM_CHAT_ID
  if (!botToken || !chatId) {
    console.error(
      '[telegram] NOT CONFIGURED — TELEGRAM_BOT_TOKEN:',
      botToken ? 'SET' : 'MISSING',
      '| TELEGRAM_CHAT_ID:',
      chatId ? 'SET' : 'MISSING',
    )
    return Response.json(
      {
        notified: false,
        reason: 'TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are not configured',
      },
      { status: 503 },
    )
  }

  let upstream: Response
  try {
    upstream = await fetch(`${TELEGRAM_API_BASE}/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message }),
      signal: AbortSignal.timeout(8000),
    })
  } catch (e) {
    return Response.json(
      { notified: false, error: `Failed to reach Telegram API: ${String(e)}` },
      { status: 502 },
    )
  }

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => '')
    console.error(
      '[telegram] API ERROR',
      upstream.status,
      ':',
      detail.slice(0, 200),
    )
    return Response.json(
      {
        notified: false,
        error: `Telegram API returned ${upstream.status}`,
        detail,
      },
      { status: 502 },
    )
  }

  console.log('[telegram] DELIVERED — length:', message.length, 'chars')
  return Response.json({ notified: true })
}
