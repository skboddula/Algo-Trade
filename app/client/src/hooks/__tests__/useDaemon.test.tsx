import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useDaemon } from '@/hooks/useDaemon'
import type { DaemonHealth, DaemonStatus } from '@/lib/daemon'
import { DAEMON_USER_ID } from '@/lib/daemon'
import { DEFAULT_CONFIG } from '@/lib/types'
import type { MarketSnapshot, UserBotState } from '@/lib/types'

const daemonMocks = vi.hoisted(() => ({
  status: vi.fn(),
  health: vi.fn(),
  logs: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  saveConfig: vi.fn(),
  resetPaper: vi.fn(),
  exitPosition: vi.fn(),
}))

vi.mock('@/lib/daemon', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/daemon')>()
  return { ...actual, daemonApi: daemonMocks }
})

class MockWebSocket {
  static instances: MockWebSocket[] = []
  url: string
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: ((evt: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null

  constructor(url: string) {
    this.url = url
    MockWebSocket.instances.push(this)
  }

  close() {
    this.readyState = 3
  }
}

function makeUserState(overrides: Partial<UserBotState> = {}): UserBotState {
  return {
    userId: DAEMON_USER_ID,
    state: 'IDLE',
    executionMode: 'paper',
    config: DEFAULT_CONFIG,
    positions: { 'NIFTY 50': null, BANKNIFTY: null, FINNIFTY: null },
    tradesCountToday: 0,
    tradesCountPerSymbol: {},
    lastTradeDate: '2026-10-17',
    lastExitTimes: {},
    totalRealizedPnl: 0,
    paperBalance: 1_500_000,
    updatedAt: '2026-10-17T04:00:00.000Z',
    ...overrides,
  }
}

function makeStatus(overrides: Partial<DaemonStatus> = {}): DaemonStatus {
  return {
    serverTime: '2026-10-17T04:00:00.000Z',
    snapshots: {},
    userState: makeUserState(),
    paperTrades: [],
    ...overrides,
  }
}

function makeHealth(): DaemonHealth {
  return {
    status: 'healthy',
    timestamp: '2026-10-17T04:00:00.000Z',
    feed: {
      source: 'upstox-ws-v3',
      ws: {
        state: 'open',
        activeForMs: 1000,
        frames: {
          initial: 1,
          live: 10,
          marketInfo: 2,
          other: 0,
          decodeErrors: 0,
        },
        ticks: { index: 42, option: 7 },
        optionKeys: { current: 30, peak: 30 },
        reconnects: 0,
        chain: { calls: 4, failures: 0, lastLatencyMs: 120 },
        expiry: { calls: 1, failures: 0 },
        lastMessageAgeMs: 800,
      },
    },
  }
}

const snapshot = {
  timestamp: '2026-10-17T04:00:00.000Z',
  underlyingSymbol: 'NIFTY 50',
  spotPrice: 25000,
} as unknown as MarketSnapshot

describe('useDaemon', () => {
  beforeEach(() => {
    MockWebSocket.instances = []
    vi.stubGlobal('WebSocket', MockWebSocket)
    daemonMocks.status.mockReset()
    daemonMocks.health.mockReset()
    daemonMocks.logs.mockReset()
    daemonMocks.start.mockReset()
    daemonMocks.stop.mockReset()
    daemonMocks.saveConfig.mockReset()
    daemonMocks.resetPaper.mockReset()
    daemonMocks.exitPosition.mockReset()
    daemonMocks.status.mockResolvedValue(makeStatus())
    daemonMocks.health.mockResolvedValue(makeHealth())
    daemonMocks.logs.mockResolvedValue({ entries: [], debugEnabled: true })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('loads status + health and opens the daemon socket on mount', async () => {
    const { result } = renderHook(() => useDaemon())

    await waitFor(() =>
      expect(result.current.status?.userState.userId).toBe(DAEMON_USER_ID),
    )
    expect(result.current.health?.feed.source).toBe('upstox-ws-v3')
    expect(MockWebSocket.instances).toHaveLength(1)
    expect(MockWebSocket.instances[0].url).toBe('ws://localhost:3000/ws')
  })

  it('marks the connection live when the socket opens', async () => {
    const { result } = renderHook(() => useDaemon())

    act(() => {
      MockWebSocket.instances[0].onopen?.()
    })
    await waitFor(() => expect(result.current.connected).toBe(true))
  })

  it('logs an explicit info line when the socket reconnects', async () => {
    const { result } = renderHook(() => useDaemon())
    act(() => {
      MockWebSocket.instances[0].onopen?.()
    })
    await waitFor(() =>
      expect(
        result.current.logs.some((l) => l.msg === 'Daemon socket connected'),
      ).toBe(true),
    )

    // Drop the link; the hook schedules a reconnect (1s first backoff).
    act(() => {
      MockWebSocket.instances[0].onclose?.()
    })
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2), {
      timeout: 2500,
    })
    act(() => {
      MockWebSocket.instances[1].onopen?.()
    })
    await waitFor(() =>
      expect(
        result.current.logs.some(
          (l) =>
            l.msg === 'Daemon socket reconnected — live updates resumed' &&
            l.level === 'info',
        ),
      ).toBe(true),
    )
  })

  it('merges the daemon activity backlog and live LOG frames without duplicates', async () => {
    daemonMocks.logs.mockResolvedValue({
      entries: [
        {
          seq: 1,
          ts: '2026-10-21T04:00:00.000Z',
          level: 'info',
          source: 'daemon',
          msg: 'Daemon ready',
        },
      ],
      debugEnabled: true,
    })
    const { result } = renderHook(() => useDaemon())
    const socket = MockWebSocket.instances[0]

    act(() => {
      socket.onopen?.()
    })
    await waitFor(() =>
      expect(result.current.logs.some((l) => l.id === 'daemon-1')).toBe(true),
    )

    // Live frame for the same seq (backlog overlap) must not duplicate.
    act(() => {
      socket.onmessage?.({
        data: JSON.stringify({
          type: 'LOG',
          data: {
            seq: 1,
            ts: '2026-10-21T04:00:00.000Z',
            level: 'info',
            source: 'daemon',
            msg: 'Daemon ready',
          },
        }),
      })
    })
    act(() => {
      socket.onmessage?.({
        data: JSON.stringify({
          type: 'LOG',
          data: {
            seq: 2,
            ts: '2026-10-21T04:00:02.000Z',
            level: 'info',
            source: 'entry',
            msg: 'NIFTY 50 BUY_CE @ ₹145.20',
          },
        }),
      })
    })

    await waitFor(() =>
      expect(result.current.logs.some((l) => l.id === 'daemon-2')).toBe(true),
    )
    expect(result.current.logs.filter((l) => l.id === 'daemon-1')).toHaveLength(
      1,
    )
    // Window-side socket events are merged alongside daemon entries.
    expect(result.current.logs.some((l) => l.source === 'window')).toBe(true)
  })

  it('applies INITIAL_STATE, MARKET_TICK and USER_STATE_UPDATE frames', async () => {
    const { result } = renderHook(() => useDaemon())
    // Let the initial REST poll settle first — socket frames then take over.
    await waitFor(() => expect(result.current.status).not.toBeNull())
    const socket = MockWebSocket.instances[0]

    act(() => {
      socket.onmessage?.({
        data: JSON.stringify({
          type: 'INITIAL_STATE',
          data: {
            snapshots: { 'NIFTY 50': snapshot },
            userState: makeUserState({ state: 'RUNNING' }),
          },
        }),
      })
    })
    await waitFor(() =>
      expect(result.current.status?.userState.state).toBe('RUNNING'),
    )
    expect(result.current.status?.snapshots['NIFTY 50']).toEqual(snapshot)

    act(() => {
      socket.onmessage?.({
        data: JSON.stringify({
          type: 'MARKET_TICK',
          data: {
            timestamp: '2026-10-17T04:01:00.000Z',
            snapshots: { 'NIFTY 50': snapshot },
          },
        }),
      })
    })
    await waitFor(() =>
      expect(result.current.lastTickAt).toBe('2026-10-17T04:01:00.000Z'),
    )

    act(() => {
      socket.onmessage?.({
        data: JSON.stringify({
          type: 'USER_STATE_UPDATE',
          data: makeUserState({ state: 'ORDERED', tradesCountToday: 1 }),
        }),
      })
    })
    await waitFor(() =>
      expect(result.current.status?.userState.tradesCountToday).toBe(1),
    )
    expect(result.current.status?.userState.state).toBe('ORDERED')
  })

  it('routes actions through the daemon API and logs them', async () => {
    daemonMocks.start.mockResolvedValue({ success: true })
    const { result } = renderHook(() => useDaemon())

    act(() => {
      result.current.start('paper')
    })

    await waitFor(() =>
      expect(
        result.current.logs.some((entry) =>
          entry.msg.includes('Start (paper)'),
        ),
      ).toBe(true),
    )
    expect(daemonMocks.start).toHaveBeenCalledWith('paper')
  })

  it('logs action failures without throwing', async () => {
    daemonMocks.stop.mockRejectedValue(new Error('daemon offline'))
    const { result } = renderHook(() => useDaemon())

    act(() => {
      result.current.stop()
    })

    await waitFor(() =>
      expect(
        result.current.logs.some(
          (entry) =>
            entry.level === 'error' && entry.msg.includes('daemon offline'),
        ),
      ).toBe(true),
    )
  })

  it('confirms before starting live and aborts when declined', async () => {
    daemonMocks.start.mockResolvedValue({ success: true })
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const { result } = renderHook(() => useDaemon())

    act(() => {
      result.current.start('live')
    })
    expect(confirmSpy).toHaveBeenCalled()
    expect(daemonMocks.start).not.toHaveBeenCalled()

    confirmSpy.mockReturnValue(true)
    act(() => {
      result.current.start('live')
    })
    await waitFor(() => expect(daemonMocks.start).toHaveBeenCalledWith('live'))
    confirmSpy.mockRestore()
  })

  it('asks about open positions before stopping, and can square off first', async () => {
    daemonMocks.status.mockResolvedValue(
      makeStatus({
        userState: makeUserState({
          state: 'ORDERED',
          positions: {
            'NIFTY 50': {
              instrumentKey: 'NSE_FO|CE_25000',
              direction: 'CE',
              entryPrice: 150,
              quantity: 75,
              entryTime: '2026-10-17T04:00:00.000Z',
              tradeId: 1,
            },
            BANKNIFTY: null,
            FINNIFTY: null,
          },
        }),
      }),
    )
    daemonMocks.exitPosition.mockResolvedValue({ success: true })
    daemonMocks.stop.mockResolvedValue({ success: true })
    const { result } = renderHook(() => useDaemon())

    await waitFor(() => expect(result.current.status).not.toBeNull())
    await waitFor(() =>
      expect(
        result.current.status?.userState.positions['NIFTY 50'],
      ).toBeTruthy(),
    )

    // Stop with an open position opens the prompt instead of stopping.
    act(() => {
      result.current.stop()
    })
    await waitFor(() => expect(result.current.stopPrompt).not.toBeNull())
    expect(daemonMocks.stop).not.toHaveBeenCalled()

    // Cancel leaves everything untouched.
    await act(async () => {
      await result.current.resolveStop('cancel')
    })
    expect(result.current.stopPrompt).toBeNull()
    expect(daemonMocks.stop).not.toHaveBeenCalled()
    expect(daemonMocks.exitPosition).not.toHaveBeenCalled()

    // Square off sells the position, then stops.
    act(() => {
      result.current.stop()
    })
    await waitFor(() => expect(result.current.stopPrompt).not.toBeNull())
    await act(async () => {
      await result.current.resolveStop('square-off')
    })
    await waitFor(() => expect(daemonMocks.stop).toHaveBeenCalled())
    expect(daemonMocks.exitPosition).toHaveBeenCalledWith(
      'NIFTY 50',
      'Stop & Square-off',
    )
  })
})
