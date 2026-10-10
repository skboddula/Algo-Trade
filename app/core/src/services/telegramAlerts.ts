/**
 * Telegram alert builders — the BROWSER CLIENT's implementations,
 * re-exported. The client's lib/telegram.ts is the single source of truth
 * for alert wording; the daemon and the browser bot emit identical texts.
 * Never re-implement message formatting here — extend the client file.
 *
 * Only the TRANSPORT is daemon-specific (direct Telegram API over Node
 * fetch; the browser sends through the Worker proxy).
 */
export {
  buildEntryAlertMessage,
  buildExitAlertMessage,
  buildVixAlertMessage,
  buildDailySummaryMessage,
} from "../../../client/src/lib/telegram";
export type {
  TelegramAlertLeg,
  TelegramEntryAlert,
  TelegramExitAlert,
  TelegramVixAlert,
  TelegramDailySummary,
} from "../../../client/src/lib/telegram";

// ─── Node transport (daemon-only) ───────────────────────────────────────────

const TELEGRAM_API = "https://api.telegram.org";

export interface TelegramConfig {
  botToken: string;
  chatId: string;
}

export function getTelegramConfig(
  env: NodeJS.ProcessEnv = process.env,
): TelegramConfig | null {
  const botToken = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) return null;
  return { botToken, chatId };
}

/** Sends a message via the Telegram Bot API directly (no Worker proxy). */
export async function sendTelegramMessage(
  config: TelegramConfig,
  message: string,
): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(
      `${TELEGRAM_API}/bot${config.botToken}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: config.chatId, text: message }),
        signal: controller.signal,
      },
    );
    clearTimeout(timer);
    return res.ok;
  } catch (error) {
    console.error("[telegram] Failed to send:", (error as Error).message);
    return false;
  }
}
