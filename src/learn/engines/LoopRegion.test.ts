import { describe, expect, it } from 'vitest'
import type { TempoMapSource } from '../../core/midi/tempoMap'
import { barSnap, barsToSeconds, makeRegionFromBars, wrapIfAtEnd } from './LoopRegion'

describe('barsToSeconds', () => {
  it('converts bar count to seconds at the given BPM', () => {
    // 4 bars @ 120 BPM, 4/4 = 8 seconds.
    expect(barsToSeconds(4, 120)).toBe(8)
    expect(barsToSeconds(8, 60)).toBe(32)
  })

  it('returns 0 for non-positive inputs', () => {
    expect(barsToSeconds(0, 120)).toBe(0)
    expect(barsToSeconds(-2, 120)).toBe(0)
    expect(barsToSeconds(4, 0)).toBe(0)
  })

  it('respects custom beats-per-bar for odd time signatures', () => {
    // 4 bars @ 120 BPM, 3/4 = 6 seconds.
    expect(barsToSeconds(4, 120, 3)).toBe(6)
  })
})

describe('barSnap', () => {
  it('is a no-op when disabled', () => {
    expect(barSnap(3.37, 120, false)).toBe(3.37)
  })

  it('floors to the nearest bar boundary when enabled', () => {
    // @ 120 BPM 4/4, bar = 2 s. 3.37 → 2 (floor).
    expect(barSnap(3.37, 120, true)).toBe(2)
    expect(barSnap(4, 120, true)).toBe(4)
  })

  it('never goes negative', () => {
    expect(barSnap(-1, 120, true)).toBe(0)
  })
})

describe('makeRegionFromBars', () => {
  it('builds a [playhead-span, playhead] region for a bar count', () => {
    // 4 bars @ 120 = 8 s. Playhead at 20 s → [12, 20].
    expect(makeRegionFromBars(20, 4, 120, 60)).toEqual({ start: 12, end: 20 })
  })

  it('shortens the region near the start instead of shifting forward', () => {
    // "Last 8 bars" at second 5: user has only played 5 seconds, so the loop
    // is [0, 5] — what they actually heard. Shifting forward to [0, 16]
    // would loop bars the user hasn't reached yet.
    const r = makeRegionFromBars(5, 8, 120, 60)
    expect(r).toEqual({ start: 0, end: 5 })
  })

  it('caps end at pieceDuration if playhead overshoots', () => {
    // Playhead past the end of a 60-s piece — clamp end to pieceDuration
    // and build the last-N-bars loop ending there.
    const r = makeRegionFromBars(75, 4, 120, 60)
    expect(r).toEqual({ start: 52, end: 60 })
  })

  it('returns a [0, pieceDuration] region for null bars (full piece)', () => {
    expect(makeRegionFromBars(42, null, 120, 90)).toEqual({ start: 0, end: 90 })
  })

  it('returns null for degenerate inputs', () => {
    expect(makeRegionFromBars(5, 0, 120, 60)).toBeNull()
    expect(makeRegionFromBars(5, 4, 120, 0)).toBeNull()
    expect(makeRegionFromBars(5, -1, 120, 60)).toBeNull()
  })
})

describe('wrapIfAtEnd', () => {
  it('returns the start when the playhead reaches the end', () => {
    expect(wrapIfAtEnd(20, { start: 10, end: 20 })).toBe(10)
    expect(wrapIfAtEnd(19.998, { start: 10, end: 20 })).toBe(10)
  })

  it('returns null while the playhead is still inside the region', () => {
    expect(wrapIfAtEnd(15, { start: 10, end: 20 })).toBeNull()
  })

  it('returns null for a degenerate region', () => {
    expect(wrapIfAtEnd(10, { start: 10, end: 10 })).toBeNull()
  })

  it('respects a custom epsilon for the wrap trigger', () => {
    // Tight epsilon → have to be essentially at end.
    expect(wrapIfAtEnd(19.997, { start: 10, end: 20 }, 0.001)).toBeNull()
    expect(wrapIfAtEnd(19.9995, { start: 10, end: 20 }, 0.001)).toBe(10)
  })
})

// ── Tempo-map path ────────────────────────────────────────────────────────

// 4/4 @ 120 for the first 4 s (2 s bars at 0, 2), then 3/4 @ 60 (3 s bars at
// 4, 7, 10, 13). The scalar-BPM path can't express this.
const changed: TempoMapSource = {
  tempos: [
    { time: 0, bpm: 120 },
    { time: 4, bpm: 60 },
  ],
  timeSignatures: [
    { time: 0, numerator: 4, denominator: 4 },
    { time: 4, numerator: 3, denominator: 4 },
  ],
}

describe('barSnap with a tempo map', () => {
  it('snaps to real bar lines across the meter change', () => {
    expect(barSnap(3.9, changed, true)).toBeCloseTo(2, 9)
    expect(barSnap(6.9, changed, true)).toBeCloseTo(4, 9)
    expect(barSnap(9.9, changed, true)).toBeCloseTo(7, 9)
  })

  it('still respects the enabled flag', () => {
    expect(barSnap(3.9, changed, false)).toBe(3.9)
  })

  it('differs from the scalar path, which is the whole point', () => {
    // Nominal 120 bpm 4/4 would snap 9.9 to 8; the map says 7.
    expect(barSnap(9.9, 120, true)).toBe(8)
  })
})

describe('makeRegionFromBars with a tempo map', () => {
  it('spans the bars actually played, not a constant', () => {
    // Two bars back from 13 s = 7 s (both 3 s wide).
    expect(makeRegionFromBars(13, 2, changed, 60)).toEqual({ start: 7, end: 13 })
  })

  it('handles a window straddling the tempo/meter change', () => {
    // 7 → 4 (3 s) → 2 (2 s) = 5 s of music, vs 4 s under the nominal tempo.
    const r = makeRegionFromBars(7, 2, changed, 60)
    expect(r?.start).toBeCloseTo(2, 9)
    expect(r?.end).toBeCloseTo(7, 9)
  })

  it('shortens near the piece start like the scalar path', () => {
    expect(makeRegionFromBars(3, 8, changed, 60)).toEqual({ start: 0, end: 3 })
  })

  it('still returns the whole piece for a null bar count', () => {
    expect(makeRegionFromBars(5, null, changed, 42)).toEqual({ start: 0, end: 42 })
  })
})
