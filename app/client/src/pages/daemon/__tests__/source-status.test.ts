import { describe, it, expect } from 'vitest'
import type { DaemonHealth, DaemonWsFeedStats } from '@/lib/daemon'
import type { VrdData } from '@/lib/types'
import { deriveSourceStatus } from '../source-status'

function makeWs(overrides: Partial<DaemonWsFeedStats> = {}): DaemonWsFeedStats {
  return {
    state: 'open',
    activeForMs: 60_000,
    frames: {
      initial: 1,
      live: 100,
      marketInfo: 5,
      other: 0,
      decodeErrors: 0,
    },
    ticks: { index: 120, option: 80 },
    optionKeys: { current: 10, peak: 12 },
    reconnects: 0,
    chain: { calls: 4, failures: 0, lastLatencyMs: 120 },
    expiry: { calls: 1, failures: 0 },
    lastMessageAgeMs: 500,
    ...overrides,
  }
}

function makeHealth(
  source: string,
  wsOverrides: Partial<DaemonWsFeedStats> = {},
): DaemonHealth {
  return {
    status: 'ok',
    timestamp: new Date().toISOString(),
    feed: { source, ws: makeWs(wsOverrides) },
  }
}

function makeVrd(overrides: Partial<VrdData> = {}): VrdData {
  return {
    mmi: null,
    advancesDeclines: null,
    fiiLongShort: null,
    fiiPositioning: null,
    pcr: null,
    straddleIv: null,
    niftyPe: null,
    vix: null,
    giftNifty: null,
    supportWall: null,
    resistanceWall: null,
    maxPain: null,
    fetchedAt: new Date().toISOString(),
    ...overrides,
  }
}

describe('deriveSourceStatus — mock feed', () => {
  it('marks live-transport sources ok', () => {
    const status = deriveSourceStatus(makeHealth('mock'), makeVrd())
    expect(status.candles).toBe('ok')
    expect(status['option-chain']).toBe('ok')
    expect(status['synthetic/value']).toBe('ok')
  })
})

describe('deriveSourceStatus — live feed', () => {
  it('reports ok when ws is open and ticks flow', () => {
    const status = deriveSourceStatus(
      makeHealth('upstox-ws-v3'),
      makeVrd({ vix: 13.5 }),
    )
    expect(status.candles).toBe('ok')
    expect(status['option-chain']).toBe('ok')
    expect(status.vix).toBe('ok')
  })

  it('reports pending when no index ticks have arrived yet', () => {
    const status = deriveSourceStatus(
      makeHealth('upstox-ws-v3', { ticks: { index: 0, option: 0 } }),
      makeVrd(),
    )
    expect(status.candles).toBe('pending')
  })

  it('reports stale when the socket dropped', () => {
    const status = deriveSourceStatus(
      makeHealth('upstox-ws-v3', { state: 'closed' }),
      makeVrd(),
    )
    expect(status.candles).toBe('stale')
  })

  it('reports pending before the first option-chain response', () => {
    const status = deriveSourceStatus(
      makeHealth('upstox-ws-v3', {
        chain: { calls: 0, failures: 0, lastLatencyMs: null },
      }),
      makeVrd(),
    )
    expect(status['option-chain']).toBe('pending')
  })

  it('reports stale when the option chain is failing', () => {
    const status = deriveSourceStatus(
      makeHealth('upstox-ws-v3', {
        chain: { calls: 4, failures: 2, lastLatencyMs: 300 },
      }),
      makeVrd(),
    )
    expect(status['option-chain']).toBe('stale')
  })
})

describe('deriveSourceStatus — VRD coverage', () => {
  it('marks VRD-backed sources from the snapshot', () => {
    const status = deriveSourceStatus(
      makeHealth('upstox-ws-v3'),
      makeVrd({
        vix: 12.4,
        advancesDeclines: {
          advances: 1200,
          declines: 800,
          ratio: 1.5,
          label: 'Bullish',
        },
        giftNifty: {
          price: 22_350,
          changePts: 40,
          changePct: 0.18,
          openingSignal: 'Gap Up',
        },
        fiiLongShort: { longPct: 55, shortPct: 45, shortPctTrend: 'Falling' },
        pcr: { value: 1.1, zone: 'Neutral' },
        maxPain: 22_200,
      }),
    )
    expect(status.breadth).toBe('ok')
    expect(status['global-sentiment']).toBe('ok')
    expect(status['upstox/fii']).toBe('ok')
    expect(status['upstox/pcr']).toBe('ok')
    expect(status['upstox/max-pain']).toBe('ok')
  })

  it('reports unknown when no VRD snapshot exists', () => {
    const status = deriveSourceStatus(makeHealth('upstox-ws-v3'), null)
    expect(status.vix).toBe('unknown')
    expect(status.breadth).toBe('unknown')
    expect(status['global-sentiment']).toBe('unknown')
    expect(status['upstox/pcr']).toBe('unknown')
  })

  it('handles a null health payload', () => {
    const status = deriveSourceStatus(null, null)
    expect(status.candles).toBe('stale')
    expect(status['option-chain']).toBe('pending')
    expect(status['synthetic/value']).toBe('unknown')
  })
})
