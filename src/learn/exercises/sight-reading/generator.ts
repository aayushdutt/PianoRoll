// Note generator and MIDI file source for sight-reading exercises.
// `generateNoteSource` returns a weighted random stream respecting stepwise-
// motion bias and weak-note focus. `MidiFileSource` plays back a fixed list.

import type { NoteSource, TierConfig, TierKey } from './types'

export const TIER_CONFIGS: Record<TierKey, TierConfig> = {
  landmark: {
    name: 'Landmark Notes',
    pitchPool: [60, 64, 67, 72], // C4, E4, G4, C5
    defaultBpm: 48,
    sessionLength: 20,
    clef: 'treble',
    keySignature: 'C',
  },
  'c-major-1': {
    name: 'C Major — One Octave',
    pitchPool: [60, 62, 64, 65, 67, 69, 71, 72], // C4–C5 white keys
    defaultBpm: 54,
    sessionLength: 30,
    clef: 'treble',
    keySignature: 'C',
  },
  'c-major-2': {
    name: 'C Major — Two Octaves',
    pitchPool: [60, 62, 64, 65, 67, 69, 71, 72, 74, 76, 77, 79, 81, 83, 84], // C4–C6 white keys
    defaultBpm: 60,
    sessionLength: 40,
    clef: 'treble',
    keySignature: 'C',
  },
  'grand-staff': {
    name: 'Grand Staff',
    pitchPool: [
      // Bass: C3-B3
      48, 50, 52, 53, 55, 57, 59,
      // Bass+Treble: C4-B4
      60, 62, 64, 65, 67, 69, 71,
      // Treble: C5-C6
      72, 74, 76, 77, 79, 81, 83, 84,
    ],
    defaultBpm: 56,
    sessionLength: 40,
    clef: 'both',
    keySignature: 'C',
  },
  'key-sigs': {
    name: 'Key Signatures',
    // G major: G3 A3 B3 C4 D4 E4 F#4 G4 A4 B4 C5 D5 E5 F#5 G5
    pitchPool: [55, 57, 59, 60, 62, 64, 66, 67, 69, 71, 72, 74, 76, 78, 79],
    defaultBpm: 60,
    sessionLength: 40,
    clef: 'treble',
    keySignature: 'G',
  },
  arcade: {
    name: 'Arcade',
    pitchPool: [60, 62, 64, 65, 67, 69, 71, 72], // C major, starts simple
    defaultBpm: 55,
    sessionLength: Infinity, // until knockout
    clef: 'treble',
    keySignature: 'C',
  },
}

export interface GeneratorOptions {
  pitchPool: number[]
  sessionLength: number
  weakNoteFocus?: number[] // pitches to appear at 3× rate
}

/**
 * Returns a NoteSource that streams random MIDI pitches from `pitchPool`.
 *
 * Rules:
 * - No consecutive duplicate pitches.
 * - 70% chance: pick within ±2 diatonic steps of the last pitch (stepwise).
 * - 30% chance: pick randomly from the full pool.
 * - Pitches in `weakNoteFocus` appear at 3× normal weight.
 * - Returns null from next() when count >= sessionLength (never for Infinity).
 */
export function generateNoteSource(opts: GeneratorOptions): NoteSource {
  const pool = [...opts.pitchPool].sort((a, b) => a - b)
  const { sessionLength, weakNoteFocus = [] } = opts
  const focusSet = new Set(weakNoteFocus)

  let count = 0
  let lastPitch: number | null = null

  function weightedPick(candidates: number[]): number {
    if (candidates.length === 0) throw new Error('empty candidate list')

    // Build weights: focused notes get 3× weight.
    const weights = candidates.map((p) => (focusSet.has(p) ? 3 : 1))
    const total = weights.reduce((s, w) => s + w, 0)
    let r = Math.random() * total
    for (let i = 0; i < candidates.length; i++) {
      r -= weights[i]!
      if (r <= 0) return candidates[i]!
    }
    return candidates[candidates.length - 1]!
  }

  function pickNext(): number {
    // Determine stepwise candidates (within ±2 pool indices of last).
    const stepwise: number[] = []
    if (lastPitch !== null) {
      const idx = pool.indexOf(lastPitch)
      if (idx !== -1) {
        const lo = Math.max(0, idx - 2)
        const hi = Math.min(pool.length - 1, idx + 2)
        for (let i = lo; i <= hi; i++) {
          if (pool[i] !== lastPitch) stepwise.push(pool[i]!)
        }
      }
    }

    const useStepwise = stepwise.length > 0 && Math.random() < 0.7

    const candidates = useStepwise
      ? stepwise.filter((p) => p !== lastPitch)
      : pool.filter((p) => p !== lastPitch)

    // Fallback: if all candidates were filtered (e.g. single-note pool), use full pool
    if (candidates.length === 0) {
      return weightedPick(pool)
    }

    return weightedPick(candidates)
  }

  return {
    next(): number | null {
      if (sessionLength !== Infinity && count >= sessionLength) return null
      const pitch = pickNext()
      lastPitch = pitch
      count++
      return pitch
    },
    get progress(): number {
      if (sessionLength === Infinity) return 0
      return count / sessionLength
    },
    get done(): boolean {
      if (sessionLength === Infinity) return false
      return count >= sessionLength
    },
  }
}

export class MidiFileSource implements NoteSource {
  private readonly notes: number[]
  private index = 0

  constructor(notes: number[]) {
    this.notes = notes
  }

  next(): number | null {
    if (this.index >= this.notes.length) return null
    return this.notes[this.index++] ?? null
  }

  get progress(): number {
    if (this.notes.length === 0) return 1
    return this.index / this.notes.length
  }

  get done(): boolean {
    return this.index >= this.notes.length
  }
}
