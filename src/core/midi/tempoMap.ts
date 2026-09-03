// Bar/beat math over a MIDI tempo + meter map. Pure: no Pixi, no store, no
// side-effects. Seconds in, seconds out — the ticks→seconds conversion already
// happened in the parser.
//
// Constraints:
// - Both arrays are expected ascending. Empty arrays and a first entry at
//   t > 0 are tolerated (nominal 120 / 4-4 fallback, first entry extended back
//   to 0) so hand-built `MidiFile`s can't crash the beat grid.
// - A meter change RESETS bar counting from its own timestamp: bars never
//   straddle a meter change. Beat phase resets with it.
// - Beat unit follows the meter denominator (6/8 counts eighths), tempo bpm is
//   quarter notes per minute. secondsPerBeat = (4/denominator) * (60/bpm).
// - `transport.bpm` call sites must keep using the scalar `MidiFile.bpm`.
//   Nothing here is for them.
// - The walker is a plain beat-by-beat loop from each meter anchor. It is
//   not meant to run per frame: BeatGrid walks the piece once per file.
// - Only the walker (and `tempoAt`, for callers that need a bpm at a time)
//   is exported. Per-time meter / beat-length lookups were removed unused.

import type { MeterEntry, TempoEntry } from './types'

// Anything carrying the two maps — `MidiFile` satisfies this structurally.
export interface TempoMapSource {
  tempos: readonly TempoEntry[]
  timeSignatures: readonly MeterEntry[]
}

const NOMINAL_BPM = 120
const NOMINAL_METER: MeterEntry = { time: 0, numerator: 4, denominator: 4 }

// Absurd tempi (a corrupt file can encode 60000 bpm) would otherwise spin the
// beat walker for millions of iterations.
const MIN_BEAT_SECONDS = 0.02

// Index of the last entry at or before `time`; 0 when `time` precedes the
// first entry (it is extended back to the piece start). Binary search because
// DAW exports with tempo ramps can carry thousands of entries.
function indexAt(entries: readonly { time: number }[], time: number): number {
  let lo = 0
  let hi = entries.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1
    if (entries[mid]!.time <= time) lo = mid
    else hi = mid - 1
  }
  return lo
}

export function tempoAt(src: TempoMapSource, time: number): number {
  const tempos = src.tempos
  if (tempos.length === 0) return NOMINAL_BPM
  const bpm = tempos[indexAt(tempos, time)]!.bpm
  return bpm > 0 ? bpm : NOMINAL_BPM
}

function beatSeconds(bpm: number, denominator: number): number {
  const den = denominator > 0 ? denominator : NOMINAL_METER.denominator
  return Math.max(MIN_BEAT_SECONDS, (4 / den) * (60 / bpm))
}

// Return `false` to stop the walk early; a visitor that never stops needs no
// return at all, hence `void` rather than `undefined` (callers would otherwise
// have to write `return undefined`).
// biome-ignore lint/suspicious/noConfusingVoidType: see above
export type BeatVisitor = (time: number, isBar: boolean) => boolean | void

// Safety net: a pathological map can't hang the caller.
const MAX_STEPS = 1_000_000

// Walk beat lines in [from, to], emitting only inside the window but counting
// bars from each meter anchor so phase is correct regardless of the window.
export function forEachBeatLine(
  src: TempoMapSource,
  from: number,
  to: number,
  visit: BeatVisitor,
): void {
  if (!(to >= from)) return
  const meters = src.timeSignatures
  const meterCount = meters.length === 0 ? 1 : meters.length
  let steps = 0

  for (let mi = 0; mi < meterCount; mi++) {
    const meter = meters[mi] ?? NOMINAL_METER
    // The first meter is extended back to 0 regardless of its timestamp.
    const segStart = mi === 0 ? 0 : Math.max(0, meter.time)
    const next = meters[mi + 1]
    const segEnd = next ? Math.max(segStart, next.time) : Number.POSITIVE_INFINITY
    // A segment entirely before the window carries no phase into the next
    // one (bars reset at the meter change), so it can be skipped whole.
    if (segEnd <= from) continue
    if (segStart > to) break

    const numerator = meter.numerator > 0 ? meter.numerator : NOMINAL_METER.numerator
    let t = segStart
    for (let beat = 0; t <= to && t < segEnd; beat++) {
      if (++steps > MAX_STEPS) return
      if (t >= from && visit(t, beat % numerator === 0) === false) return
      t += beatSeconds(tempoAt(src, t), meter.denominator)
    }
  }
}
