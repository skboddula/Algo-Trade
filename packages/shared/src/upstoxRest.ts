/**
 * Upstox REST calls shared by the Cloudflare worker proxy (cloud dashboard)
 * and the daemon's same-origin parity routes, so both backends forward the
 * exact same upstream payloads to the pages that render them.
 */

export const UPSTOX_PROFILE_URL = 'https://api.upstox.com/v2/user/profile'
export const UPSTOX_FUNDS_URL = 'https://api.upstox.com/v3/user/get-funds-and-margin'

/** Keep in sync with the worker proxy timeout. */
const DEFAULT_TIMEOUT_MS = 8000

export type UpstoxRestErrorKind = 'network' | 'invalid-response'

export class UpstoxRestError extends Error {
  kind: UpstoxRestErrorKind

  constructor(kind: UpstoxRestErrorKind, message: string) {
    super(message)
    this.name = 'UpstoxRestError'
    this.kind = kind
  }
}

export interface UpstoxRestResult<T = unknown> {
  /** Upstream HTTP status; the payload is forwarded untouched. */
  status: number
  data: T
}

async function requestUpstoxJson<T>(
  url: string,
  token: string,
  headers: Record<string, string> = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<UpstoxRestResult<T>> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let upstream: Response
  try {
    upstream = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...headers,
      },
      signal: controller.signal,
    })
  } catch {
    throw new UpstoxRestError('network', 'Failed to reach Upstox API')
  } finally {
    clearTimeout(timer)
  }

  let data: unknown
  try {
    data = await upstream.json()
  } catch {
    throw new UpstoxRestError('invalid-response', 'Invalid response from Upstox API')
  }
  return { status: upstream.status, data: data as T }
}

/** Upstox v2 `GET /user/profile` — identity of the token's account. */
export function fetchUpstoxProfile<T = unknown>(
  token: string,
  timeoutMs?: number,
): Promise<UpstoxRestResult<T>> {
  return requestUpstoxJson<T>(UPSTOX_PROFILE_URL, token, {}, timeoutMs)
}

/** Upstox v3 `GET /user/get-funds-and-margin` (requires `Api-Version: 3.0`). */
export function fetchUpstoxFunds<T = unknown>(
  token: string,
  timeoutMs?: number,
): Promise<UpstoxRestResult<T>> {
  return requestUpstoxJson<T>(UPSTOX_FUNDS_URL, token, { 'Api-Version': '3.0' }, timeoutMs)
}
