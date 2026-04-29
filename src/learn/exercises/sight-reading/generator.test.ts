import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateNoteSource, MidiFileSource } from './generator'
import { poolForClef } from './index'
import type { TierConfig } from './types'

function seq(values: readonly number[]): () => number {
  let i = 0
  return () => {
    const v = values[i % values.length]
    i++
    return v ?? 0
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('generateNoteSource', () => {
  it('never returns consecutive duplicate pitches', () => {
    const src = generateNoteSource({ pitchPool: [60, 62, 64, 65, 67], sessionLength: 200 })
    let prev: number | null = null
    for (let i = 0; i < 200; i++) {
      const pitch = src.next()
      expect(pitch).not.toBeNull()
      if (prev !== null) expect(pitch).not.toBe(prev)
      prev = pitch
    }
  })

  it('exhausts after sessionLength notes', () => {
    const src = generateNoteSource({ pitchPool: [60, 62, 64], sessionLength: 3 })
    expect(src.next()).not.toBeNull()
    expect(src.next()).not.toBeNull()
    expect(src.next()).not.toBeNull()
    expect(src.next()).toBeNull()
    expect(src.done).toBe(true)
    expect(src.progress).toBe(1)
  })

  it('Infinity session never exhausts, progress always 0', () => {
    const src = generateNoteSource({ pitchPool: [60, 62], sessionLength: Infinity })
    for (let i = 0; i < 100; i++) {
      expect(src.next()).not.toBeNull()
      expect(src.done).toBe(false)
      expect(src.progress).toBe(0)
    }
  })

  it('reports progress as fraction of sessionLength', () => {
    const src = generateNoteSource({ pitchPool: [60, 62, 64], sessionLength: 6 })
    expect(src.progress).toBe(0)
    src.next()
    expect(src.progress).toBeCloseTo(1 / 6)
    src.next()
    expect(src.progress).toBeCloseTo(2 / 6)
  })

  it('single-note pool: falls back to full pool (no crash)', () => {
    const src = generateNoteSource({ pitchPool: [60], sessionLength: 5 })
    for (let i = 0; i < 5; i++) {
      expect(src.next()).toBe(60)
    }
    expect(src.next()).toBeNull()
  })

  it('stepwise path: second note is within ±2 pool indices of the first', () => {
    vi.spyOn(Math, 'random').mockImplementation(seq([0.1, 0.5]))

    const pool = [60, 62, 64, 65, 67]
    const src = generateNoteSource({ pitchPool: pool, sessionLength: 2 })

    const first = src.next()!
    expect(pool).toContain(first)

    const firstIdx = pool.indexOf(first)
    const stepwiseRange = pool
      .slice(Math.max(0, firstIdx - 2), Math.min(pool.length, firstIdx + 3))
      .filter((p) => p !== first)

    const second = src.next()!
    expect(stepwiseRange).toContain(second)
  })

  it('full-pool path: when Math.random >= 0.7, any non-dup note from pool is valid', () => {
    vi.spyOn(Math, 'random').mockImplementation(seq([0.0, 0.9, 0.5]))

    const pool = [60, 62, 64, 65, 67]
    const src = generateNoteSource({ pitchPool: pool, sessionLength: 2 })

    const first = src.next()!
    const second = src.next()!
    expect(second).not.toBe(first)
    expect(pool).toContain(second)
  })

  it('weakNoteFocus: focused note given 3× weight in weighted pick', () => {
    vi.spyOn(Math, 'random').mockImplementation(seq([0.5]))

    const src = generateNoteSource({
      pitchPool: [60, 64, 67],
      sessionLength: 1,
      weakNoteFocus: [64],
    })
    expect(src.next()).toBe(64)
  })
})

describe('MidiFileSource', () => {
  it('plays back fixed note list in order', () => {
    const src = new MidiFileSource([60, 64, 67, 72])
    expect(src.next()).toBe(60)
    expect(src.next()).toBe(64)
    expect(src.next()).toBe(67)
    expect(src.next()).toBe(72)
    expect(src.next()).toBeNull()
    expect(src.done).toBe(true)
  })

  it('empty list: done immediately, progress = 1', () => {
    const src = new MidiFileSource([])
    expect(src.next()).toBeNull()
    expect(src.done).toBe(true)
    expect(src.progress).toBe(1)
  })

  it('progress reports correctly mid-sequence', () => {
    const src = new MidiFileSource([60, 64, 67])
    expect(src.progress).toBe(0)
    src.next()
    expect(src.progress).toBeCloseTo(1 / 3)
    src.next()
    expect(src.progress).toBeCloseTo(2 / 3)
    src.next()
    expect(src.progress).toBe(1)
  })
})

describe('poolForClef', () => {
  function makeTier(pitchPool: number[], clef: 'treble' | 'bass' | 'both' = 'treble'): TierConfig {
    return {
      name: 'test',
      pitchPool,
      defaultBpm: 60,
      sessionLength: 10,
      clef,
      keySignature: 'C',
    }
  }

  it('treble: returns tier pitchPool unchanged', () => {
    const tier = makeTier([60, 64, 67])
    expect(poolForClef('treble', tier)).toEqual([60, 64, 67])
  })

  it('bass: transposes notes >= 60 down an octave', () => {
    const tier = makeTier([60, 64, 67, 72])
    expect(poolForClef('bass', tier)).toEqual([48, 52, 55, 60])
  })

  it('bass: preserves notes already in bass range', () => {
    const tier = makeTier([48, 52, 64, 67])
    expect(poolForClef('bass', tier)).toEqual([48, 52, 55])
  })

  it('both: combines tier pool with bass-transposed treble notes', () => {
    const tier = makeTier([60, 64, 67])
    expect(poolForClef('both', tier)).toEqual([48, 52, 55, 60, 64, 67])
  })

  it('both: does not duplicate notes already present', () => {
    const tier = makeTier([48, 52, 60, 64, 67], 'both')
    const result = poolForClef('both', tier)
    expect(result).toEqual([48, 52, 55, 60, 64, 67])
  })

  it('all modes produce sorted output', () => {
    const tier = makeTier([72, 60, 67, 64])
    expect(poolForClef('treble', tier)).toEqual([60, 64, 67, 72])
    expect(poolForClef('bass', tier)).toEqual([48, 52, 55, 60])
    expect(poolForClef('both', tier)).toEqual([48, 52, 55, 60, 64, 67, 72])
  })
})
