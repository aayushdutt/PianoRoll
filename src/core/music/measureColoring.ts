// Measure-based chord-degree coloring for a loaded MIDI file.
//
// This is the piece that makes note colors *stable*: instead of re-deriving a
// chord root from whatever is sounding under the playhead each frame (which
// makes colors flicker), we analyze the score once — one fixed chord root per
// measure, computed from every note that overlaps the bar across all pitched
// tracks — and then color each note purely by which measure it starts in. The
// result never changes as the playhead moves.
//
// Measures come from real barlines (MidiFile.measureStarts, derived from the
// full tempo/meter maps and any anacrusis). When those aren't available
// (synthetic files, live recordings) we fall back to a constant-length grid.
//
// Mirrors MuseScore's getMeasureChordRoot / appendChordDegreeNoteInfosFromMeasure
// (src/engraving/dom/note.cpp) adapted from ticks to midee's second-based timing.

import type { MidiFile } from '../midi/types'
import {
  analyzeChordRoot,
  type ChordDegreeNoteInfo,
  chordDegreeColorIndex,
  colorForIndex,
  pitchClassOf,
  pitchToDegreeIndex,
  tonicPcFromKeyFifths,
} from './chordColoring'

// Synthetic tick resolution. midee times are in seconds; converting to ticks
// with a fixed PPQ keeps the balance between duration-based scores and the
// constant on-beat/lowest/chroma bonuses identical to MuseScore's tick math.
const TICKS_PER_QUARTER = 480

export interface MeasureColoring {
  // Barline times in seconds: measure `m` spans [boundaries[m], boundaries[m+1]).
  // Length is roots.length + 1 (a trailing end boundary). Empty when unusable.
  boundaries: number[]
  // Key tonic pitch class used to resolve scale degrees.
  tonicPC: number
  // Fixed chord-root chroma (0–11) for each measure, indexed by measure number.
  roots: number[]
  // The root *note's own* palette color per measure — used as a note edge tint
  // so every note in the bar is outlined in its chord root's color.
  rootColors: number[]
}

// Seconds per measure from tempo + time signature. bpm is quarter-note BPM;
// a beat of denominator `den` is worth 4/den quarter notes.
export function measureDurationSeconds(bpm: number, timeSignature: [number, number]): number {
  const [numerator, denominator] = timeSignature
  if (!(bpm > 0) || !(numerator > 0) || !(denominator > 0)) return 0
  const quartersPerMeasure = numerator * (4 / denominator)
  const secondsPerQuarter = 60 / bpm
  return quartersPerMeasure * secondsPerQuarter
}

function secondsToTicks(seconds: number, bpm: number): number {
  return Math.round(((seconds * bpm) / 60) * TICKS_PER_QUARTER)
}

// Index of the measure containing `time`: the largest boundary <= time, clamped
// to a valid measure. `boundaries` has one more entry than there are measures.
function measureIndexAt(time: number, boundaries: number[]): number {
  const measureCount = boundaries.length - 1
  if (measureCount <= 0) return 0
  if (time <= boundaries[0]!) return 0
  if (time >= boundaries[measureCount]!) return measureCount - 1

  let lo = 0
  let hi = measureCount // exclusive
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1
    if (boundaries[mid]! <= time) lo = mid
    else hi = mid
  }
  return lo
}

// Barline boundaries (seconds) for `midi`, ending with a trailing bound that
// covers the whole piece. Uses real measureStarts when present, otherwise a
// constant-length grid from tempo + meter.
function boundariesFor(midi: MidiFile): number[] {
  const lastNoteEnd = Math.max(
    0,
    ...midi.tracks.flatMap((t) => t.notes.map((n) => n.time + n.duration)),
  )
  const end = Math.max(midi.duration, lastNoteEnd)

  let starts: number[]
  if (midi.measureStarts && midi.measureStarts.length > 0) {
    starts = midi.measureStarts.filter((s) => Number.isFinite(s)).sort((a, b) => a - b)
    if (starts.length === 0 || starts[0]! > 1e-6) starts.unshift(0)
  } else {
    const measureSeconds = measureDurationSeconds(midi.bpm, midi.timeSignature)
    if (measureSeconds <= 0) return []
    // Small negative epsilon so a duration that lands exactly on a bar boundary
    // (e.g. 4s at a 2s bar) doesn't allocate a spurious trailing empty measure.
    const count = Math.max(1, Math.ceil(end / measureSeconds - 1e-9))
    starts = Array.from({ length: count }, (_, i) => i * measureSeconds)
  }

  // Drop any boundaries at/after the end, then append a single end boundary so
  // the final measure is closed.
  const trimmed = starts.filter((s) => s < end - 1e-6)
  if (trimmed.length === 0) trimmed.push(0)
  const lastStart = trimmed[trimmed.length - 1]!
  const closing = end > lastStart + 1e-6 ? end : lastStart + 1
  return [...trimmed, closing]
}

// Analyze the whole file into one fixed chord root per measure.
export function buildMeasureColoring(midi: MidiFile, keyFifths: number): MeasureColoring {
  const tonicPC = tonicPcFromKeyFifths(keyFifths)
  const boundaries = boundariesFor(midi)
  const measureCount = boundaries.length - 1
  if (measureCount <= 0) return { boundaries: [], tonicPC, roots: [], rootColors: [] }

  const infosByMeasure: ChordDegreeNoteInfo[][] = Array.from(
    { length: measureCount },
    () => [] as ChordDegreeNoteInfo[],
  )

  for (const track of midi.tracks) {
    // Percussion pitches are a drum map, not harmony — they'd pollute the root
    // estimate, so drum tracks are excluded from the analysis.
    if (track.isDrum) continue
    for (const note of track.notes) {
      const start = note.time
      const end = note.time + note.duration
      if (end <= start) continue

      for (let m = measureIndexAt(start, boundaries); m < measureCount; m++) {
        const measureStart = boundaries[m]!
        if (measureStart >= end) break
        const measureEnd = boundaries[m + 1]!
        const overlapStart = Math.max(start, measureStart)
        const overlapEnd = Math.min(end, measureEnd)
        const overlapSeconds = overlapEnd - overlapStart
        if (overlapSeconds <= 0) continue

        infosByMeasure[m]!.push({
          pitch: note.pitch,
          durationTicks: secondsToTicks(overlapSeconds, midi.bpm),
          tickInWindow: secondsToTicks(overlapStart - measureStart, midi.bpm),
        })
      }
    }
  }

  const roots = infosByMeasure.map((infos, m) => {
    if (infos.length === 0) return tonicPC
    const windowTicks = secondsToTicks(boundaries[m + 1]! - boundaries[m]!, midi.bpm)
    return analyzeChordRoot(infos, windowTicks)
  })
  // The root note's own color is how the root chroma is colored relative to
  // itself and the key (semitonesFromRoot = 0 → its diatonic scale degree).
  const rootColors = roots.map((root) => colorForIndex(chordDegreeColorIndex(root, root, tonicPC)))

  return { boundaries, tonicPC, roots, rootColors }
}

// Color index for a note at absolute time `time`, using its measure's fixed
// root. Falls back to plain scale-degree coloring when no measure data exists.
export function measureColorIndexAt(
  pitch: number,
  time: number,
  coloring: MeasureColoring,
): number {
  const pitchClass = pitchClassOf(pitch)
  if (coloring.roots.length === 0) {
    // No chord context — plain scale-degree coloring relative to the key.
    const degree = pitchToDegreeIndex(pitchClass, coloring.tonicPC)
    return degree >= 0 ? degree : 9
  }

  const m = measureIndexAt(time, coloring.boundaries)
  const root = coloring.roots[m] ?? coloring.tonicPC
  return chordDegreeColorIndex(pitchClass, root, coloring.tonicPC)
}

// PixiJS hex color for a note at absolute time `time`.
export function measureNoteColor(pitch: number, time: number, coloring: MeasureColoring): number {
  return colorForIndex(measureColorIndexAt(pitch, time, coloring))
}

// The chord-root note's color for the measure containing `time` — used to tint
// note edges. Falls back to the key tonic's color when there's no measure data.
export function measureRootColorAt(time: number, coloring: MeasureColoring): number {
  if (coloring.rootColors.length === 0) {
    return colorForIndex(
      chordDegreeColorIndex(coloring.tonicPC, coloring.tonicPC, coloring.tonicPC),
    )
  }
  const m = measureIndexAt(time, coloring.boundaries)
  return coloring.rootColors[m] ?? colorForIndex(0)
}
