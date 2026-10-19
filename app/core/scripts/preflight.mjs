#!/usr/bin/env node
/**
 * Pre-open preflight — runs weekdays 09:00 IST via the algo-trade-preflight
 * timer. Checks the NSE calendar (weekend/holiday), the Upstox token
 * (GET /v2/user/profile) and the daemon health endpoint, then reports a
 * one-line summary to Telegram (window-saved settings win over env — same
 * precedence as the daemon notifier).
 *
 * Usage: node preflight.mjs [--dry-run]
 */
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url)) // app/core/scripts
const APP_CORE = path.resolve(HERE, '..')
const DATA_DIR = process.env.DATA_DIR || path.join(APP_CORE, 'data')
const DRY_RUN = process.argv.includes('--dry-run')

function loadSettings(keys) {
  const out = {}
  try {
    const db = new DatabaseSync(path.join(DATA_DIR, 'algo-trade.sqlite'), { readOnly: true })
    try {
      const stmt = db.prepare('SELECT value FROM daemon_settings WHERE key = ?')
      for (const key of keys) {
        const row = stmt.get(key)
        if (row && row.value !== null && row.value !== undefined) out[key] = String(row.value)
      }
    } finally {
      db.close()
    }
  } catch (err) {
    console.error(`[preflight] settings read failed: ${err.message}`)
  }
  return out
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function checkToken(token) {
  if (!token) return 'missing'
  try {
    const res = await fetchWithTimeout(
      'https://api.upstox.com/v2/user/profile',
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } },
      8000,
    )
    if (res.ok) return 'valid'
    if (res.status === 401 || res.status === 403) return 'expired'
    return `http-${res.status}`
  } catch {
    return 'unknown'
  }
}

async function checkDaemon() {
  try {
    const res = await fetchWithTimeout('http://127.0.0.1:3000/health', {}, 3000)
    return res.ok ? 'up' : `http-${res.status}`
  } catch {
    return 'down'
  }
}

async function main() {
  const settings = loadSettings(['upstox.masterToken', 'telegram.botToken', 'telegram.chatId'])
  const token = settings['upstox.masterToken'] || process.env.PRIMARY_UPSTOX_TOKEN || ''

  // Market calendar — shared time utils (degrade gracefully if dist is missing)
  let holidayName = null
  let isMarketDay = null
  try {
    const shared = await import(
      pathToFileURL(path.join(APP_CORE, 'dist', 'packages', 'shared', 'src', 'timeUtils.js')).href
    )
    holidayName = shared.getNseHolidayName()
    isMarketDay = shared.getIndiaTime().isMarketDay
  } catch (err) {
    console.error(`[preflight] shared timeUtils unavailable: ${err.message}`)
  }

  const tokenState = await checkToken(token)
  const lines = []

  if (isMarketDay === false) {
    lines.push(
      `🌴 Market closed today${holidayName ? ` (NSE holiday: ${holidayName})` : ' (weekend)'} — no trading.`,
    )
    if (tokenState !== 'valid') {
      lines.push('🔑 Upstox token not active — refresh it before the next session.')
    }
  } else {
    const tokenLine =
      tokenState === 'valid'
        ? '✅ token valid'
        : tokenState === 'expired' || tokenState === 'missing'
          ? '⚠️ token expired — refresh before 09:15'
          : tokenState === 'unknown'
            ? '❓ token check failed (network)'
            : `⚠️ token check: ${tokenState}`
    const daemonState = await checkDaemon()
    const daemonLine = daemonState === 'up' ? '✅ daemon up' : `❌ daemon ${daemonState}`
    lines.push(`⏰ Pre-open check — ${tokenLine} · ${daemonLine}`)
  }

  const text = lines.join('\n')
  const botToken = settings['telegram.botToken'] || process.env.TELEGRAM_BOT_TOKEN
  const chatId = settings['telegram.chatId'] || process.env.TELEGRAM_CHAT_ID

  if (DRY_RUN || !botToken || !chatId) {
    console.log(`${DRY_RUN ? '[dry-run] ' : '[no telegram creds] '}${text.replace(/\n/g, ' | ')}`)
    return
  }

  try {
    const res = await fetchWithTimeout(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
      },
      8000,
    )
    console.log(res.ok ? '[preflight] sent' : `[preflight] telegram send failed: HTTP ${res.status}`)
  } catch (err) {
    console.log(`[preflight] telegram send failed: ${err.message}`)
  }
}

main().catch((err) => {
  console.error(`[preflight] fatal: ${err.stack || err.message}`)
  // Timer-friendly: never surface failures to systemd as unit errors.
  process.exitCode = 0
})
