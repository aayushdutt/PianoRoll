import { describe, expect, it } from 'vitest'
import { isBlackKey, type MidiNote } from '../core/midi/types'
import { BLACK_KEY_HEIGHT_RATIO } from './keyGeometry'
import { Viewport, type ViewportConfig, visibleNoteRange } from './viewport'

const note = (time: number, duration: number): MidiNote => ({
  pitch: 60,
  time,
  duration,
  velocity: 0.8,
})

describe('visibleNoteRange', () => {
  it('returns [0,0] for an empty array', () => {
    expect(visibleNoteRange([], 0, 10)).toEqual([0, 0])
  })

  it('returns the full array when all notes are in range', () => {
    const notes = [note(1, 0.5), note(2, 0.5), note(3, 0.5)]
    expect(visibleNoteRange(notes, 0, 10)).toEqual([0, 3])
  })

  it('excludes notes entirely before visStart', () => {
    // note ends at 1.0, visStart is 2.0 — should be excluded
    const notes = [note(0, 1), note(3, 0.5), note(5, 0.5)]
    const [lo, hi] = visibleNoteRange(notes, 2, 8)
    expect(notes.slice(lo, hi).map((n) => n.time)).toEqual([3, 5])
  })

  it('excludes notes starting after visEnd', () => {
    // note starts at 10.0, visEnd is 5.0 — should be excluded
    const notes = [note(1, 0.5), note(3, 0.5), note(10, 0.5)]
    const [lo, hi] = visibleNoteRange(notes, 0, 5)
    expect(notes.slice(lo, hi).map((n) => n.time)).toEqual([1, 3])
  })

  it('includes a note that started before visStart but extends into view (scan-back)', () => {
    // Long sustained note: starts at 0, lasts 10s. visStart=5, visEnd=8.
    const notes = [note(0, 10), note(6, 0.5)]
    const [lo, hi] = visibleNoteRange(notes, 5, 8)
    expect(notes.slice(lo, hi).map((n) => n.time)).toEqual([0, 6])
  })

  it('handles visStart === visEnd (active-note point query)', () => {
    // Only the note containing t=5 should be returned.
    const notes = [note(0, 3), note(3, 3), note(7, 2)]
    // note at t=3, dur=3 covers [3,6] — contains t=5
    const [lo, hi] = visibleNoteRange(notes, 5, 5)
    expect(notes.slice(lo, hi).map((n) => n.time)).toEqual([3])
  })

  it('includes a note starting exactly at visEnd', () => {
    const notes = [note(5, 1)]
    const [lo, hi] = visibleNoteRange(notes, 0, 5)
    expect(hi - lo).toBe(1)
  })

  it('excludes a note ending exactly at visStart (strict)', () => {
    // note ends at exactly visStart — not strictly inside the window
    const notes = [note(0, 2), note(3, 1)]
    // visStart=2: note(0,2) ends at 2.0, not > 2.0 → excluded
    const [lo, hi] = visibleNoteRange(notes, 2, 5)
    expect(notes.slice(lo, hi).map((n) => n.time)).toEqual([3])
  })

  it('handles a single note in range', () => {
    const notes = [note(4, 1)]
    expect(visibleNoteRange(notes, 3, 6)).toEqual([0, 1])
  })

  it('handles a single note out of range', () => {
    const notes = [note(10, 1)]
    expect(visibleNoteRange(notes, 0, 5)).toEqual([0, 0])
  })

  it('handles many notes with only the middle slice visible', () => {
    const notes = Array.from({ length: 100 }, (_, i) => note(i, 0.5))
    const [lo, hi] = visibleNoteRange(notes, 40, 60)
    // notes 40–60 start in [40, 60]; note 39 ends at 39.5 < 40, excluded
    expect(notes[lo]!.time).toBe(40)
    expect(notes[hi - 1]!.time).toBe(60)
  })

  it('multiple long notes all overlapping visStart are all included via scan-back', () => {
    // Three notes start before visStart=10 but extend past it; note at t=20 is after visEnd=15
    const notes = [note(0, 15), note(5, 12), note(8, 5), note(20, 1)]
    const [lo, hi] = visibleNoteRange(notes, 10, 15)
    expect(notes.slice(lo, hi).map((n) => n.time)).toEqual([0, 5, 8])
  })
})

const makeViewport = (overrides: Partial<ViewportConfig> = {}): Viewport =>
  new Viewport({
    canvasWidth: 1000,
    canvasHeight: 600,
    keyboardHeight: 100,
    pixelsPerSecond: 200,
    ...overrides,
  })

describe('Viewport.pitchAtPoint', () => {
  it('returns null for points outside the keyboard band', () => {
    const vp = makeViewport()
    // keyboardTop = 600 - 100 = 500
    expect(vp.pitchAtPoint(50, 100)).toBeNull() // above the keyboard
    expect(vp.pitchAtPoint(50, 700)).toBeNull() // below the canvas
  })

  it('resolves a point in the upper (black-key zone) over an overlapping region to the BLACK key', () => {
    // Narrow to a single octave so keys are wide and easy to address.
    // C4=60 (white) .. B4=71. C#4=61 is a black key that visually overlaps the
    // right edge of C4 and the left edge of D4.
    const vp = makeViewport({ pitchMin: 60, pitchMax: 71 })
    const cSharp = vp.getAllKeyPositions().get(61)!
    expect(isBlackKey(61)).toBe(true)

    // A point inside the black key's x-span, high in the keyboard (black zone:
    // y <= keyboardTop + keyboardHeight * 0.62 = 500 + 62 = 562).
    const xMid = cSharp.x + cSharp.width / 2
    expect(vp.pitchAtPoint(xMid, 510)).toBe(61)
  })

  it('falls through to the WHITE key when the point is below the black-key zone', () => {
    const vp = makeViewport({ pitchMin: 60, pitchMax: 71 })
    const cSharp = vp.getAllKeyPositions().get(61)!
    const xMid = cSharp.x + cSharp.width / 2
    // Same x, but low in the keyboard (y=580 > 562 black-zone bottom): the black
    // key is no longer eligible, so the underlying white key wins.
    const pitch = vp.pitchAtPoint(xMid, 580)
    expect(pitch).not.toBeNull()
    expect(isBlackKey(pitch!)).toBe(false)
  })

  it('places the black/white zone boundary at BLACK_KEY_HEIGHT_RATIO of the keyboard', () => {
    const vp = makeViewport({ pitchMin: 60, pitchMax: 71 })
    const cSharp = vp.getAllKeyPositions().get(61)!
    const xMid = cSharp.x + cSharp.width / 2
    // keyboardTop = 500, keyboardHeight = 100. Boundary is inclusive.
    const boundary = 500 + 100 * BLACK_KEY_HEIGHT_RATIO
    expect(vp.pitchAtPoint(xMid, boundary)).toBe(61)
    expect(vp.pitchAtPoint(xMid, boundary + 1)).not.toBe(61)
  })

  it('resolves a clearly-white region to its white key in both zones', () => {
    const vp = makeViewport({ pitchMin: 60, pitchMax: 71 })
    const c4 = vp.getAllKeyPositions().get(60)!
    // Far-left edge of C4 has no black key over it (C#4 sits to the right).
    const xLeft = c4.x + 1
    expect(vp.pitchAtPoint(xLeft, 510)).toBe(60)
    expect(vp.pitchAtPoint(xLeft, 580)).toBe(60)
  })
})

describe('Viewport.buildKeyLayout with narrowed pitch range (fit-to-piece)', () => {
  it('lays out only the keys within [pitchMin, pitchMax]', () => {
    // C3=48 .. C5=72 inclusive.
    const vp = makeViewport({ pitchMin: 48, pitchMax: 72 })
    const positions = vp.getAllKeyPositions()
    // No key below C3 or above C5 should exist.
    expect(positions.has(47)).toBe(false)
    expect(positions.has(73)).toBe(false)
    expect(positions.has(48)).toBe(true)
    expect(positions.has(72)).toBe(true)
  })

  it('widens white keys to fill the canvas across the narrowed range', () => {
    const vp = makeViewport({ canvasWidth: 1000, pitchMin: 48, pitchMax: 72 })

    // White keys in C3..C5: C3 D3 E3 F3 G3 A3 B3 (7) + C4..B4 (7) + C5 (1) = 15.
    let whiteCount = 0
    for (let p = 48; p <= 72; p++) if (!isBlackKey(p)) whiteCount++
    expect(whiteCount).toBe(15)

    const whiteW = 1000 / whiteCount
    // First white key (C3=48) starts at x=0 with full white width.
    expect(vp.pitchToX(48)).toBeCloseTo(0)
    expect(vp.pitchWidth(48)).toBeCloseTo(whiteW)

    // Each successive white key is offset by exactly one white-key width.
    expect(vp.pitchToX(50)).toBeCloseTo(whiteW) // D3 is the 2nd white key
    // Last white key (C5=72) is the 15th → x = 14 * whiteW.
    expect(vp.pitchToX(72)).toBeCloseTo(14 * whiteW)
  })

  it('positions black keys as narrower keys offset between their neighbours', () => {
    const vp = makeViewport({ canvasWidth: 1000, pitchMin: 48, pitchMax: 72 })
    // Literals (not recomputed from the source 0.58 ratio, so a ratio change is
    // actually caught): C3..C5 has 15 white keys → whiteW = 1000/15 = 66.667.
    // blackW = whiteW * 0.58 = 38.667. C3 (48) is the first white at x=0, so
    // C#3 (49) sits at whiteW - blackW/2 = 66.667 - 19.333 = 47.333.
    expect(isBlackKey(49)).toBe(true)
    expect(vp.pitchToX(48)).toBeCloseTo(0)
    expect(vp.pitchWidth(49)).toBeCloseTo(38.667, 2)
    expect(vp.pitchToX(49)).toBeCloseTo(47.333, 2)
  })

  it('narrowing the range via update() rebuilds the layout wider', () => {
    const vp = makeViewport({ canvasWidth: 1000 })
    const fullWhiteW = vp.pitchWidth(60) // full piano: many white keys → narrow
    vp.update({ pitchMin: 48, pitchMax: 72 })
    const narrowedWhiteW = vp.pitchWidth(60)
    // Fewer keys across the same canvas ⇒ each key is wider.
    expect(narrowedWhiteW).toBeGreaterThan(fullWhiteW)
  })
})
