import { describe, expect, it } from 'vitest'
import { accuracy, classifyArticulation, classifyTiming, computeXp, matchChord } from './scoring'

describe('classifyTiming', () => {
  it('returns "perfect" for presses inside ±50 ms of the scheduled time', () => {
    expect(classifyTiming(1.0, 1.0)).toBe('perfect')
    expect(classifyTiming(1.049, 1.0)).toBe('perfect')
    expect(classifyTiming(0.951, 1.0)).toBe('perfect')
  })

  it('returns "good" between ±50 ms and ±150 ms', () => {
    expect(classifyTiming(1.099, 1.0)).toBe('good')
    expect(classifyTiming(0.901, 1.0)).toBe('good')
  })

  it('flags directional misses inside the late-hit window but past "good"', () => {
    expect(classifyTiming(0.8, 1.0)).toBe('early') // 200 ms early
    expect(classifyTiming(1.25, 1.0)).toBe('late') // 250 ms late
  })

  it('returns "miss" past the late-hit window', () => {
    expect(classifyTiming(1.5, 1.0)).toBe('miss')
    expect(classifyTiming(0.5, 1.0)).toBe('miss')
  })

  it('respects custom windows', () => {
    expect(classifyTiming(1.05, 1.0, { perfectWindow: 0.02 })).toBe('good')
    expect(classifyTiming(1.05, 1.0, { perfectWindow: 0.06 })).toBe('perfect')
    // Tight late window collapses what was "early"/"late" into a flat miss.
    expect(classifyTiming(0.8, 1.0, { lateWindow: 0.18 })).toBe('miss')
  })
})

describe('classifyArticulation', () => {
  it('returns "perfect" for cohesive chord articulation (≤80 ms)', () => {
    expect(classifyArticulation(0)).toBe('perfect')
    expect(classifyArticulation(50)).toBe('perfect')
    expect(classifyArticulation(80)).toBe('perfect')
  })

  it('returns "good" for slower articulation', () => {
    expect(classifyArticulation(81)).toBe('good')
    expect(classifyArticulation(200)).toBe('good')
    // Wait-mode never punishes below "good" — even a 2 s stagger is "good".
    expect(classifyArticulation(2000)).toBe('good')
  })

  it('respects a custom perfect threshold', () => {
    expect(classifyArticulation(50, { perfectMs: 30 })).toBe('good')
    expect(classifyArticulation(50, { perfectMs: 60 })).toBe('perfect')
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
