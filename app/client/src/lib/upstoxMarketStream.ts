/**
 * Upstox Market Data Feed V3 WebSocket stream.
 *
 * Connection flow (browser-safe):
 *  1. POST /api/market/feed-authorize with the Upstox access token; the Worker
 *     exchanges it for a one-time-use `authorized_redirect_uri` (browsers
 *     cannot set Authorization headers on a WebSocket handshake).
 *  2. Connect the WebSocket directly to that signed URL.
 *  3. Subscribe by sending JSON requests as BINARY frames.
 *  4. Decode binary protobuf `FeedResponse` messages and expose normalized
 *     LTP ticks per instrument key.
 *
 * Docs: https://upstox.com/developer/api-documentation/v3/get-market-data-feed
 * Schema: https://assets.upstox.com/feed/market-data-feed/v3/MarketDataFeed.proto
 */

import protobuf from 'protobufjs'
import protoText from './upstoxMarketFeedV3.proto?raw'
import { API_MARKET_FEED_AUTHORIZE } from './constants'

const FEED_PACKAGE = 'com.upstox.marketdatafeederv3udapi.rpc.proto'

/**
 * The feed schema imports google/protobuf/wrappers.proto solely for the
 * optional `iep` (indicative equilibrium price) DoubleValue wrapper. The
 * official .proto file ships unmodified; the well-known type is grafted in
 * at parse time so no network fetch or bundler plugin is needed.
 */
const WELL_KNOWN_WRAPPERS_PROTO =
  'syntax = "proto3";\npackage google.protobuf;\nmessage DoubleValue { double value = 1; }\n'

let feedResponseType: protobuf.Type | null = null

/** Loads (once) and returns the decoded FeedResponse protobuf type. */
export function getFeedResponseType(): protobuf.Type {
  if (feedResponseType) return feedResponseType
  const feedRoot = protobuf.parse(protoText, { keepCase: false }).root
  const wrappersRoot = protobuf.parse(WELL_KNOWN_WRAPPERS_PROTO).root
  const googleNamespace = wrappersRoot.lookup('google')
  if (!googleNamespace) {
    throw new Error('Failed to load google.protobuf well-known types')
  }
  feedRoot.add(googleNamespace)
  feedRoot.resolveAll()
  feedResponseType = feedRoot.lookupType(`${FEED_PACKAGE}.FeedResponse`)
  return feedResponseType
}

// ─── Decoded protobuf shapes (camelCase via keepCase: false) ────────────────

interface DecodedLtpc {
  ltp?: number
  ltt?: string
  ltq?: string
  cp?: number
  iep?: { value?: number }
}

interface DecodedFeed {
  ltpc?: DecodedLtpc
  fullFeed?: {
    marketFF?: { ltpc?: DecodedLtpc }
    indexFF?: { ltpc?: DecodedLtpc }
  }
  firstLevelWithGreeks?: { ltpc?: DecodedLtpc }
}

interface DecodedFeedResponse {
  /** 0 = initial_feed, 1 = live_feed, 2 = market_info */
  type?: number
  feeds?: Record<string, DecodedFeed | undefined>
  currentTs?: string
  marketInfo?: unknown
}

// ─── Public types ────────────────────────────────────────────────────────────

export type UpstoxStreamStatus =
  | 'idle'
  | 'connecting'
  | 'open'
  | 'reconnecting'
  | 'closed'

export type UpstoxStreamMethod = 'sub' | 'unsub' | 'change_mode'

export type UpstoxStreamMode = 'ltpc' | 'full' | 'option_greeks' | 'full_d30'

export interface UpstoxStreamTick {
  instrumentKey: string
  ltp: number
  cp?: number
  ltt?: number
  ltq?: number
  receivedAt: number
}

export interface NormalizedFeed {
  type: 'market_info' | 'initial_feed' | 'live_feed'
  currentTs?: number
  ticks: UpstoxStreamTick[]
}

// ─── Pure helpers (unit tested) ─────────────────────────────────────────────

export function buildStreamRequest(
  method: UpstoxStreamMethod,
  instrumentKeys: string[],
  mode?: UpstoxStreamMode,
  guid?: string,
): Uint8Array {
  const data: Record<string, unknown> = { instrumentKeys }
  if (mode) data.mode = mode
  const request: Record<string, unknown> = {
    guid: guid ?? newGuid(),
    method,
    data,
  }
  return new TextEncoder().encode(JSON.stringify(request))
}

function newGuid(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `stream-${Date.now()}-${Math.random().toString(36).slice(2)}`
  )
}

export function decodeFeedResponse(bytes: Uint8Array): DecodedFeedResponse {
  const FeedResponse = getFeedResponseType()
  const message = FeedResponse.decode(bytes)
  return FeedResponse.toObject(message, {
    longs: String,
    defaults: false,
  })
}

/**
 * Flattens a decoded FeedResponse into normalized ticks. Handles all feed
 * variants: `ltpc` mode, `full`/`full_d30` (index and market), and
 * `option_greeks` first-level feeds.
 */
export function normalizeFeed(
  message: {
    type?: number
    feeds?: Record<string, DecodedFeed | undefined>
    currentTs?: string
  },
  receivedAt: number,
): NormalizedFeed {
  const type: NormalizedFeed['type'] =
    message.type === 2
      ? 'market_info'
      : message.type === 0
        ? 'initial_feed'
        : 'live_feed'

  const ticks: UpstoxStreamTick[] = []
  for (const [instrumentKey, feed] of Object.entries(message.feeds ?? {})) {
    if (!feed) continue
    const ltpc =
      feed.ltpc ??
      feed.fullFeed?.indexFF?.ltpc ??
      feed.fullFeed?.marketFF?.ltpc ??
      feed.firstLevelWithGreeks?.ltpc
    if (!ltpc || typeof ltpc.ltp !== 'number' || !Number.isFinite(ltpc.ltp))
      continue

    const tick: UpstoxStreamTick = {
      instrumentKey,
      ltp: ltpc.ltp,
      receivedAt,
    }
    if (typeof ltpc.cp === 'number') tick.cp = ltpc.cp
    const ltt = ltpc.ltt ? Number(ltpc.ltt) : NaN
    if (Number.isFinite(ltt)) tick.ltt = ltt
    const ltq = ltpc.ltq ? Number(ltpc.ltq) : NaN
    if (Number.isFinite(ltq)) tick.ltq = ltq
    ticks.push(tick)
  }

  const currentTs = message.currentTs ? Number(message.currentTs) : NaN
  return {
    type,
    currentTs: Number.isFinite(currentTs) ? currentTs : undefined,
    ticks,
  }
}

/**
 * Exponential reconnect backoff: 1s, 2s, 4s, ... capped at maxMs.
 */
export function computeReconnectDelay(
  attempt: number,
  baseMs = 1000,
  maxMs = 30000,
): number {
  const exp = Math.min(Math.max(attempt, 1), 20)
  const delay = baseMs * Math.pow(2, exp - 1)
  return Math.min(delay, maxMs)
}

// ─── Stream manager ─────────────────────────────────────────────────────────

export interface UpstoxStreamOptions {
  getToken: () => string | null
  onTick: (tick: UpstoxStreamTick) => void
  onStatus?: (status: UpstoxStreamStatus, detail?: string) => void
  mode?: UpstoxStreamMode
  reconnectBaseMs?: number
  reconnectMaxMs?: number
}

export interface UpstoxMarketStream {
  start: () => void
  stop: () => void
  /** Idempotently sync the desired subscription set; diffs are sent as sub/unsub frames. */
  setSubscriptions: (instrumentKeys: string[]) => void
  getLatestPrice: (instrumentKey: string) => number | null
  getStatus: () => UpstoxStreamStatus
}

export function createUpstoxMarketStream(
  options: UpstoxStreamOptions,
): UpstoxMarketStream {
  const mode = options.mode ?? 'ltpc'
  const reconnectBaseMs = options.reconnectBaseMs ?? 1000
  const reconnectMaxMs = options.reconnectMaxMs ?? 30000

  let ws: WebSocket | null = null
  let status: UpstoxStreamStatus = 'idle'
  let stopped = true
  let attempt = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null

  const desiredKeys = new Set<string>()
  const latest = new Map<string, UpstoxStreamTick>()

  function setStatus(next: UpstoxStreamStatus, detail?: string) {
    status = next
    options.onStatus?.(next, detail)
  }

  function sendRequest(
    method: UpstoxStreamMethod,
    keys: string[],
    withMode: boolean,
  ) {
    if (ws?.readyState !== WebSocket.OPEN) return
    ws.send(buildStreamRequest(method, keys, withMode ? mode : undefined))
  }

  function syncSubscriptions() {
    if (ws?.readyState !== WebSocket.OPEN) return
    const keys = Array.from(desiredKeys)
    if (keys.length === 0) return
    sendRequest('sub', keys, true)
  }

  function scheduleReconnect(reason: string) {
    if (stopped) return
    attempt += 1
    const delay = computeReconnectDelay(
      attempt,
      reconnectBaseMs,
      reconnectMaxMs,
    )
    setStatus('reconnecting', `${reason}; retry #${attempt} in ${delay}ms`)
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      void connect()
    }, delay)
  }

  async function connect() {
    if (stopped) return
    const token = options.getToken()
    if (!token) {
      setStatus('closed', 'no Upstox token available')
      return
    }

    setStatus('connecting')

    let url: string | null
    try {
      const response = await fetch(API_MARKET_FEED_AUTHORIZE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      })
      if (!response.ok) {
        // Authorization failures are fatal (invalid/expired token); do not
        // retry-loop against the broker API.
        setStatus(
          'closed',
          `feed authorization failed (HTTP ${response.status})`,
        )
        return
      }
      const data = (await response.json().catch(() => null)) as {
        url?: string
      } | null
      url = data?.url ?? null
    } catch (error) {
      setStatus(
        'closed',
        `feed authorization request failed: ${(error as Error).message}`,
      )
      return
    }
    if (!url?.startsWith('wss://')) {
      setStatus('closed', 'feed authorization returned an invalid URL')
      return
    }
    if (stopped) return

    try {
      ws = new WebSocket(url)
    } catch (error) {
      setStatus(
        'closed',
        `WebSocket construction failed: ${(error as Error).message}`,
      )
      return
    }
    ws.binaryType = 'arraybuffer'

    ws.onopen = () => {
      attempt = 0
      setStatus('open')
      syncSubscriptions()
    }

    ws.onmessage = (event: MessageEvent) => {
      const data: unknown = event.data
      if (!(data instanceof ArrayBuffer)) return
      try {
        const decoded = decodeFeedResponse(new Uint8Array(data))
        const feed = normalizeFeed(decoded, Date.now())
        for (const tick of feed.ticks) {
          latest.set(tick.instrumentKey, tick)
          options.onTick(tick)
        }
      } catch {
        // Malformed frames must never break the stream; drop them.
      }
    }

    ws.onerror = () => {
      // Handled via onclose which always fires for failed connections.
    }

    ws.onclose = (event: CloseEvent) => {
      ws = null
      if (stopped) return
      scheduleReconnect(
        `WebSocket closed (code ${event.code}${event.reason ? `: ${event.reason}` : ''})`,
      )
    }
  }

  return {
    start() {
      if (!stopped) return
      stopped = false
      attempt = 0
      void connect()
    },
    stop() {
      stopped = true
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      if (ws) {
        ws.onopen = null
        ws.onmessage = null
        ws.onerror = null
        ws.onclose = null
        if (
          ws.readyState === WebSocket.OPEN ||
          ws.readyState === WebSocket.CONNECTING
        ) {
          ws.close(1000, 'client stopped')
        }
        ws = null
      }
      latest.clear()
      setStatus('closed', 'stopped by client')
    },
    setSubscriptions(instrumentKeys: string[]) {
      const next = new Set(instrumentKeys)
      const added: string[] = []
      const removed: string[] = []
      for (const key of next) {
        if (!desiredKeys.has(key)) added.push(key)
      }
      for (const key of desiredKeys) {
        if (!next.has(key)) removed.push(key)
      }
      desiredKeys.clear()
      for (const key of next) desiredKeys.add(key)

      if (ws?.readyState !== WebSocket.OPEN) return
      if (added.length > 0) sendRequest('sub', added, true)
      if (removed.length > 0) sendRequest('unsub', removed, false)
    },
    getLatestPrice(instrumentKey: string) {
      return latest.get(instrumentKey)?.ltp ?? null
    },
    getStatus() {
      return status
    },
  }
}
