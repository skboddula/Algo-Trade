import { describe, it, expect } from 'vitest'

import {
  buildStreamRequest,
  computeReconnectDelay,
  decodeFeedResponse,
  getFeedResponseType,
  normalizeFeed,
} from '../upstoxMarketStream'

describe('upstoxMarketStream proto pipeline', () => {
  it('loads the official MarketDataFeedV3 schema and round-trips option LTPC feeds', () => {
    const FeedResponse = getFeedResponseType()
    expect(Object.keys(FeedResponse.fields).sort()).toEqual([
      'currentTs',
      'feeds',
      'marketInfo',
      'type',
    ])

    const payload = {
      type: 1,
      feeds: {
        'NSE_FO|53557': {
          ltpc: {
            ltp: 550.25,
            ltt: '1791147858000',
            ltq: '75',
            cp: 494.05,
            iep: { value: 100 },
          },
        },
      },
      currentTs: '1791147858001',
    }

    const bytes = FeedResponse.encode(FeedResponse.fromObject(payload)).finish()
    const decoded = decodeFeedResponse(bytes)
    const feed = normalizeFeed(decoded, 1791147858999)

    expect(feed.type).toBe('live_feed')
    expect(feed.currentTs).toBe(1791147858001)
    expect(feed.ticks).toHaveLength(1)
    expect(feed.ticks[0]).toEqual({
      instrumentKey: 'NSE_FO|53557',
      ltp: 550.25,
      cp: 494.05,
      ltt: 1791147858000,
      ltq: 75,
      receivedAt: 1791147858999,
    })
  })

  it('round-trips full-mode index feeds (SENSEX)', () => {
    const FeedResponse = getFeedResponseType()
    const payload = {
      type: 1,
      feeds: {
        'BSE_INDEX|SENSEX': {
          fullFeed: {
            indexFF: {
              ltpc: { ltp: 81000.5, cp: 80500, ltt: '1791147858000' },
            },
          },
        },
      },
    }
    const bytes = FeedResponse.encode(FeedResponse.fromObject(payload)).finish()
    const feed = normalizeFeed(decodeFeedResponse(bytes), 1)

    expect(feed.ticks).toHaveLength(1)
    expect(feed.ticks[0].instrumentKey).toBe('BSE_INDEX|SENSEX')
    expect(feed.ticks[0].ltp).toBe(81000.5)
    expect(feed.ticks[0].cp).toBe(80500)
  })

  it('round-trips full-mode market feeds (options with greeks metadata)', () => {
    const FeedResponse = getFeedResponseType()
    const payload = {
      type: 1,
      feeds: {
        'NSE_FO|53558': {
          fullFeed: {
            marketFF: {
              ltpc: { ltp: 42.5 },
              oi: 1200000,
              iv: 12.34,
            },
          },
        },
      },
    }
    const bytes = FeedResponse.encode(FeedResponse.fromObject(payload)).finish()
    const feed = normalizeFeed(decodeFeedResponse(bytes), 2)

    expect(feed.ticks).toHaveLength(1)
    expect(feed.ticks[0].ltp).toBe(42.5)
  })

  it('classifies market_info messages without emitting ticks', () => {
    const FeedResponse = getFeedResponseType()
    const payload = {
      type: 2,
      marketInfo: {
        segmentStatus: { NSE_FO: 'NORMAL_OPEN' },
      },
      currentTs: '1791147858000',
    }
    const bytes = FeedResponse.encode(FeedResponse.fromObject(payload)).finish()
    const feed = normalizeFeed(decodeFeedResponse(bytes), 3)

    expect(feed.type).toBe('market_info')
    expect(feed.ticks).toHaveLength(0)
  })

  it('classifies initial snapshot feeds', () => {
    const feed = normalizeFeed(
      { type: 0, feeds: { 'NSE_FO|1': { ltpc: { ltp: 1.5 } } } },
      5,
    )
    expect(feed.type).toBe('initial_feed')
    expect(feed.ticks[0].ltp).toBe(1.5)
  })
})

describe('normalizeFeed edge handling', () => {
  it('skips feeds with missing or invalid LTP values', () => {
    const feed = normalizeFeed(
      {
        type: 1,
        feeds: {
          'NSE_FO|bad': { ltpc: {} },
          'NSE_FO|none': { ltpc: { ltp: 0 } },
          'NSE_FO|empty': {},
        },
      },
      1,
    )
    // ltp 0 is a valid price and must be preserved
    expect(feed.ticks).toHaveLength(1)
    expect(feed.ticks[0].instrumentKey).toBe('NSE_FO|none')
    expect(feed.ticks[0].ltp).toBe(0)
  })

  it('reads LTPC from firstLevelWithGreeks feeds', () => {
    const feed = normalizeFeed(
      {
        type: 1,
        feeds: {
          'NSE_FO|9': { firstLevelWithGreeks: { ltpc: { ltp: 9.75, cp: 10 } } },
        },
      },
      1,
    )
    expect(feed.ticks[0].ltp).toBe(9.75)
    expect(feed.ticks[0].cp).toBe(10)
  })

  it('handles absent currentTs gracefully', () => {
    const feed = normalizeFeed({ type: 1, feeds: {} }, 1)
    expect(feed.currentTs).toBeUndefined()
    expect(feed.ticks).toHaveLength(0)
  })
})

describe('buildStreamRequest', () => {
  it('produces binary JSON subscribe requests with guid, method, mode, keys', () => {
    const bytes = buildStreamRequest(
      'sub',
      ['NSE_FO|53557', 'BSE_INDEX|SENSEX'],
      'ltpc',
      'test-guid',
    )
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as {
      guid: string
      method: string
      data: { mode: string; instrumentKeys: string[] }
    }
    expect(parsed.guid).toBe('test-guid')
    expect(parsed.method).toBe('sub')
    expect(parsed.data.mode).toBe('ltpc')
    expect(parsed.data.instrumentKeys).toEqual([
      'NSE_FO|53557',
      'BSE_INDEX|SENSEX',
    ])
  })

  it('omits mode when not requested (unsubscribe requests)', () => {
    const bytes = buildStreamRequest('unsub', ['NSE_FO|53557'], undefined, 'g')
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Record<
      string,
      { mode?: string }
    >
    expect(parsed.data).not.toHaveProperty('mode')
  })

  it('generates a guid when none is provided', () => {
    const bytes = buildStreamRequest('sub', ['NSE_FO|53557'], 'full')
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as {
      guid: string
    }
    expect(parsed.guid.length).toBeGreaterThan(5)
  })
})

describe('computeReconnectDelay', () => {
  it('doubles per attempt starting at the base delay', () => {
    expect(computeReconnectDelay(1, 1000, 30000)).toBe(1000)
    expect(computeReconnectDelay(2, 1000, 30000)).toBe(2000)
    expect(computeReconnectDelay(3, 1000, 30000)).toBe(4000)
    expect(computeReconnectDelay(5, 1000, 30000)).toBe(16000)
  })

  it('caps at maxMs', () => {
    expect(computeReconnectDelay(6, 1000, 30000)).toBe(30000)
    expect(computeReconnectDelay(50, 1000, 30000)).toBe(30000)
  })

  it('treats non-positive attempts as the first attempt', () => {
    expect(computeReconnectDelay(0, 1000, 30000)).toBe(1000)
    expect(computeReconnectDelay(-3, 1000, 30000)).toBe(1000)
  })
})
