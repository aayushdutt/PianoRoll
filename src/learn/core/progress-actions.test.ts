import { describe, expect, it } from 'vitest'
import {
  applyExerciseCompletion,
  applyHeatmap,
  applyStreak,
  applyXp,
  commitResult,
  isoDay,
} from './progress-actions'
import { emptyProgress } from './progress-schema'
import type { ExerciseResult } from './Result'

function result(overrides: Partial<ExerciseResult> = {}): ExerciseResult {
  return {
    exerciseId: 'play-along',
    duration_s: 60,
    accuracy: 0.9,
    xp: 30,
    weakSpots: [],
    completed: true,
    ...overrides,
  }
}

describe('isoDay', () => {
  it('pads month and day to two digits in user local time', () => {
    expect(isoDay(new Date(2026, 0, 3))).toBe('2026-01-03')
    expect(isoDay(new Date(2026, 11, 31))).toBe('2026-12-31')
  })
})

describe('applyStreak', () => {
  it("initialises streak to 1 on the user's first day", () => {
    const { next, extended } = applyStreak({ days: 0, lastDay: '' }, '2026-04-23')
    expect(extended).toBe(true)
    expect(next).toEqual({ days: 1, lastDay: '2026-04-23' })
  })

  it('is a no-op for a second practice session on the same day', () => {
    const prev = { days: 4, lastDay: '2026-04-23' }
    const { next, extended } = applyStreak(prev, '2026-04-23')
    expect(extended).toBe(false)
    expect(next).toBe(prev)
  })

  it('increments the streak when today follows yesterday', () => {
    const { next, extended } = applyStreak({ days: 4, lastDay: '2026-04-22' }, '2026-04-23')
    expect(extended).toBe(true)
    expect(next).toEqual({ days: 5, lastDay: '2026-04-23' })
  })

  it('resets the streak to 1 after a gap day', () => {
    // Two days between lastDay and today — the run is broken.
    const { next, extended } = applyStreak({ days: 12, lastDay: '2026-04-20' }, '2026-04-23')
    expect(extended).toBe(true)
    expect(next).toEqual({ days: 1, lastDay: '2026-04-23' })
  })

  it('handles month rollover without resetting', () => {
    // 2026-04-30 → 2026-05-01 is consecutive even though the month changed.
    const { next, extended } = applyStreak({ days: 10, lastDay: '2026-04-30' }, '2026-05-01')
    expect(extended).toBe(true)
    expect(next).toEqual({ days: 11, lastDay: '2026-05-01' })
  })
})

describe('applyXp', () => {
  it('accumulates positive XP', () => {
    expect(applyXp({ total: 100 }, 30)).toEqual({ total: 130 })
  })

  it('clamps negative deltas to zero (never subtracts)', () => {
    // XP should never be punitive — miss-heavy sessions just earn less, not
    // less than zero. Keeps the number monotonic across a user's history.
    expect(applyXp({ total: 100 }, -50)).toEqual({ total: 100 })
  })

  it('rounds fractional XP', () => {
    expect(applyXp({ total: 0 }, 4.7)).toEqual({ total: 5 })
  })
})

describe('applyHeatmap', () => {
  it('is a no-op when the session produced nothing', () => {
    const prev = { perPitch: { 60: { hits: 1, misses: 0, lastSeen: '2026-04-20' } } }
    expect(applyHeatmap(prev, [], '2026-04-23')).toBe(prev)
  })

  it('accumulates misses and updates lastSeen', () => {
    const prev = { perPitch: { 60: { hits: 5, misses: 2, lastSeen: '2026-04-20' } } }
    const next = applyHeatmap(
      prev,
      [
        { pitch: 60, count: 3 },
        { pitch: 62, count: 1 },
      ],
      '2026-04-23',
    )
    expect(next.perPitch[60]).toEqual({ hits: 5, misses: 5, lastSeen: '2026-04-23' })
    expect(next.perPitch[62]).toEqual({ hits: 0, misses: 1, lastSeen: '2026-04-23' })
  })
})

describe('applyExerciseCompletion', () => {
  it('records a fresh exercise with best accuracy and session time', () => {
    const next = applyExerciseCompletion({}, result({ accuracy: 0.82 }), '2026-04-23')
    expect(next['play-along']).toEqual({
      completions: 1,
      bestAccuracy: 0.82,
      totalTime_s: 60,
      lastCompleted: '2026-04-23',
    })
  })

  it('keeps the best accuracy across repeated completions', () => {
    const first = applyExerciseCompletion(
      {},
      result({ accuracy: 0.92, duration_s: 40 }),
      '2026-04-23',
    )
    const second = applyExerciseCompletion(
      first,
      result({ accuracy: 0.75, duration_s: 30 }),
      '2026-04-24',
    )
    expect(second['play-along']).toEqual({
      completions: 2,
      bestAccuracy: 0.92,
      totalTime_s: 70,
      lastCompleted: '2026-04-24',
    })
  })

  it('counts abandoned sessions toward totalTime but not completions', () => {
    const next = applyExerciseCompletion(
      {},
      result({ completed: false, duration_s: 15 }),
      '2026-04-23',
    )
    expect(next['play-along']).toEqual({
      completions: 0,
      bestAccuracy: 0.9,
      totalTime_s: 15,
      lastCompleted: '2026-04-23',
    })
  })
})

describe('commitResult', () => {
  it('composes streak + XP + heatmap + exercise stats in a single pass', () => {
    const prev = emptyProgress()
    const { next, streakExtended, xpGained } = commitResult(
      prev,
      result({ xp: 45, weakSpots: [{ pitch: 64, count: 2 }] }),
      '2026-04-23',
    )
    expect(streakExtended).toBe(true)
    expect(xpGained).toBe(45)
    expect(next.streak).toEqual({ days: 1, lastDay: '2026-04-23' })
    expect(next.xp.total).toBe(45)
    expect(next.heatmap.perPitch[64]).toEqual({
      hits: 0,
      misses: 2,
      lastSeen: '2026-04-23',
    })
    expect(next.exercises['play-along']?.completions).toBe(1)
  })
})
