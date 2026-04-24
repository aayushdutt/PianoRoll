import { describe, expect, it } from 'vitest'
import {
  BEGINNER_SET,
  getInterval,
  INTERVALS,
  makeQuestions,
  pickRootPitch,
  shuffle,
} from './theory'

// Deterministic pseudo-random sequencer. Drives tests so shuffle / root
// picking / question generation produce predictable output without leaking
// real randomness into the assertions.
function seq(values: readonly number[]): () => number {
  let i = 0
  return () => {
    const v = values[i % values.length]
    i++
    return v ?? 0
  }
}

describe('theory.getInterval', () => {
  it('returns the matching interval by id', () => {
    expect(getInterval('P5')?.semitones).toBe(7)
    expect(getInterval('P8')?.full).toBe('Octave')
  })
  it('returns undefined for unknown ids', () => {
    expect(getInterval('xx')).toBeUndefined()
  })
})

describe('theory.BEGINNER_SET', () => {
  it('maps to four known intervals', () => {
    expect(BEGINNER_SET.length).toBe(4)
    for (const id of BEGINNER_SET) {
      expect(INTERVALS.find((i) => i.id === id)).toBeDefined()
    }
  })
})

describe('theory.pickRootPitch', () => {
  it('keeps the interval inside the C3–C5 window', () => {
    // Random=0 → lowest root (C3 = 48). Random=0.999 → highest root.
    for (const semitones of [0, 5, 7, 12]) {
      const low = pickRootPitch(semitones, () => 0)
      const high = pickRootPitch(semitones, () => 0.99)
      expect(low).toBe(48)
      expect(high + semitones).toBeLessThanOrEqual(72)
      expect(low + semitones).toBeLessThanOrEqual(72)
    }
  })

  it('clamps to C3 when the interval is wider than the window', () => {
    // Pathological case — a 40-semitone interval would put the top above the
    // keyboard window. The picker should still return a legal root without
    // throwing so the engine stays robust to misconfigured sets.
    expect(pickRootPitch(40, () => 0.5)).toBe(48)
  })
})

describe('theory.shuffle', () => {
  it('leaves the input untouched', () => {
    const input = ['a', 'b', 'c'] as const
    shuffle(input)
    expect(input).toEqual(['a', 'b', 'c'])
  })

  it('is deterministic under a fixed RNG', () => {
    const input = ['a', 'b', 'c', 'd']
    const first = shuffle(input, seq([0.1, 0.2, 0.3]))
    const second = shuffle(input, seq([0.1, 0.2, 0.3]))
    expect(first).toEqual(second)
  })
})

describe('theory.makeQuestions', () => {
  it('produces exactly `count` questions', () => {
    const qs = makeQuestions(5, BEGINNER_SET, seq([0, 0.25, 0.5, 0.75, 0.99, 0]))
    expect(qs.length).toBe(5)
  })

  it('each question picks an interval from the pool and a legal root', () => {
    const qs = makeQuestions(20, BEGINNER_SET, () => Math.random())
    for (const q of qs) {
      expect(BEGINNER_SET).toContain(q.intervalId)
      expect(q.rootPitch).toBeGreaterThanOrEqual(48)
      expect(q.rootPitch + q.semitones).toBeLessThanOrEqual(72)
    }
  })

  it('returns empty when the pool is empty', () => {
    expect(makeQuestions(5, [])).toEqual([])
  })
})
