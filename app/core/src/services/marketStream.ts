/**
 * Upstox Market Data Feed V3 WebSocket stream for the Node.js daemon.
 *
 * Node.js can set Authorization headers directly on WebSocket connections
 * (unlike browsers), so this connects directly to the feed endpoint without
 * the authorize URL step the browser version needs.
 *
 * Subscribes to held position leg keys + India VIX, decodes protobuf
 * FeedResponse messages, and dispatches normalized LTP ticks.
 */

import { EventEmitter } from 'events'
import WebSocket from 'ws'
import protobuf from 'protobufjs'
import { readFileSync } from 'fs'
import { join } from 'path'

const FEED_URL = 'wss://api.upstox.com/v3/feed/market-data-feed'
const FEED_PACKAGE = 'com.upstox.marketdatafeederv3udapi.rpc.proto'
const INDIA_VIX_KEY = 'NSE_INDEX|India VIX'
const VIX_FRESHNESS_MS = 120_000
const RECONNECT_BASE_MS = 1000
const RECONNECT_MAX_MS = 30_000

// ─── Protobuf Schema Loading ────────────────────────────────────────────────

const WRAPPERS_PROTO =
  'syntax = "proto3";\npackage google.protobuf;\nmessage DoubleValue { double value = 1; }\n'

let feedResponseType: protobuf.Type | null = null

function getFeedResponseType(): protobuf.Type {
  if (feedResponseType) return feedResponseType
  const protoPath = join(__dirname, 'MarketDataFeedV3.proto')
  const protoText = readFileSync(protoPath, 'utf-8')
  const feedRoot = protobuf.parse(protoText, { keepCase: false }).root
  const wrappersRoot = protobuf.parse(WRAPPERS_PROTO).root
  const googleNs = wrappersRoot.lookup('google')
  if (!googleNs) throw new Error('Failed to load google.protobuf types')
  feedRoot.add(googleNs)
  feedRoot.resolveAll()
  feedResponseType = feedRoot.lookupType(`${FEED_PACKAGE}.FeedResponse`)
  return feedResponseType
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface StreamTick {
  instrumentKey: string
  ltp: number
  cp?: number
  ltt?: number
  ltq?: number
  receivedAt: number
}

export interface MarketStreamOptions {
  getToken: () => string | null
  mode?: 'ltpc' | 'full' | 'option_greeks' | 'full_d30'
  reconnectBaseMs?: number
  reconnectMaxMs?: number
}

export type StreamStatus =
  | 'idle'
  | 'connecting'
  | 'open'
  | 'reconnecting'
  | 'closed'

// ─── Stream Manager ─────────────────────────────────────────────────────────

export class UpstoxMarketStream extends EventEmitter {
  private ws: WebSocket | null = null
  private stopped = true
  private attempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private desiredKeys = new Set<string>()
  private latest = new Map<string, StreamTick>()
  private latestVixTick: { ltp: number; receivedAt: number } | null = null
  private status: StreamStatus = 'idle'
  private readonly opts: Required<Pick<MarketStreamOptions, 'mode' | 'reconnectBaseMs' | 'reconnectMaxMs'>>
  private readonly getToken: () => string | null

  constructor(options: MarketStreamOptions) {
    super()
    this.setMaxListeners(50)
    this.getToken = options.getToken
    this.opts = {
      mode: options.mode ?? 'ltpc',
      reconnectBaseMs: options.reconnectBaseMs ?? RECONNECT_BASE_MS,
      reconnectMaxMs: options.reconnectMaxMs ?? RECONNECT_MAX_MS,
    }
  }

  public getStatus(): StreamStatus {
    return this.status
  }

  public getLatestPrice(instrumentKey: string): number | null {
    return this.latest.get(instrumentKey)?.ltp ?? null
  }

  /** Returns the streamed India VIX LTP only if fresh (within 2 minutes). */
  public getStreamedVix(): number | null {
    if (!this.latestVixTick) return null
    if (Date.now() - this.latestVixTick.receivedAt > VIX_FRESHNESS_MS) return null
    return this.latestVixTick.ltp
  }

  public start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.attempt = 0
    void this.connect()
  }

  public stop(): void {
    this.stopped = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      this.removeAllWsListeners()
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close(1000, 'client stopped')
      }
      this.ws = null
    }
    this.latest.clear()
    this.latestVixTick = null
    this.setStatus('closed', 'stopped by client')
  }

  /** Idempotently syncs the desired subscription set (diffs internally). */
  public setSubscriptions(instrumentKeys: string[]): void {
    const next = new Set(instrumentKeys)
    const added: string[] = []
    const removed: string[] = []
    for (const key of next) {
      if (!this.desiredKeys.has(key)) added.push(key)
    }
    for (const key of this.desiredKeys) {
      if (!next.has(key)) removed.push(key)
    }
    this.desiredKeys = next
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    if (added.length > 0) this.sendRequest('sub', added, true)
    if (removed.length > 0) this.sendRequest('unsub', removed, false)
  }

  // ─── Internals ──────────────────────────────────────────────────────────

  private setStatus(next: StreamStatus, detail?: string): void {
    this.status = next
    this.emit('status', next, detail)
  }

  private sendRequest(method: 'sub' | 'unsub' | 'change_mode', keys: string[], withMode: boolean): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    const data: Record<string, unknown> = { instrumentKeys: keys }
    if (withMode) data.mode = this.opts.mode
    const request = {
      guid: `daemon-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      method,
      data,
    }
    this.ws.send(JSON.stringify(request), { binary: true })
  }

  private computeReconnectDelay(): number {
    const exp = Math.min(Math.max(this.attempt, 1), 20)
    return Math.min(this.opts.reconnectBaseMs * Math.pow(2, exp - 1), this.opts.reconnectMaxMs)
  }

  private scheduleReconnect(reason: string): void {
    if (this.stopped) return
    this.attempt += 1
    const delay = this.computeReconnectDelay()
    this.setStatus('reconnecting', `${reason}; retry #${this.attempt} in ${delay}ms`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.connect()
    }, delay)
  }

  private async connect(): Promise<void> {
    if (this.stopped) return
    const token = this.getToken()
    if (!token) {
      this.setStatus('closed', 'no Upstox token available')
      return
    }

    this.setStatus('connecting')

    try {
      // Node.js ws can set headers directly — no authorize URL needed.
      this.ws = new WebSocket(FEED_URL, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
      })
    } catch (error) {
      this.setStatus('closed', `WebSocket construction failed: ${(error as Error).message}`)
      return
    }

    this.ws.on('open', () => {
      this.attempt = 0
      this.setStatus('open')
      if (this.desiredKeys.size > 0) {
        this.sendRequest('sub', Array.from(this.desiredKeys), true)
      }
    })

    this.ws.on('message', (data: Buffer) => {
      try {
        const decoded = this.decodeFeed(new Uint8Array(data))
        for (const tick of decoded) {
          this.latest.set(tick.instrumentKey, tick)
          if (tick.instrumentKey === INDIA_VIX_KEY) {
            this.latestVixTick = { ltp: tick.ltp, receivedAt: tick.receivedAt }
          }
          this.emit('tick', tick)
        }
      } catch {
        // Malformed frames must never break the stream.
      }
    })

    this.ws.on('error', () => {
      // Handled by the close event which always fires.
    })

    this.ws.on('close', (code: number, reason: Buffer) => {
      this.ws = null
      if (this.stopped) return
      this.scheduleReconnect(
        `WebSocket closed (code ${code}${reason.length > 0 ? `: ${reason.toString()}` : ''})`,
      )
    })
  }

  private decodeFeed(bytes: Uint8Array): StreamTick[] {
    const FeedResponse = getFeedResponseType()
    const message = FeedResponse.decode(bytes)
    const obj = FeedResponse.toObject(message, {
      longs: String,
      defaults: false,
    }) as {
      type?: number
      feeds?: Record<string, {
        ltpc?: { ltp?: number; cp?: number; ltt?: string; ltq?: string }
        fullFeed?: {
          marketFF?: { ltpc?: { ltp?: number; cp?: number; ltt?: string; ltq?: string } }
          indexFF?: { ltpc?: { ltp?: number; cp?: number; ltt?: string; ltq?: string } }
        }
        firstLevelWithGreeks?: { ltpc?: { ltp?: number; cp?: number; ltt?: string; ltq?: string } }
      } | undefined>
      currentTs?: string
    }

    const ticks: StreamTick[] = []
    for (const [instrumentKey, feed] of Object.entries(obj.feeds ?? {})) {
      if (!feed) continue
      const ltpc =
        feed.ltpc ??
        feed.fullFeed?.indexFF?.ltpc ??
        feed.fullFeed?.marketFF?.ltpc ??
        feed.firstLevelWithGreeks?.ltpc
      if (!ltpc || typeof ltpc.ltp !== 'number' || !Number.isFinite(ltpc.ltp)) continue
      const tick: StreamTick = {
        instrumentKey,
        ltp: ltpc.ltp,
        receivedAt: Date.now(),
      }
      if (typeof ltpc.cp === 'number') tick.cp = ltpc.cp
      const ltt = ltpc.ltt ? Number(ltpc.ltt) : NaN
      if (Number.isFinite(ltt)) tick.ltt = ltt
      const ltq = ltpc.ltq ? Number(ltpc.ltq) : NaN
      if (Number.isFinite(ltq)) tick.ltq = ltq
      ticks.push(tick)
    }
    return ticks
  }

  private removeAllWsListeners(): void {
    if (!this.ws) return
    this.ws.removeAllListeners('open')
    this.ws.removeAllListeners('message')
    this.ws.removeAllListeners('error')
    this.ws.removeAllListeners('close')
  }
}
