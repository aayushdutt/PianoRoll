import { describe, expect, it } from 'vitest'
import { accuracy, classifyTiming, computeXp, matchChord } from './scoring'

describe('classifyTiming', () => {
  it('returns hit inside the ±window', () => {
    expect(classifyTiming(1.0, 1.0)).toBe('hit')
    expect(classifyTiming(1.099, 1.0)).toBe('hit')
    expect(classifyTiming(0.901, 1.0)).toBe('hit')
  })

  it('flags too-early presses', () => {
    expect(classifyTiming(0.85, 1.0)).toBe('early')
  })

  it('flags too-late presses', () => {
    expect(classifyTiming(1.15, 1.0)).toBe('late')
  })

  it('respects a custom window', () => {
    expect(classifyTiming(1.05, 1.0, 0.02)).toBe('late')
    expect(classifyTiming(1.05, 1.0, 0.06)).toBe('hit')
  })
})

describe('accuracy', () => {
  it('returns 1 for zero attempts (avoids a visible 0% on empty runs)', () => {
    expect(accuracy(0, 0)).toBe(1)
  })

  it('computes hits / attempts in [0,1]', () => {
    expect(accuracy(8, 10)).toBe(0.8)
    expect(accuracy(0, 5)).toBe(0)
    expect(accuracy(5, 5)).toBe(1)
  })
})

describe('computeXp', () => {
  it('rewards accuracy quadratically and clamps duration to 60 s', () => {
    // A perfect-accuracy, 60+ s beginner run earns the full base.
    expect(computeXp({ accuracy: 1, duration_s: 120, difficultyWeight: 1, base: 20 })).toBe(20)
    // Halving accuracy quarters the XP (acc²). 20 * 0.25 = 5.
    expect(computeXp({ accuracy: 0.5, duration_s: 120, difficultyWeight: 1, base: 20 })).toBe(5)
  })

  it('scales with difficultyWeight', () => {
    expect(computeXp({ accuracy: 1, duration_s: 60, difficultyWeight: 2, base: 20 })).toBe(40)
  })

  it('pro-rates short sessions', () => {
    // 30 s clamps duration factor to 0.5.
    expect(computeXp({ accuracy: 1, duration_s: 30, difficultyWeight: 1, base: 20 })).toBe(10)
  })

  it('returns zero on zero accuracy or zero duration', () => {
    expect(computeXp({ accuracy: 0, duration_s: 60, difficultyWeight: 1 })).toBe(0)
    expect(computeXp({ accuracy: 1, duration_s: 0, difficultyWeight: 1 })).toBe(0)
  })
})

describe('matchChord', () => {
  it('reports complete when every required pitch is pressed', () => {
    const m = matchChord(new Set([60, 64, 67]), new Set([60, 64, 67]))
    expect(m.complete).toBe(true)
    expect(m.pending.size).toBe(0)
    expect(m.matched.size).toBe(3)
  })

  it('lists pending pitches for a partial press', () => {
    const m = matchChord(new Set([60, 64, 67]), new Set([60]))
    expect(m.complete).toBe(false)
    expect([...m.pending].sort()).toEqual([64, 67])
    expect([...m.matched]).toEqual([60])
  })

  it('ignores extra pressed pitches that are not in the required set', () => {
    const m = matchChord(new Set([60, 64]), new Set([60, 64, 72]))
    expect(m.complete).toBe(true)
    expect(m.matched.has(72)).toBe(false)
  })

  it('empty required set is never "complete" — avoids false positives on unarmed steps', () => {
    const m = matchChord(new Set(), new Set([60]))
    expect(m.complete).toBe(false)
  })
})
