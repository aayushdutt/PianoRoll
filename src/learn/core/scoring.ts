// Pure scoring primitives shared across exercises. Every "did the user hit
// that note?" decision eventually runs through one of these — keep them
// allocation-free on the hot path and deterministic for unit tests.

// Hit-window tolerance (seconds) around the scheduled time. Matches the
// ±100 ms target from the v2 plan. Anything outside the window is a miss;
// exercises decide whether to let it pass, rewind, or wait.
export const DEFAULT_HIT_WINDOW_SEC = 0.1
// Chord-matching window. A chord registers only if all expected pitches
// arrive within this of each other — 80 ms lets a comfortable arpeggiation
// count as a single chord without collapsing two distinct chords together.
export const DEFAULT_CHORD_WINDOW_SEC = 0.08

// `early` / `late` are both misses with a timing direction attached — most
// exercises collapse them back to "miss" for scoring, but sight-reading
// wants the direction to drive nudge feedback. If a future exercise needs a
// non-timing miss reason (wrong pitch, extra press), add the variant here.
export type TimingVerdict = 'hit' | 'early' | 'late'

// Classify a single pitch press against a scheduled note time. Callers that
// already know the press landed on the wrong pitch shouldn't call this —
// this helper is purely a timing verdict.
export function classifyTiming(
  actualTime: number,
  scheduledTime: number,
  window = DEFAULT_HIT_WINDOW_SEC,
): TimingVerdict {
  const delta = actualTime - scheduledTime
  if (Math.abs(delta) <= window) return 'hit'
  return delta < 0 ? 'early' : 'late'
}

// Accuracy in [0, 1]. Zero attempts returns 1 (vacuously clean) so a user
// who quits an exercise before playing anything doesn't get a 0% banner.
// Consumers that want "unplayed → N/A" should check attempts themselves.
export function accuracy(hits: number, attempts: number): number {
  if (attempts <= 0) return 1
  return Math.max(0, Math.min(1, hits / attempts))
}

// Weighted XP formula shared by exercises that don't need a custom curve.
// The inputs are all 0..1-style fractions except `difficultyWeight` which is
// an exercise-authored constant (beginner=1, intermediate=1.5, advanced=2
// by convention; exercises can deviate).
//
// The formula: base * accuracy² * difficultyWeight * min(1, duration/60).
// Squaring accuracy rewards clean runs disproportionately; the duration
// clamp means short drills and long pieces earn on the same scale without
// letting a 5-second flashcard farm infinite XP.
export function computeXp(opts: {
  accuracy: number
  duration_s: number
  difficultyWeight: number
  base?: number
}): number {
  const base = opts.base ?? 20
  const accSq = opts.accuracy * opts.accuracy
  const durFactor = Math.min(1, Math.max(0, opts.duration_s) / 60)
  return Math.max(0, Math.round(base * accSq * opts.difficultyWeight * durFactor))
}

// Chord-match helper for wait-mode / chord-ID style exercises. Given the set
// of pitches the user has pressed so far and the set of pitches required by
// the current step, return whether the chord is complete, and the pending
// pitches still missing. Extra pitches are ignored — the caller decides
// whether to penalize or merely log them.
export interface ChordMatch {
  complete: boolean
  pending: Set<number>
  matched: Set<number>
}

export function matchChord(
  required: ReadonlySet<number>,
  pressed: ReadonlySet<number>,
): ChordMatch {
  const matched = new Set<number>()
  const pending = new Set<number>()
  for (const p of required) {
    if (pressed.has(p)) matched.add(p)
    else pending.add(p)
  }
  return { complete: pending.size === 0 && required.size > 0, pending, matched }
}
