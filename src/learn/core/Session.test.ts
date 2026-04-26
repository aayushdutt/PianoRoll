import { describe, expect, it } from 'vitest'
import { Session } from './Session'

describe('Session', () => {
  function mockClock(): { now: () => number; advance: (ms: number) => void } {
    let t = 0
    return { now: () => t, advance: (ms) => (t += ms) }
  }

  it('tracks default-good hits, misses, and derived accuracy', () => {
    const c = mockClock()
    const s = new Session(c.now)
    s.start()
    s.hit() // defaults to 'good'
    s.hit()
    s.miss(60)
    expect(s.hitCount).toBe(2)
    expect(s.goodCount).toBe(2)
    expect(s.perfectCount).toBe(0)
    expect(s.missCount).toBe(1)
    expect(s.attempts).toBe(3)
    expect(s.accuracy).toBeCloseTo(2 / 3)
  })

  it('separates perfect and good buckets when graded', () => {
    const c = mockClock()
    const s = new Session(c.now)
    s.start()
    s.hit('perfect')
    s.hit('perfect')
    s.hit('good')
    expect(s.perfectCount).toBe(2)
    expect(s.goodCount).toBe(1)
    expect(s.hitCount).toBe(3)
  })

  it('counts errors as press-events that reset the streak', () => {
    const c = mockClock()
    const s = new Session(c.now)
    s.start()
    s.hit('perfect')
    s.hit('good')
    expect(s.streak).toBe(2)
    s.error()
    expect(s.errorCount).toBe(1)
    expect(s.streak).toBe(0)
    s.hit('perfect')
    expect(s.streak).toBe(1)
  })

  it('tracks the best streak seen across the session', () => {
    const c = mockClock()
    const s = new Session(c.now)
    s.start()
    s.hit()
    s.hit()
    s.hit()
    s.error()
    s.hit()
    expect(s.streak).toBe(1)
    expect(s.bestStreakSeen).toBe(3)
  })

  it('tickHeld accumulates legato bonus, ignoring zero ticks', () => {
    const c = mockClock()
    const s = new Session(c.now)
    s.start()
    s.tickHeld(0)
    s.tickHeld(2)
    s.tickHeld(3)
    expect(s.heldTicks).toBe(5)
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

  it('start() resets every counter', () => {
    const c = mockClock()
    const s = new Session(c.now)
    s.start()
    s.hit('perfect')
    s.error()
    s.tickHeld(10)
    s.miss(60)
    s.start()
    expect(s.hitCount).toBe(0)
    expect(s.errorCount).toBe(0)
    expect(s.heldTicks).toBe(0)
    expect(s.missCount).toBe(0)
    expect(s.streak).toBe(0)
    expect(s.bestStreakSeen).toBe(0)
  })
})
