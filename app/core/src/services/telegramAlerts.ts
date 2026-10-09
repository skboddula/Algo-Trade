/**
 * Telegram alert service for the daemon.
 *
 * Sends detailed entry, exit, VIX, and daily summary alerts directly to
 * the configured Telegram chat via the Bot API (no Cloudflare Worker needed).
 *
 * Uses native fetch (available in Node.js 18+) — no external HTTP dependency.
 */

export interface TelegramConfig {
  botToken: string;
  chatId: string;
}

const TELEGRAM_API = "https://api.telegram.org";
const MAX_MESSAGE_LEN = 4000;

export function getTelegramConfig(
  env: NodeJS.ProcessEnv = process.env,
): TelegramConfig | null {
  const botToken = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) return null;
  return { botToken, chatId };
}

export async function sendTelegramMessage(
  config: TelegramConfig,
  message: string,
): Promise<boolean> {
  if (message.length > MAX_MESSAGE_LEN) {
    message = message.slice(0, MAX_MESSAGE_LEN);
  }
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

// ─── Alert formatting (matches browser version) ──────────────────────────────

export interface EntryAlertData {
  symbol: string;
  signal: string;
  confidence: string;
  executionMode: "paper" | "live";
  strikePrice?: number;
  expiry?: string;
  entryPrice: number;
  quantity: number;
  lotSize: number;
  tradeType: "buying" | "selling";
  maxProfitPct: number;
  maxLossPct: number;
  trailPct?: number;
}

export function formatEntryAlert(alert: EntryAlertData): string {
  const mode = alert.executionMode === "live" ? "LIVE" : "PAPER";
  const icon = alert.executionMode === "live" ? "🔴" : "🟢";
  const side = alert.tradeType === "selling" ? "SELL" : "BUY";
  const name = alert.strikePrice
    ? `${alert.symbol} ${alert.strikePrice} ${alert.signal === "BUY_CE" ? "CE" : "PE"}`
    : alert.symbol;

  const fmt = (v: number) => String(parseFloat(v.toFixed(2)));
  const lots =
    alert.lotSize > 0 ? Math.round(alert.quantity / alert.lotSize) : 0;

  const lines = [
    `${icon} ALGO TRADE — ${mode} ENTRY [${alert.symbol}]`,
    `${side} ${name} @ ${fmt(alert.entryPrice)}`,
    `Qty ${alert.quantity}${lots > 0 ? ` (${lots} lot${lots > 1 ? "s" : ""})` : ""}`,
  ];
  if (alert.expiry) lines.push(`Expiry: ${alert.expiry}`);

  if (alert.tradeType === "selling") {
    const sl = alert.entryPrice * (1 + alert.maxLossPct / 100);
    const target = alert.entryPrice * (1 - alert.maxProfitPct / 100);
    lines.push(
      `SL ≈ ${fmt(sl)} (+${fmt(alert.maxLossPct)}%) · Target ≈ ${fmt(target)} (−${fmt(alert.maxProfitPct)}%)`,
    );
  } else {
    const sl = alert.entryPrice * (1 - alert.maxLossPct / 100);
    const target = alert.entryPrice * (1 + alert.maxProfitPct / 100);
    lines.push(
      `SL ≈ ${fmt(sl)} (−${fmt(alert.maxLossPct)}%) · Target ≈ ${fmt(target)} (+${fmt(alert.maxProfitPct)}%)`,
    );
  }
  if (alert.trailPct && alert.trailPct > 0) {
    lines.push(`Trail: ${fmt(alert.trailPct)}% from peak`);
  }

  lines.push(`Signal: ${alert.signal} · ${alert.confidence} confidence`);
  return lines.join("\n");
}

export interface ExitAlertData {
  symbol: string;
  direction: "CE" | "PE";
  executionMode: "paper" | "live";
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  lotSize: number;
  tradeType: "buying" | "selling";
  reason: string;
  entryTime: string;
  exitTime: string;
  strikePrice?: number;
  expiry?: string;
}

export function formatExitAlert(alert: ExitAlertData): string {
  const mode = alert.executionMode === "live" ? "LIVE" : "PAPER";
  const selling = alert.tradeType === "selling";
  const pnl = selling
    ? (alert.entryPrice - alert.exitPrice) * alert.quantity
    : (alert.exitPrice - alert.entryPrice) * alert.quantity;
  const entryValue = alert.entryPrice * alert.quantity;
  const pnlPct = entryValue > 0 ? (pnl / entryValue) * 100 : 0;
  const isProfit = pnl >= 0;

  const entryMs = new Date(alert.entryTime).getTime();
  const exitMs = new Date(alert.exitTime).getTime();
  const durationMin =
    Number.isFinite(entryMs) && Number.isFinite(exitMs)
      ? Math.max(0, Math.round((exitMs - entryMs) / 60000))
      : null;

  const fmt = (v: number) => String(parseFloat(v.toFixed(2)));
  const side = selling ? "BUY (cover)" : "SELL";
  const lots =
    alert.lotSize > 0 ? Math.round(alert.quantity / alert.lotSize) : 0;
  const instrument = alert.strikePrice
    ? `${alert.symbol} ${alert.strikePrice} ${alert.direction}`
    : `${alert.symbol} ${alert.direction}`;

  const lines = [
    `${isProfit ? "🟢" : "🔴"} ALGO TRADE — ${mode} EXIT [${alert.symbol}]`,
    `${side} ${instrument} @ ${fmt(alert.exitPrice)}`,
    `Entry: ${fmt(alert.entryPrice)} · Exit: ${fmt(alert.exitPrice)}`,
    `Qty ${alert.quantity}${lots > 0 ? ` (${lots} lot${lots > 1 ? "s" : ""})` : ""}`,
  ];
  if (alert.expiry) lines.push(`Expiry: ${alert.expiry}`);
  if (durationMin !== null) {
    lines.push(
      durationMin < 60
        ? `Duration: ${durationMin} min`
        : `Duration: ${Math.floor(durationMin / 60)}h ${durationMin % 60}m`,
    );
  }
  lines.push(
    `PnL: ${isProfit ? "+" : "−"}₹${fmt(Math.abs(pnl))} (${isProfit ? "+" : "−"}${Math.abs(pnlPct).toFixed(1)}%)`,
  );
  lines.push(`Reason: ${alert.reason}`);
  lines.push(
    isProfit
      ? `✅ Close your mirrored position in the other app.`
      : `⚠️ Close your mirrored position in the other app.`,
  );
  return lines.join("\n");
}

export interface VixAlertData {
  vix: number;
  threshold: number;
}

export function formatVixAlert(alert: VixAlertData): string {
  return [
    `⚠️ VIX ALERT — India VIX at ${alert.vix.toFixed(1)}`,
    `Hard stop threshold is 25 — entries will be blocked soon.`,
    `Manage your open positions accordingly.`,
  ].join("\n");
}

export interface DailySummaryData {
  date: string;
  totalTrades: number;
  wins: number;
  losses: number;
  realizedPnl: number;
  paperBalance: number;
  bestTrade?: { symbol: string; direction: string; pnl: number };
  worstTrade?: { symbol: string; direction: string; pnl: number };
  vixLast?: number;
}

export function formatDailySummary(data: DailySummaryData): string {
  const fmt = (v: number) => `${v >= 0 ? "+" : "−"}₹${Math.abs(v).toFixed(2)}`;

  const lines = [
    `📊 DAILY SUMMARY — ${data.date}`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `Trades: ${data.totalTrades} | Wins: ${data.wins} | Losses: ${data.losses}`,
    `Realized PnL: ${fmt(data.realizedPnl)}`,
    `Paper Balance: ₹${data.paperBalance.toFixed(2)}`,
  ];
  if (data.bestTrade) {
    lines.push(
      `Best: ${data.bestTrade.symbol} ${data.bestTrade.direction} ${fmt(data.bestTrade.pnl)}`,
    );
  }
  if (data.worstTrade) {
    lines.push(
      `Worst: ${data.worstTrade.symbol} ${data.worstTrade.direction} ${fmt(data.worstTrade.pnl)}`,
    );
  }
  lines.push(`━━━━━━━━━━━━━━━━━━━━`);
  if (data.vixLast !== undefined) {
    lines.push(`VIX (last): ${data.vixLast.toFixed(1)}`);
  }
  return lines.join("\n");
}
