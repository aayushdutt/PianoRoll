import { describe, expect, it } from 'vitest'
import {
  analyzeChordRoot,
  CHORD_DEGREE_PALETTE,
  type ChordDegreeNoteInfo,
  chordDegreeColorIndex,
  chordRootFromPitches,
  colorForIndex,
  findChordRoot,
  pitchToDegreeIndex,
  tonicPcFromKeyFifths,
} from './chordColoring'

describe('tonicPcFromKeyFifths', () => {
  it('maps the circle of fifths to tonic pitch classes', () => {
    expect(tonicPcFromKeyFifths(0)).toBe(0) // C
    expect(tonicPcFromKeyFifths(1)).toBe(7) // G
    expect(tonicPcFromKeyFifths(-1)).toBe(5) // F
    expect(tonicPcFromKeyFifths(2)).toBe(2) // D
    expect(tonicPcFromKeyFifths(-7)).toBe(11) // Cb ≡ B
  })
})

describe('pitchToDegreeIndex', () => {
  it('returns diatonic degrees, -1 for out-of-scale', () => {
    expect(pitchToDegreeIndex(0, 0)).toBe(0) // C in C major
    expect(pitchToDegreeIndex(4, 0)).toBe(2) // E
    expect(pitchToDegreeIndex(11, 0)).toBe(6) // B
    expect(pitchToDegreeIndex(1, 0)).toBe(-1) // C# not in C major
    expect(pitchToDegreeIndex(11, 7)).toBe(2) // B is the major third above G
  })
})

describe('chordDegreeColorIndex', () => {
  const rootC = 0
  const tonicC = 0
  it('labels thirds and fifths above the root', () => {
    expect(chordDegreeColorIndex(4, rootC, tonicC)).toBe(7) // major third
    expect(chordDegreeColorIndex(3, rootC, tonicC)).toBe(7) // minor third
    expect(chordDegreeColorIndex(7, rootC, tonicC)).toBe(8) // fifth
  })
  it('uses diatonic scale degrees otherwise', () => {
    expect(chordDegreeColorIndex(2, rootC, tonicC)).toBe(1) // D = degree 2
    expect(chordDegreeColorIndex(9, rootC, tonicC)).toBe(5) // A = degree 6
  })
  it('marks chromatic tones', () => {
    expect(chordDegreeColorIndex(1, rootC, tonicC)).toBe(9) // C# outside C major
  })
})

describe('findChordRoot', () => {
  it('handles empty and single-element inputs', () => {
    expect(findChordRoot([])).toBe(0)
    expect(findChordRoot([5])).toBe(5)
  })
  it('prefers the root of a major triad under interval scoring', () => {
    expect(findChordRoot([0, 4, 7])).toBe(0) // C over E, G
  })
})

describe('analyzeChordRoot (windowed)', () => {
  it('returns 0 for an empty window', () => {
    expect(analyzeChordRoot([], 480)).toBe(0)
  })

  it('finds C as root of a full-window C major triad', () => {
    const windowTicks = 1920
    const infos: ChordDegreeNoteInfo[] = [
      { pitch: 60, durationTicks: 480, tickInWindow: 0 }, // C4
      { pitch: 64, durationTicks: 480, tickInWindow: 0 }, // E4
      { pitch: 67, durationTicks: 480, tickInWindow: 0 }, // G4
    ]
    expect(analyzeChordRoot(infos, windowTicks)).toBe(0)
  })

  it('favors a long on-beat bass note as the root', () => {
    // F2 held for the whole bar on beat 1 should anchor the root at F (5),
    // beating a couple of short passing tones.
    const windowTicks = 1920
    const infos: ChordDegreeNoteInfo[] = [
      { pitch: 41, durationTicks: 1920, tickInWindow: 0 }, // F2, whole bar
      { pitch: 60, durationTicks: 240, tickInWindow: 480 }, // C4 passing
      { pitch: 64, durationTicks: 240, tickInWindow: 720 }, // E4 passing
    ]
    expect(analyzeChordRoot(infos, windowTicks)).toBe(5) // F
  })
})

describe('chordRootFromPitches (live convenience)', () => {
  it('estimates a root from a set of held pitches', () => {
    expect(chordRootFromPitches([60, 64, 67])).toBe(0) // C major → C
    expect(chordRootFromPitches([])).toBe(0)
  })
})

describe('colorForIndex', () => {
  it('maps indices to palette entries and clamps out-of-range', () => {
    expect(colorForIndex(0)).toBe(CHORD_DEGREE_PALETTE[0])
    expect(colorForIndex(9)).toBe(CHORD_DEGREE_PALETTE[9])
    expect(colorForIndex(99)).toBe(CHORD_DEGREE_PALETTE[9])
  })
})
