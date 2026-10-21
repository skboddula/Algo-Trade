import { describe, it, expect, vi, afterEach } from 'vitest'
import { ActivityLog, type CoalesceInfo } from '../services/activityLog'

describe('ActivityLog', () => {
  it('keeps a bounded activity ring with increasing seq', () => {
    const log = new ActivityLog({ activityCap: 3 })
    for (let i = 1; i <= 5; i++) {
      log.add('info', 'bot', `line ${i}`)
    }
    const backlog = log.backlog(10)
    expect(backlog.map((e) => e.msg)).toEqual(['line 3', 'line 4', 'line 5'])
    expect(backlog.map((e) => e.seq)).toEqual([3, 4, 5])
  })

  it('routes debug entries to a separate ring so they cannot evict activity', () => {
    const log = new ActivityLog({ activityCap: 3, debugCap: 2 })
    log.add('info', 'bot', 'important 1')
    log.add('debug', 'signal', 'tick 1')
    log.add('debug', 'signal', 'tick 2')
    log.add('debug', 'signal', 'tick 3')
    log.add('info', 'bot', 'important 2')

    // Debug ring kept only the last two debug entries.
    const merged = log.backlog(10)
    const debugLines = merged.filter((e) => e.level === 'debug').map((e) => e.msg)
    expect(debugLines).toEqual(['tick 2', 'tick 3'])

    // Both activity entries survived despite the debug flood.
    const activityLines = merged.filter((e) => e.level !== 'debug').map((e) => e.msg)
    expect(activityLines).toEqual(['important 1', 'important 2'])
  })

  it('drops debug entries at the source when disabled', () => {
    const log = new ActivityLog({ debugEnabled: false })
    log.add('debug', 'signal', 'hidden')
    log.add('info', 'bot', 'visible')
    expect(log.isDebugEnabled()).toBe(false)
    expect(log.backlog(10).map((e) => e.msg)).toEqual(['visible'])

    log.setDebugEnabled(true)
    log.add('debug', 'signal', 'now visible')
    expect(log.backlog(10).map((e) => e.msg)).toEqual(['visible', 'now visible'])
  })

  it('backlog merges by seq and respects the limit', () => {
    const log = new ActivityLog()
    log.add('info', 'a', 'one')
    log.add('debug', 'b', 'two')
    log.add('info', 'c', 'three')
    log.add('debug', 'd', 'four')

    expect(log.backlog(2).map((e) => e.msg)).toEqual(['three', 'four'])
    expect(log.backlog(100).map((e) => e.msg)).toEqual(['one', 'two', 'three', 'four'])
  })

  it('fans entries out to subscribers and stops after unsubscribe', () => {
    const log = new ActivityLog()
    const seen: string[] = []
    const unsubscribe = log.subscribe((entry) => seen.push(entry.msg))

    log.add('info', 'bot', 'first')
    unsubscribe()
    log.add('info', 'bot', 'second')

    expect(seen).toEqual(['first'])
  })

  it('a throwing subscriber never breaks add or other listeners', () => {
    const log = new ActivityLog()
    const seen: string[] = []
    log.subscribe(() => {
      throw new Error('subscriber exploded')
    })
    log.subscribe((entry) => seen.push(entry.msg))

    expect(() => log.add('error', 'order', 'after explosion')).not.toThrow()
    expect(seen).toEqual(['after explosion'])
  })

  describe('addCoalesced', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    const msg = ({ repeatCount, heldMs }: CoalesceInfo) =>
      `rc=${repeatCount};held=${heldMs}`

    function startClock(): void {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-10-21T04:00:00.000Z'))
    }

    it('emits once and suppresses identical evaluations, updating the line in place', () => {
      startClock()
      const log = new ActivityLog({ coalesceHeartbeatMs: 60_000 })
      const call = () =>
        log.addCoalesced({
          key: 'u:NIFTY 50',
          fingerprint: 'NO_TRADE|none|not-applicable|ok|no-entry-signal',
          source: 'signal',
          buildMessage: msg,
        })

      call()
      vi.advanceTimersByTime(2000)
      call()
      vi.advanceTimersByTime(2000)
      call()

      const entries = log.backlog(10)
      expect(entries).toHaveLength(1)
      expect(entries[0].repeatCount).toBe(2)
      expect(entries[0].heldMs).toBe(4000)
      expect(entries[0].msg).toBe('rc=2;held=4000')
    })

    it('emits immediately when the fingerprint changes', () => {
      startClock()
      const log = new ActivityLog()
      log.addCoalesced({
        key: 'k',
        fingerprint: 'NO_TRADE',
        source: 'signal',
        buildMessage: msg,
      })
      vi.advanceTimersByTime(2000)
      log.addCoalesced({
        key: 'k',
        fingerprint: 'NO_TRADE',
        source: 'signal',
        buildMessage: msg,
      })
      vi.advanceTimersByTime(2000)
      log.addCoalesced({
        key: 'k',
        fingerprint: 'BUY_CE|moderate',
        source: 'signal',
        buildMessage: msg,
      })

      const entries = log.backlog(10)
      expect(entries).toHaveLength(2)
      expect(entries[0].repeatCount).toBe(1)
      expect(entries[1].msg).toBe('rc=0;held=0')
      expect(entries[1].repeatCount).toBe(0)
    })

    it('re-emits an unchanged state at the heartbeat', () => {
      startClock()
      const log = new ActivityLog({ coalesceHeartbeatMs: 60_000 })
      const call = () =>
        log.addCoalesced({
          key: 'k',
          fingerprint: 'same',
          source: 'signal',
          buildMessage: msg,
        })

      call() // t=0, emit
      vi.advanceTimersByTime(30_000)
      call() // suppressed
      vi.advanceTimersByTime(31_000)
      call() // t=61s, heartbeat emit

      const entries = log.backlog(10)
      expect(entries).toHaveLength(2)
      expect(entries[1].msg).toBe('rc=1;held=61000')
    })

    it('heartbeat 0 emits only on change', () => {
      startClock()
      const log = new ActivityLog({ coalesceHeartbeatMs: 0 })
      const call = () =>
        log.addCoalesced({
          key: 'k',
          fingerprint: 'same',
          source: 'signal',
          buildMessage: msg,
        })

      call()
      vi.advanceTimersByTime(10 * 60_000)
      call()
      expect(log.backlog(10)).toHaveLength(1)
    })

    it('full mode (coalesceDebug=false) emits every evaluation', () => {
      startClock()
      const log = new ActivityLog({ coalesceDebug: false })
      for (let i = 0; i < 3; i++) {
        log.addCoalesced({
          key: 'k',
          fingerprint: 'same',
          source: 'signal',
          buildMessage: msg,
        })
      }
      expect(log.backlog(10)).toHaveLength(3)
    })

    it('stays silent while debug is disabled and emits after re-enabling', () => {
      startClock()
      const log = new ActivityLog({ debugEnabled: false })
      const call = () =>
        log.addCoalesced({
          key: 'k',
          fingerprint: 'same',
          source: 'signal',
          buildMessage: msg,
        })

      call()
      expect(log.backlog(10)).toHaveLength(0)

      log.setDebugEnabled(true)
      call()
      const entries = log.backlog(10)
      expect(entries).toHaveLength(1)
      expect(entries[0].repeatCount).toBe(0)
    })

    it('tracks coalescing state independently per key', () => {
      startClock()
      const log = new ActivityLog()
      for (const key of ['u:NIFTY 50', 'u:BANKNIFTY']) {
        log.addCoalesced({
          key,
          fingerprint: 'NO_TRADE',
          source: 'signal',
          buildMessage: msg,
        })
      }
      expect(log.backlog(10)).toHaveLength(2)
    })

    it('clearCoalesced(prefix) forgets only matching keys', () => {
      startClock()
      const log = new ActivityLog()
      const call = (key: string) =>
        log.addCoalesced({
          key,
          fingerprint: 'same',
          source: 'signal',
          buildMessage: msg,
        })

      call('u1:NIFTY 50')
      call('u2:NIFTY 50')
      expect(log.backlog(10)).toHaveLength(2)

      log.clearCoalesced('u1:')
      call('u1:NIFTY 50') // state was cleared → fresh emit
      call('u2:NIFTY 50') // still suppressed

      const entries = log.backlog(10)
      expect(entries).toHaveLength(3)
      expect(entries[2].repeatCount).toBe(0)
    })
  })
})
