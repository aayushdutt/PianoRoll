// Pure helpers for the Play-Along loop region. No Signals, no DOM, no
// side-effects — everything here is a function of its inputs, safe to unit
// test in isolation and safe to call from any thread (there's only one, but
// the discipline keeps things flat).
//
// The runtime state machine lives in whatever exercise composes these — the
// math lives here.

// A half-open [start, end) time range. `start < end` is an invariant; the
// helpers below refuse to produce zero-or-negative ranges and callers treat
// a `null` from `makeRegion` as "loop off".
export interface LoopRegion {
  start: number
  end: number
}

// Bars → seconds using 4 beats/bar. Caller supplies BPM — this module
// doesn't bind a specific time-signature because today's content library is
// 4/4. When we ship pieces in 3/4 or 7/8 the numerator comes in as an arg.
export function barsToSeconds(bars: number, bpm: number, beatsPerBar = 4): number {
  if (bars <= 0 || bpm <= 0) return 0
  return bars * beatsPerBar * (60 / bpm)
}

// Snap `t` down to the nearest bar boundary when the metronome is running.
// Returns `t` unchanged when `enabled` is false. Useful for both ends of a
// drag-selected range.
export function barSnap(t: number, bpm: number, enabled: boolean, beatsPerBar = 4): number {
  if (!enabled || bpm <= 0) return t
  const secPerBar = beatsPerBar * (60 / bpm)
  if (secPerBar <= 0) return t
  return Math.max(0, Math.floor(t / secPerBar) * secPerBar)
}

// Build a "last N bars" region ending at the playhead. Semantic match with
// the `L` cycle preset — the user just played those bars and wants to loop
// the thing they just played. `bars = null` expands to the full piece.
//
// Near the start of a piece (playhead < span), the region shortens rather
// than shifting forward: if the user is at second 3 and asks for "last 8
// bars", they haven't played 8 bars yet, so the loop is [0, 3] — the three
// seconds they've actually heard. Callers that want a fixed-length window
// should clamp their own playhead first.
export function makeRegionFromBars(
  playhead: number,
  bars: number | null,
  bpm: number,
  pieceDuration: number,
): LoopRegion | null {
  if (pieceDuration <= 0) return null
  if (bars === null) {
    // "Full piece" preset — whole-file loop.
    return { start: 0, end: pieceDuration }
  }
  if (bars <= 0) return null
  const span = barsToSeconds(bars, bpm)
  if (span <= 0) return null
  const end = Math.min(pieceDuration, Math.max(0, playhead))
  const start = Math.max(0, end - span)
  if (end - start <= 0) return null
  return { start, end }
}

// When the playhead reaches `region.end`, wrap it back to `region.start`.
// Returns `null` when no wrap is needed; a caller that passes `null` back to
// `clock.seek` implicitly means "leave the playhead alone". `epsilon` guards
// against float-precision drift re-triggering the wrap on the next tick.
export function wrapIfAtEnd(time: number, region: LoopRegion, epsilon = 0.005): number | null {
  if (region.end <= region.start) return null
  if (time >= region.end - epsilon) return region.start
  return null
}

// Decide the next tempo percent given how many consecutive clean passes the
// user has made. `presets` is an ascending list of tempo % values (e.g.
// [60, 70, 80, 90, 100]); once past the last entry we stay at 100%. `onPass`
// is the threshold of clean passes needed per step — default 1 so the tempo
// ramps on every clean run; bump higher for stricter "mastery before
// moving on" UX.
export function ramp(
  passesClean: number,
  presets: readonly number[] = [60, 70, 80, 90, 100],
  onPass = 1,
): number {
  if (presets.length === 0) return 100
  if (passesClean <= 0) return presets[0] ?? 100
  const idx = Math.min(presets.length - 1, Math.floor(passesClean / Math.max(1, onPass)))
  return presets[idx] ?? 100
}
