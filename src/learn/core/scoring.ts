// Pure scoring primitives shared across exercises. Every "did the user hit
// that note?" decision eventually runs through one of these — keep them
// allocation-free on the hot path and deterministic for unit tests.

// ── Time-based windows ────────────────────────────────────────────────────
//
// Used by exercises that grade against a *scheduled time* (sight-read, real-
// tempo follow). Wait-mode exercises grade against chord articulation
// instead — see `classifyArticulation` below.
//
// The two-tier window models human keystroke jitter against a metronome:
// inside ±50 ms the press feels exactly on the beat; out to ±150 ms it still
// feels rhythmic; beyond that it's noticeably ahead/behind.

export const PERFECT_WINDOW_SEC = 0.05
export const GOOD_WINDOW_SEC = 0.15
// A press beyond `GOOD_WINDOW_SEC` but inside `LATE_HIT_WINDOW_SEC` of a
// passed onset still counts as a hit for non-wait modes (the user "caught
// up"). Outside this window the press is a miss.
export const LATE_HIT_WINDOW_SEC = 0.3
// Legacy shim — older callers passed `window` to `classifyTiming` without
// distinguishing perfect/good. Still honoured when the caller supplies it
// explicitly.
export const DEFAULT_HIT_WINDOW_SEC = GOOD_WINDOW_SEC
// Chord-matching window. A chord registers only if all expected pitches
// arrive within this of each other — 80 ms lets a comfortable arpeggiation
// count as a single chord without collapsing two distinct chords together.
export const DEFAULT_CHORD_WINDOW_SEC = 0.08

// 5 verdicts on the time axis:
//   `perfect` / `good` — cleanly inside their windows
//   `early` / `late`   — outside `good` but inside `LATE_HIT_WINDOW_SEC`
//                        (still a hit, just timed)
//   `miss`             — beyond `LATE_HIT_WINDOW_SEC`
//
// Most exercises collapse `early`/`late` to "good" for scoring; sight-read
// keeps the direction so it can nudge ("a hair early") without a red flash.
export type TimingVerdict = 'perfect' | 'good' | 'early' | 'late' | 'miss'

export interface ClassifyTimingOptions {
  perfectWindow?: number
  goodWindow?: number
  // Past `goodWindow` but inside this is a directional miss (`early`/`late`).
  // Past this is a flat `miss`.
  lateWindow?: number
}

// Classify a single pitch press against a scheduled note time. Callers that
// already know the press landed on the wrong pitch shouldn't call this —
// this helper is purely a timing verdict.
export function classifyTiming(
  actualTime: number,
  scheduledTime: number,
  opts?: ClassifyTimingOptions,
): TimingVerdict {
  const perfect = opts?.perfectWindow ?? PERFECT_WINDOW_SEC
  const good = opts?.goodWindow ?? GOOD_WINDOW_SEC
  const late = opts?.lateWindow ?? LATE_HIT_WINDOW_SEC
  const delta = actualTime - scheduledTime
  const abs = Math.abs(delta)
  if (abs <= perfect) return 'perfect'
  if (abs <= good) return 'good'
  if (abs > late) return 'miss'
  return delta < 0 ? 'early' : 'late'
}

// ── Chord articulation (wait-mode) ────────────────────────────────────────
//
// In wait-mode there is no "scheduled time" to grade against — the engine
// pauses the clock until the user clears the chord. The relevant skill
// metric is *articulation cohesion*: did the chord arrive as one motion, or
// did it stagger across half a second? Cohesive arpeggiation feels like
// playing; stagger feels like hunting.

export const PERFECT_ARTICULATION_MS = 80
export const GOOD_ARTICULATION_MS = 200

// Wait-mode never punishes below `'good'` — the user got the chord, that's
// the point of the mode. Out beyond `goodMs` we still call it `'good'`
// (instead of inventing a "slow" verdict) so the HUD only ever needs two
// positive bands.
export function classifyArticulation(
  articulationMs: number,
  opts?: { perfectMs?: number },
): 'perfect' | 'good' {
  const perfect = opts?.perfectMs ?? PERFECT_ARTICULATION_MS
  return articulationMs <= perfect ? 'perfect' : 'good'
}

// ── Aggregate accuracy ────────────────────────────────────────────────────

// Accuracy in [0, 1]. Zero attempts returns 1 (vacuously clean) so a user
// who quits an exercise before playing anything doesn't get a 0% banner.
// Consumers that want "unplayed → N/A" should check attempts themselves.
export function accuracy(hits: number, attempts: number): number {
  if (attempts <= 0) return 1
  return Math.max(0, Math.min(1, hits / attempts))
}

// ── XP curve ──────────────────────────────────────────────────────────────

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

// ── Chord match helper ────────────────────────────────────────────────────

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
