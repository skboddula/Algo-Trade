/**
 * Minimal Telegram notifier used for always-on operation alerts.
 *
 * The notifier is a no-op unless both TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID
 * are configured, so tests and local runs are unaffected.
 *
 * Alerts currently sent:
 *   - daemon started / stopping
 *   - market feed down (after repeated failed ticks) / recovered
 *   - position opened / closed (paper + live)
 */

export type Notifier = (text: string) => Promise<void>

export function createTelegramNotifier(
  env: Record<string, string | undefined> = process.env,
): Notifier {
  const botToken = env.TELEGRAM_BOT_TOKEN?.trim()
  const chatId = env.TELEGRAM_CHAT_ID?.trim()

  if (!botToken || !chatId) {
    return async () => {}
  }

  const url = `https://api.telegram.org/bot${botToken}/sendMessage`

  return async (text: string): Promise<void> => {
    // Bounded send: a hung Telegram call must never pile up behind the loop.
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8000)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          disable_web_page_preview: true,
        }),
        signal: controller.signal,
      })
      if (!res.ok) {
        console.warn(`[notifier] telegram send failed: HTTP ${res.status}`)
      }
    } catch (err) {
      // Alerts must never crash the trading loop.
      console.warn(`[notifier] telegram send error: ${(err as Error).message}`)
    } finally {
      clearTimeout(timer)
    }
  }
}
