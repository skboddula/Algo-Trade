/**
 * Fetch wrapper with 429/Retry-After handling for the daemon.
 *
 * Retries once on HTTP 429 (Too Many Requests) after waiting the
 * server-recommended delay (from the Retry-After header, capped at 10
 * seconds). Falls back to a 2-second default when the header is missing.
 */

const MAX_429_WAIT_SEC = 10
const DEFAULT_429_WAIT_SEC = 2

export function parseRetryAfterSec(response: Response): number {
  const raw = response.headers.get('Retry-After')
  if (!raw) return DEFAULT_429_WAIT_SEC
  const sec = parseInt(raw, 10)
  if (!Number.isFinite(sec) || sec < 0) return DEFAULT_429_WAIT_SEC
  return Math.min(sec, MAX_429_WAIT_SEC)
}

export async function fetchWithRetry(
  input: string | URL,
  init?: RequestInit,
): Promise<Response> {
  let res = await fetch(input, init)

  if (res.status === 429) {
    const waitSec = parseRetryAfterSec(res)
    console.warn(`[fetch] 429 rate-limited, retrying in ${waitSec}s...`)
    await new Promise((resolve) => setTimeout(resolve, waitSec * 1000))
    res = await fetch(input, init)
  }

  return res
}
