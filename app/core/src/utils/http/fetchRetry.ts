/**
 * Fetch wrapper with 429/Retry-After handling and a hard timeout for the
 * daemon.
 *
 * Retries once on HTTP 429 (Too Many Requests) after waiting the
 * server-recommended delay (from the Retry-After header, capped at 10
 * seconds). Falls back to a 2-second default when the header is missing.
 *
 * Fail-closed note: every attempt is bounded by a timeout (default 10s) so a
 * hung Upstox endpoint can never stall the ingestion loop — a timeout throws
 * and the caller marks the data source as faulted instead of silently
 * trading on stale sentiment.
 */

const MAX_429_WAIT_SEC = 10
const DEFAULT_429_WAIT_SEC = 2
const DEFAULT_TIMEOUT_MS = 10_000

export function parseRetryAfterSec(response: Response): number {
  const raw = response.headers.get('Retry-After')
  if (!raw) return DEFAULT_429_WAIT_SEC
  const sec = parseInt(raw, 10)
  if (!Number.isFinite(sec) || sec < 0) return DEFAULT_429_WAIT_SEC
  return Math.min(sec, MAX_429_WAIT_SEC)
}

// After two consecutive 429s, cool down before touching the endpoint again
// — the fixed 2s retry synchronized with the poll cadence and hammered the
// rate limiter into a persistent 429 lock (the quotes/VIX stale for minutes).
let rateLimitCooldownUntil = 0

/** Hard per-attempt timeout so a hung endpoint can never stall the tick. */
async function fetchWithTimeout(
  input: string | URL,
  init: RequestInit | undefined,
  timeoutMs: number,
): Promise<Response> {
  if (init?.signal || timeoutMs <= 0) return fetch(input, init)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(input, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchWithRetry(
  input: string | URL,
  init?: RequestInit,
  opts?: { timeoutMs?: number },
): Promise<Response> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS

  if (Date.now() < rateLimitCooldownUntil) {
    // Synthetic 429 — callers treat it exactly like a real one (the data
    // stays stale, the gates block) without hitting the rate limiter.
    return new Response(
      JSON.stringify({ status: 'error', reason: 'rate-limit cooldown' }),
      {
        status: 429,
        headers: { 'content-type': 'application/json' },
      },
    )
  }

  let res = await fetchWithTimeout(input, init, timeoutMs)

  if (res.status === 429) {
    const waitSec = parseRetryAfterSec(res)
    console.warn(`[fetch] 429 rate-limited, retrying in ${waitSec}s...`)
    await new Promise((resolve) => setTimeout(resolve, waitSec * 1000))
    res = await fetchWithTimeout(input, init, timeoutMs)
    if (res.status === 429) {
      rateLimitCooldownUntil = Date.now() + 15_000
      console.warn('[fetch] 429 persists — cooling down 15s')
    }
  }

  return res
}
