/**
 * Minimal Telegram notifier used for always-on operation alerts.
 *
 * Config precedence: window-managed settings (daemon SQLite) → environment.
 * The notifier is a no-op while neither source provides both values, so tests
 * and local runs are unaffected — and because the config is resolved on every
 * send, values saved from the window apply without a daemon restart.
 *
 * Alerts currently sent:
 *   - daemon started / stopping
 *   - market feed down (after repeated failed ticks) / recovered
 *   - position opened / closed (rich entry/exit cards, paper + live)
 *   - India VIX critical warning / end-of-day daily summary
 */

export type Notifier = (text: string) => Promise<void>

export interface TelegramConfig {
  botToken: string
  chatId: string
}

/** Window-managed values; blank fields fall through to the environment. */
export interface TelegramSavedConfig {
  botToken?: string | null
  chatId?: string | null
}

export type TelegramConfigResolver = () => TelegramSavedConfig | null | undefined

function clean(value: string | null | undefined): string | undefined {
  return value && value.trim() !== '' ? value.trim() : undefined
}

/**
 * Effective Telegram config: window-saved values win over .env, blanks fall
 * through, and a broken resolver never silences alerts (it falls back to env).
 */
export function resolveTelegramConfig(
  env: Record<string, string | undefined> = process.env,
  getSaved?: TelegramConfigResolver,
): TelegramConfig | null {
  let saved: TelegramSavedConfig | null = null
  try {
    saved = getSaved?.() ?? null
  } catch {
    saved = null
  }
  const botToken = clean(saved?.botToken) ?? clean(env.TELEGRAM_BOT_TOKEN)
  const chatId = clean(saved?.chatId) ?? clean(env.TELEGRAM_CHAT_ID)
  if (!botToken || !chatId) return null
  return { botToken, chatId }
}

/**
 * Direct send with a bounded timeout. Never rejects — resolves with the
 * outcome so callers (e.g. the settings "send test" route) can report it.
 */
export async function sendTelegramMessage(
  config: TelegramConfig,
  text: string,
  timeoutMs = 8000,
): Promise<{ ok: boolean; error?: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${config.botToken}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: config.chatId,
          text,
          disable_web_page_preview: true,
        }),
        signal: controller.signal,
      },
    )
    if (!res.ok) {
      return { ok: false, error: `Telegram HTTP ${res.status}` }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  } finally {
    clearTimeout(timer)
  }
}

export function createTelegramNotifier(
  env: Record<string, string | undefined> = process.env,
  getSaved?: TelegramConfigResolver,
): Notifier {
  return async (text: string): Promise<void> => {
    const config = resolveTelegramConfig(env, getSaved)
    if (!config) return
    const result = await sendTelegramMessage(config, text)
    if (!result.ok) {
      // Alerts must never crash the trading loop.
      console.warn(`[notifier] telegram send failed: ${result.error}`)
    }
  }
}
