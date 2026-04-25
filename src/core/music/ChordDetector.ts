import { detect as detectChordSymbol } from '@tonaljs/chord'
import { midiToNoteName } from '@tonaljs/midi'

export interface ChordReading {
  // Best-guess chord symbol — "Cmaj7", "Dm/F", "C5". `null` when no chord
  // could be inferred (silence, single note, or an unrecognised cluster).
  name: string | null
  // Human-friendly tonic + quality split, useful when the UI wants to render
  // the root larger than the suffix.
  tonic: string | null
  quality: string | null
  // Pitch-class names of the input notes (deduped, sharps-only). Returned for
  // diagnostics and so the overlay can fall back to "F#·A·C#" when no chord
  // matches but the user is clearly playing *something*.
  pitchClasses: string[]
}

const EMPTY: ChordReading = {
  name: null,
  tonic: null,
  quality: null,
  pitchClasses: [],
}

// Convert a set of MIDI pitches into a chord reading.
//
// • Two-note inputs are coerced into intervals/dyads via Chord.detect's own
//   `assumePerfectFifth` flag, which gives us readable "C5" power-chord-style
//   labels instead of nothing.
// • Single notes return the pitch-class name as the "tonic" but no quality —
//   the overlay shows just "C" without a suffix.
// • The lowest-sounding MIDI pitch is placed first in the input array so
//   Chord.detect treats it as the bass and produces slash-chord readings for
//   inversions (e.g. "C/E").
export function detectChord(pitches: Iterable<number>): ChordReading {
  // Sort the actual MIDI numbers so the lowest pitch becomes the bass and
  // the rest follow in voicing order. Dedup pitch *classes* afterwards while
  // preserving that order.
  const sorted: number[] = []
  for (const p of pitches) {
    if (Number.isFinite(p)) sorted.push(p)
  }
  if (sorted.length === 0) return EMPTY
  sorted.sort((a, b) => a - b)

  const seen = new Set<string>()
  const pitchClasses: string[] = []
  for (const midi of sorted) {
    const pc = midiToNoteName(midi, { pitchClass: true, sharps: true })
    if (seen.has(pc)) continue
    seen.add(pc)
    pitchClasses.push(pc)
  }

  if (pitchClasses.length === 1) {
    const tonic = pitchClasses[0]!
    return { name: tonic, tonic, quality: '', pitchClasses }
  }

  const candidates = detectChordSymbol(pitchClasses, {
    assumePerfectFifth: true,
  })

  const name = candidates[0] ?? null
  if (!name) {
    // No chord match — keep the pitch classes for the fallback readout.
    return { ...EMPTY, pitchClasses }
  }

  // Split "Cmaj7", "Dm/F", "F#dim" → tonic / quality.
  const split = splitChordName(name)
  return { name, tonic: split.tonic, quality: split.quality, pitchClasses }
}

interface SplitName {
  tonic: string
  quality: string
}

// Tonal's chord names always lead with a pitch class (C, F#, Db) followed
// immediately by quality + extensions, optionally a slash bass.
function splitChordName(name: string): SplitName {
  const m = name.match(/^([A-G][#b]?)(.*)$/)
  if (!m) return { tonic: name, quality: '' }
  return { tonic: m[1] ?? name, quality: m[2] ?? '' }
}
