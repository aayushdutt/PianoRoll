import { describe, expect, it } from 'vitest'
import { Session } from './Session'

describe('Session', () => {
  function mockClock(): { now: () => number; advance: (ms: number) => void } {
    let t = 0
    return { now: () => t, advance: (ms) => (t += ms) }
  }

  it('tracks hits, misses, and derived accuracy', () => {
    const c = mockClock()
    const s = new Session(c.now)
    s.start()
    s.hit()
    s.hit()
    s.miss(60)
    expect(s.hitCount).toBe(2)
    expect(s.missCount).toBe(1)
    expect(s.attempts).toBe(3)
    expect(s.accuracy).toBeCloseTo(2 / 3)
  })

  it('aggregates per-pitch misses into weakSpots', () => {
    const c = mockClock()
    const s = new Session(c.now)
    s.start()
    s.miss(60)
    s.miss(60)
    s.miss(64)
    const spots = s.weakSpots().sort((a, b) => a.pitch - b.pitch)
    expect(spots).toEqual([
      { pitch: 60, count: 2 },
      { pitch: 64, count: 1 },
    ])
  })

  it('subtracts paused time from duration', () => {
    // Practice gets credit only for active minutes — pausing to look up a
    // fingering shouldn't inflate the practice-log totals.
    const c = mockClock()
    const s = new Session(c.now)
    s.start()
    c.advance(2000)
    s.pause()
    c.advance(5000)
    s.resume()
    c.advance(1000)
    s.end()
    expect(s.duration_s).toBeCloseTo(3)
  })

  it('closes any pending pause on end so duration is finite', () => {
    const c = mockClock()
    const s = new Session(c.now)
    s.start()
    c.advance(1000)
    s.pause()
    c.advance(4000)
    s.end()
    // The 4 s of pause at the tail counts as paused, not active.
    expect(s.duration_s).toBeCloseTo(1)
  })
})
