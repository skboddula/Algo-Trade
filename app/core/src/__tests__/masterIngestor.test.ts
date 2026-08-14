import { describe, it, expect, vi } from 'vitest'
import { MasterIngestionEngine } from '../services/masterIngestor'

describe('Master Ingestion Engine Suite (1-Fetch Shared Ingestor)', () => {
  it('initializes and computes snapshots for all tracked underlying symbols in mock mode', async () => {
    const ingestor = new MasterIngestionEngine({ mockMode: true, pollingIntervalMs: 1000 })
    await ingestor.fetchAndComputeMarketData()

    const niftySnapshot = ingestor.getSnapshot('NIFTY 50')
    const bankNiftySnapshot = ingestor.getSnapshot('BANKNIFTY')
    const finNiftySnapshot = ingestor.getSnapshot('FINNIFTY')

    expect(niftySnapshot).toBeDefined()
    expect(niftySnapshot?.spotPrice).toBeGreaterThan(20000)
    expect(niftySnapshot?.candles.length).toBeGreaterThanOrEqual(50)
    expect(niftySnapshot?.indicators).toBeDefined()
    expect(niftySnapshot?.signal).toBeDefined()

    expect(bankNiftySnapshot).toBeDefined()
    expect(bankNiftySnapshot?.spotPrice).toBeGreaterThan(40000)

    expect(finNiftySnapshot).toBeDefined()
  })

  it('emits marketTick event on every fetch with all symbol snapshots', async () => {
    const ingestor = new MasterIngestionEngine({ mockMode: true })
    const tickHandler = vi.fn()
    ingestor.on('marketTick', tickHandler)

    await ingestor.fetchAndComputeMarketData()

    expect(tickHandler).toHaveBeenCalledTimes(1)
    const emittedData = tickHandler.mock.calls[0][0]
    expect(emittedData.timestamp).toBeDefined()
    expect(emittedData.snapshots['NIFTY 50']).toBeDefined()
    expect(emittedData.snapshots['BANKNIFTY']).toBeDefined()
    expect(emittedData.snapshots['FINNIFTY']).toBeDefined()
  })

  it('maintains and retrieves option chains for strike resolution', async () => {
    const ingestor = new MasterIngestionEngine({ mockMode: true })
    await ingestor.fetchAndComputeMarketData()

    const chain = ingestor.getOptionChain('NIFTY 50')
    expect(chain.length).toBeGreaterThan(0)
    expect(chain[0].call_options.instrument_key).toBeDefined()
    expect(chain[0].put_options.instrument_key).toBeDefined()
  })

  it('stops timer cleanly on stop() call', () => {
    const ingestor = new MasterIngestionEngine({ mockMode: true, pollingIntervalMs: 50 })
    ingestor.start()
    expect((ingestor as any).isRunning).toBe(true)

    ingestor.stop()
    expect((ingestor as any).isRunning).toBe(false)
    expect((ingestor as any).timer).toBeNull()
  })
})
