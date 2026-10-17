import { describe, it, expect, vi, afterEach } from 'vitest'
import { MasterIngestionEngine } from '../services/masterIngestor'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('MasterIngestionEngine feed health alerts', () => {
  it('alerts once after 5 consecutive wholesale failures and once on recovery', async () => {
    const alerts: string[] = []
    const notifier = async (text: string) => {
      alerts.push(text)
    }

    // Expired token: every quote fetch responds 401
    const fetchSpy = vi.fn(async () => ({ ok: false, status: 401 }) as Response)
    vi.stubGlobal('fetch', fetchSpy)

    const engine = new MasterIngestionEngine({
      mockMode: false,
      primaryUpstoxToken: 'expired-token',
      notifier,
    })

    for (let i = 0; i < 5; i++) {
      await engine.fetchAndComputeMarketData()
    }
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toContain('feed DOWN')
    expect(alerts[0]).toContain('HTTP 401')

    // Continued failures must not re-alert
    await engine.fetchAndComputeMarketData()
    expect(alerts).toHaveLength(1)

    // Recovery → single "recovered" alert
    fetchSpy.mockImplementation(async () => ({
      ok: true,
      json: async () => ({ data: { 'NSE_INDEX:Nifty 50': { last_price: 24600 } } }),
    }) as unknown as Response)
    await engine.fetchAndComputeMarketData()
    expect(alerts).toHaveLength(2)
    expect(alerts[1]).toContain('recovered')
  })

  it('does not monitor feed health in mock mode', async () => {
    const alerts: string[] = []
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const engine = new MasterIngestionEngine({
      mockMode: true,
      notifier: async (text: string) => {
        alerts.push(text)
      },
    })

    for (let i = 0; i < 6; i++) {
      await engine.fetchAndComputeMarketData()
    }
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(alerts).toHaveLength(0)
  })
})
