import { describe, it, expect, vi, afterEach } from 'vitest'
import { getIndiaTime } from '../utils/timeUtils'

// CR-12: isolate the expiry cache from the REST helper so the validation
// rules can be exercised without network / WS plumbing.
vi.mock('../services/marketDataSources/upstoxOptionChain', () => ({
  fetchNearestExpiry: vi.fn(),
  fetchOptionChain: vi.fn(),
}))

import { fetchNearestExpiry } from '../services/marketDataSources/upstoxOptionChain'
import { UpstoxFeedV3Source } from '../services/marketDataSources/upstoxFeedV3Source'

const mockedFetchNearestExpiry = vi.mocked(fetchNearestExpiry)

function makeSource(): UpstoxFeedV3Source {
  return new UpstoxFeedV3Source({
    restApiBaseUrl: 'http://rest.test/v2',
    getToken: () => 'tok',
    isMarketOpen: () => true,
    optionChainRefreshMs: 0,
    onLog: () => {},
  })
}

function istDatePlusDays(days: number): string {
  const { date } = getIndiaTime()
  return new Date(date.getTime() + days * 86_400_000).toISOString().slice(0, 10)
}

function ensureExpiry(source: UpstoxFeedV3Source): Promise<string | null> {
  return (source as any).ensureExpiry('NIFTY 50', 'tok', 'NSE_INDEX|Nifty 50')
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('expiry cache validation (CR-12)', () => {
  it('rejects a same-day (0-DTE) expiry and caches the failure', async () => {
    const source = makeSource()
    mockedFetchNearestExpiry.mockResolvedValue(getIndiaTime().dateString)

    expect(await ensureExpiry(source)).toBeNull()
    // Inside EXPIRY_RETRY_MS the failed lookup is cached — no hammering.
    expect(await ensureExpiry(source)).toBeNull()
    expect(mockedFetchNearestExpiry).toHaveBeenCalledTimes(1)
  })

  it('accepts a strictly future expiry and reuses it for the day', async () => {
    const source = makeSource()
    const next = istDatePlusDays(7)
    mockedFetchNearestExpiry.mockResolvedValue(next)

    expect(await ensureExpiry(source)).toBe(next)
    expect(await ensureExpiry(source)).toBe(next)
    expect(mockedFetchNearestExpiry).toHaveBeenCalledTimes(1)
  })

  it('refetches when the cached expiry has already passed', async () => {
    const source = makeSource()
    const today = getIndiaTime().dateString
    const next = istDatePlusDays(7)
    ;(source as any).expiryCache.set('NIFTY 50', {
      date: today,
      expiry: istDatePlusDays(-1),
    })
    mockedFetchNearestExpiry.mockResolvedValue(next)

    expect(await ensureExpiry(source)).toBe(next)
    expect(mockedFetchNearestExpiry).toHaveBeenCalledTimes(1)
  })
})
