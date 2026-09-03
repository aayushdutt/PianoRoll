// Chord-degree note coloring — ported from MuseScore's ChordDegrees scheme
// (src/engraving/types/notecoloringscheme.h). The whole module is pure and
// stateless: given weighted note evidence for a time window it estimates one
// chord root, and given a pitch + root + key tonic it returns a color index.
//
// The important property (and the reason this is measure-based, not
// playhead-based) is that a root is computed once per analysis window and then
// every note in that window is colored relative to that fixed root — so colors
// don't shift as the playhead moves or as more notes sound.
//
// Color index meaning (see CHORD_DEGREE_PALETTE):
//   0..6  scale degrees 1..7 of the current key
//   7     chord 3rd (a major/minor third above the chord root)
//   8     chord 5th (a perfect fifth above the chord root)
//   9     chromatic (not diatonic to the key)

// PixiJS hex colors, indexed by the color index produced below.
export const CHORD_DEGREE_PALETTE: readonly number[] = [
  0x62bc47, // 0 — Tonic (scale degree 1)
  0x1560bd, // 1 — Scale degree 2
  0xb32d00, // 2 — Scale degree 3
  0xfff700, // 3 — Scale degree 4
  0x5db0f0, // 4 — Scale degree 5
  0xff4500, // 5 — Scale degree 6
  0xffa500, // 6 — Scale degree 7
  0xa8a8a8, // 7 — Chord 3rd (brightened from 0x505050 for legibility)
  0xd8d8d8, // 8 — Chord 5th (brightened from 0x808080 for legibility)
  0xa855f7, // 9 — Chromatic / out-of-key (purple)
]

// Semitone offsets of the seven degrees of a major scale from its tonic.
const MAJOR_SCALE_INTERVALS = [0, 2, 4, 5, 7, 9, 11]

// ── Scoring weights (mirror the MuseScore constants) ─────────────────────
// Bonus when a note onset lands on a strong beat (beat 0 or 2 of the window).
const SCORE_ON_BEAT_BONUS = 100
// Bonus for being the lowest-sounding pitch (bass strongly implies the root).
const SCORE_LOWEST_PITCH_BONUS = 150
// Weight per occurrence of a pitch class in the window (salience).
const SCORE_CHROMA_COUNT_WEIGHT = 20
// Window length is divided into this many parts to form the strong-beat grid.
const SCORE_QUARTER_DIVISOR = 4
// Interval weights used by findChordRoot when scoring a candidate root.
const SCORE_INTERVAL_FIFTH = 3
const SCORE_INTERVAL_THIRD = 2
const SCORE_INTERVAL_SEVENTH = 1

// How many candidate pitch classes the root finder considers.
const MAX_ROOT_CANDIDATES = 4

export interface KeySignatureOption {
  // Position on the circle of fifths: negative = flats, positive = sharps.
  fifths: number
  // Major-key name for display in the picker.
  label: string
}

// The 15 standard key signatures, flats → sharps, keyed by their major tonic.
export const KEY_SIGNATURES: readonly KeySignatureOption[] = [
  { fifths: -7, label: 'C♭ major' },
  { fifths: -6, label: 'G♭ major' },
  { fifths: -5, label: 'D♭ major' },
  { fifths: -4, label: 'A♭ major' },
  { fifths: -3, label: 'E♭ major' },
  { fifths: -2, label: 'B♭ major' },
  { fifths: -1, label: 'F major' },
  { fifths: 0, label: 'C major' },
  { fifths: 1, label: 'G major' },
  { fifths: 2, label: 'D major' },
  { fifths: 3, label: 'A major' },
  { fifths: 4, label: 'E major' },
  { fifths: 5, label: 'B major' },
  { fifths: 6, label: 'F♯ major' },
  { fifths: 7, label: 'C♯ major' },
]

// One scored note inside an analysis window. Pitch is a MIDI note number;
// durationTicks is the note's overlap with the window; tickInWindow is its
// onset offset from the window start (both in an arbitrary but consistent tick
// unit — see measureColoring.ts).
export interface ChordDegreeNoteInfo {
  pitch: number
  durationTicks: number
  tickInWindow: number
}

// A pitch class is the note folded into a single octave (0 = C … 11 = B).
export function pitchClassOf(midiPitch: number): number {
  return ((midiPitch % 12) + 12) % 12
}

// The tonic pitch class implied by a key signature expressed as a count of
// sharps (positive) or flats (negative) — the circle of fifths. Each sharp
// moves the tonic up a perfect fifth (7 semitones).
export function tonicPcFromKeyFifths(keyFifths: number): number {
  const pc = (keyFifths * 7) % 12
  return pc < 0 ? pc + 12 : pc
}

// Diatonic degree index 0..6 for `pitchClass` in a major scale on `tonicPC`,
// or -1 when the pitch is not in the scale.
export function pitchToDegreeIndex(pitchClass: number, tonicPC: number): number {
  const semitones = (((pitchClass - tonicPC) % 12) + 12) % 12
  return MAJOR_SCALE_INTERVALS.indexOf(semitones)
}

// Heuristic score for how strongly a note event suggests belonging to the
// chord's root set. Longer notes, strong-beat onsets, the bass note, and
// doubled pitch classes all raise the score.
export function scoreNoteForChord(
  info: ChordDegreeNoteInfo,
  windowTicks: number,
  lowestPitch: number,
  chromaCounts: readonly number[],
): number {
  let score = info.durationTicks

  const quarterTicks = Math.floor(windowTicks / SCORE_QUARTER_DIVISOR)
  if (quarterTicks > 0) {
    const beat = Math.floor(info.tickInWindow / quarterTicks)
    if (beat === 0 || beat === 2) score += SCORE_ON_BEAT_BONUS
  }

  if (info.pitch === lowestPitch) score += SCORE_LOWEST_PITCH_BONUS

  score += (chromaCounts[pitchClassOf(info.pitch)] ?? 0) * SCORE_CHROMA_COUNT_WEIGHT

  return score
}

// Picks a root pitch class from candidate pitch classes using interval-weighted
// scoring: a candidate scores higher when the others sit above it as chord
// tones (fifth > third > seventh). On a tie the earlier candidate wins.
export function findChordRoot(pitchClasses: readonly number[]): number {
  if (pitchClasses.length === 0) return 0
  if (pitchClasses.length === 1) return pitchClasses[0]!

  let bestRoot = pitchClasses[0]!
  let highestScore = -1

  for (const candidate of pitchClasses) {
    let score = 0
    for (const other of pitchClasses) {
      if (other === candidate) continue
      const interval = (((other - candidate) % 12) + 12) % 12
      if (interval === 7) score += SCORE_INTERVAL_FIFTH
      else if (interval === 4 || interval === 3) score += SCORE_INTERVAL_THIRD
      else if (interval === 10 || interval === 11) score += SCORE_INTERVAL_SEVENTH
    }
    if (score > highestScore) {
      highestScore = score
      bestRoot = candidate
    }
  }

  return bestRoot
}

// Combines weighted note evidence in a window into a single chord-root chroma.
// Chromas are ranked by score (stable so equal scores keep input order) and the
// top few distinct classes are handed to findChordRoot. Returns 0 for an empty
// window.
export function analyzeChordRoot(
  noteInfos: readonly ChordDegreeNoteInfo[],
  windowTicks: number,
): number {
  if (noteInfos.length === 0) return 0

  let lowestPitch = Number.POSITIVE_INFINITY
  const chromaCounts = new Array<number>(12).fill(0)
  for (const info of noteInfos) {
    const pc = pitchClassOf(info.pitch)
    chromaCounts[pc] = (chromaCounts[pc] ?? 0) + 1
    if (info.pitch < lowestPitch) lowestPitch = info.pitch
  }

  // Score each event, remembering its chroma and original index so the sort
  // stays stable (ascending index breaks score ties the same way std::stable_sort would).
  const scored = noteInfos.map((info, index) => ({
    score: scoreNoteForChord(info, windowTicks, lowestPitch, chromaCounts),
    chroma: pitchClassOf(info.pitch),
    index,
  }))
  scored.sort((a, b) => b.score - a.score || a.index - b.index)

  const topPitchClasses: number[] = []
  const seen = new Array<boolean>(12).fill(false)
  for (const s of scored) {
    if (seen[s.chroma]) continue
    seen[s.chroma] = true
    topPitchClasses.push(s.chroma)
    if (topPitchClasses.length >= MAX_ROOT_CANDIDATES) break
  }

  return findChordRoot(topPitchClasses)
}

// Maps a note chroma, chord root, and key tonic to a color index. Chord 3rd /
// 5th relationships to the root win first; otherwise the note is colored by its
// scale degree in the key, or "chromatic" when it is not diatonic.
export function chordDegreeColorIndex(
  pitchClass: number,
  rootChroma: number,
  tonicPC: number,
): number {
  const semitonesFromRoot = (((pitchClass - rootChroma) % 12) + 12) % 12
  if (semitonesFromRoot === 3 || semitonesFromRoot === 4) return 7 // chord 3rd
  if (semitonesFromRoot === 7) return 8 // chord 5th

  const degree = pitchToDegreeIndex(pitchClass, tonicPC)
  return degree >= 0 ? degree : 9 // chromatic
}

// Resolve a color index to a PixiJS hex color, guarding out-of-range indices.
export function colorForIndex(index: number): number {
  return CHORD_DEGREE_PALETTE[index] ?? CHORD_DEGREE_PALETTE[9]!
}

// Convenience for real-time (live) use where there is no notated window: treat
// every held pitch as an equal-weight, on-beat event and estimate a root. Used
// to fix a live note's color at the moment it is struck.
export function chordRootFromPitches(pitches: readonly number[]): number {
  if (pitches.length === 0) return 0
  const infos: ChordDegreeNoteInfo[] = pitches.map((pitch) => ({
    pitch,
    durationTicks: 1,
    tickInWindow: 0,
  }))
  return analyzeChordRoot(infos, SCORE_QUARTER_DIVISOR)
}
