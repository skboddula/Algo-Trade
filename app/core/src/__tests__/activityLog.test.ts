import { describe, it, expect } from 'vitest'
import { ActivityLog } from '../services/activityLog'

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
})
