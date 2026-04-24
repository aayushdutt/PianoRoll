// Pure interval / pitch helpers for the ear-training quiz. Kept DOM- and
// Tone.js-free so the engine stays trivially unit-testable and future ear
// exercises (chords, scales) can reuse the same vocabulary.

// Canonical ascending-diatonic short names. The `semitones` field is the
// single source of truth — the audio layer reads `root + semitones` to pick
// the upper note; the UI shows `short` / `full` as answer labels.
export interface Interval {
  id: string
  short: string // e.g. "P5"
  full: string // e.g. "Perfect 5th" — shown after a miss so the user learns the names
  semitones: number
}

// The full chromatic set. v1 quiz picks a subset (see `BEGINNER_SET`), but
// keeping the complete list here means intermediate/advanced difficulty tiers
// drop in without a follow-up refactor.
export const INTERVALS: readonly Interval[] = [
  { id: 'P1', short: 'P1', full: 'Unison', semitones: 0 },
  { id: 'm2', short: 'm2', full: 'Minor 2nd', semitones: 1 },
  { id: 'M2', short: 'M2', full: 'Major 2nd', semitones: 2 },
  { id: 'm3', short: 'm3', full: 'Minor 3rd', semitones: 3 },
  { id: 'M3', short: 'M3', full: 'Major 3rd', semitones: 4 },
  { id: 'P4', short: 'P4', full: 'Perfect 4th', semitones: 5 },
  { id: 'TT', short: 'TT', full: 'Tritone', semitones: 6 },
  { id: 'P5', short: 'P5', full: 'Perfect 5th', semitones: 7 },
  { id: 'm6', short: 'm6', full: 'Minor 6th', semitones: 8 },
  { id: 'M6', short: 'M6', full: 'Major 6th', semitones: 9 },
  { id: 'm7', short: 'm7', full: 'Minor 7th', semitones: 10 },
  { id: 'M7', short: 'M7', full: 'Major 7th', semitones: 11 },
  { id: 'P8', short: 'P8', full: 'Octave', semitones: 12 },
]

// v1 beginner set: the four most distinguishable intervals. Classic pedagogy
// starts here because anchoring M3 (bright), P4 (open), P5 (stable), and P8
// (same-note feel) gives the ear strong, contrasting mental models. Other
// intervals can be introduced once these land reliably.
export const BEGINNER_SET: readonly string[] = ['M3', 'P4', 'P5', 'P8']

export function getInterval(id: string): Interval | undefined {
  return INTERVALS.find((i) => i.id === id)
}

export function getIntervalsByIds(ids: readonly string[]): Interval[] {
  return ids.map((id) => getInterval(id)).filter((i): i is Interval => i !== undefined)
}

// Pick a root pitch that keeps both notes inside a piano-friendly range.
// Clamps to [C3, C5] so the upper note of a 12-semitone interval still lands
// within the keyboard view without scrolling, and voicings don't muddy in the
// bass or sound shrill in the treble.
const ROOT_LOW = 48 // C3
const ROOT_HIGH = 72 // C5

export function pickRootPitch(semitones: number, rand: () => number = Math.random): number {
  const max = Math.max(ROOT_LOW, ROOT_HIGH - semitones)
  const span = max - ROOT_LOW
  if (span <= 0) return ROOT_LOW
  return ROOT_LOW + Math.floor(rand() * (span + 1))
}

// Fisher–Yates on a copy — leaves the caller's array untouched so the
// `BEGINNER_SET` constant stays pristine across rounds.
export function shuffle<T>(xs: readonly T[], rand: () => number = Math.random): T[] {
  const out = [...xs]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    const tmp = out[i]!
    out[i] = out[j]!
    out[j] = tmp
  }
  return out
}

// Generate a question plan for a session. Each question picks an interval
// from `set` uniformly at random (with replacement) — this is simpler than
// sampling-without-replacement because the user benefits from repeated
// exposure across a short session. Root is picked per-question.
export interface Question {
  intervalId: string
  semitones: number
  rootPitch: number
}

export function makeQuestions(
  count: number,
  set: readonly string[],
  rand: () => number = Math.random,
): Question[] {
  const pool = getIntervalsByIds(set)
  if (pool.length === 0) return []
  const out: Question[] = []
  for (let i = 0; i < count; i++) {
    const interval = pool[Math.floor(rand() * pool.length)]!
    out.push({
      intervalId: interval.id,
      semitones: interval.semitones,
      rootPitch: pickRootPitch(interval.semitones, rand),
    })
  }
  return out
}
