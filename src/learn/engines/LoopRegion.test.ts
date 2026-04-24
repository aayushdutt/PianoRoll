import { describe, expect, it } from 'vitest'
import { barSnap, barsToSeconds, makeRegionFromBars, ramp, wrapIfAtEnd } from './LoopRegion'

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

describe('ramp', () => {
  it('returns the first preset when no passes have cleared', () => {
    expect(ramp(0)).toBe(60)
  })

  it('advances one preset per clean pass by default', () => {
    expect(ramp(1)).toBe(70)
    expect(ramp(2)).toBe(80)
    expect(ramp(3)).toBe(90)
    expect(ramp(4)).toBe(100)
  })

  it('clamps at the last preset after more passes', () => {
    // A player on a tear stays at 100% — no secret "doubled tempo" tier.
    expect(ramp(100)).toBe(100)
  })

  it('supports a custom "clean passes per step" threshold', () => {
    // Needs 3 clean passes to step. 0..2 → preset[0], 3..5 → preset[1].
    expect(ramp(0, [60, 80, 100], 3)).toBe(60)
    expect(ramp(2, [60, 80, 100], 3)).toBe(60)
    expect(ramp(3, [60, 80, 100], 3)).toBe(80)
    expect(ramp(9, [60, 80, 100], 3)).toBe(100)
  })
})
