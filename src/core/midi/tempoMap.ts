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
//   not meant to run per frame: BeatGrid caches its output per file, and the
//   loop helpers run on user actions.

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

// The meter in force at `time`. Bar counting restarts from the meter's own
// `time` (floored at 0 for a map that starts late).
export function meterAt(src: TempoMapSource, time: number): MeterEntry {
  const meters = src.timeSignatures
  if (meters.length === 0) return NOMINAL_METER
  return meters[indexAt(meters, time)]!
}

function beatSeconds(bpm: number, denominator: number): number {
  const den = denominator > 0 ? denominator : NOMINAL_METER.denominator
  return Math.max(MIN_BEAT_SECONDS, (4 / den) * (60 / bpm))
}

// Length of one beat (in the meter's own beat unit) at `time`.
export function secondsPerBeatAt(src: TempoMapSource, time: number): number {
  return beatSeconds(tempoAt(src, time), meterAt(src, time).denominator)
}

// Length of the bar starting at `time`, assuming constant tempo across it.
// Exact for the common case (tempo changes land on bar lines); the walker
// integrates beat-by-beat when they don't.
export function secondsPerBarAt(src: TempoMapSource, time: number): number {
  const meter = meterAt(src, time)
  const numerator = meter.numerator > 0 ? meter.numerator : NOMINAL_METER.numerator
  return numerator * beatSeconds(tempoAt(src, time), meter.denominator)
}

// Return `false` to stop the walk early.
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

export interface BeatLine {
  time: number
  isBar: boolean
}

export function beatLinesBetween(src: TempoMapSource, from: number, to: number): BeatLine[] {
  const out: BeatLine[] = []
  forEachBeatLine(src, from, to, (time, isBar) => {
    out.push({ time, isBar })
  })
  return out
}

export function barBoundariesBetween(src: TempoMapSource, from: number, to: number): number[] {
  const out: number[] = []
  forEachBeatLine(src, from, to, (time, isBar) => {
    if (isBar) out.push(time)
  })
  return out
}

// Start of the bar containing `time` (i.e. snap down to a bar line).
export function barStartAtOrBefore(src: TempoMapSource, time: number): number {
  if (time <= 0) return 0
  // Half a millisecond of slack so a time sitting exactly on a bar line snaps
  // to itself rather than to the previous bar through float drift.
  const cutoff = time + 0.0005
  let last = 0
  forEachBeatLine(src, 0, cutoff, (t, isBar) => {
    if (isBar) last = t
  })
  return Math.min(last, time)
}

// Seconds spanned by the `bars` bars immediately preceding `endTime`, using
// the real map rather than a constant. Clamps at 0 (the piece start).
export function barSpanBefore(src: TempoMapSource, endTime: number, bars: number): number {
  if (bars <= 0 || endTime <= 0) return 0
  const lines = barBoundariesBetween(src, 0, endTime + 0.0005)
  if (lines.length === 0) return endTime
  const start = lines.length > bars ? lines[lines.length - 1 - bars]! : 0
  return Math.max(0, endTime - start)
}

// Narrowing helper for the `number | TempoMapSource` overloads in LoopRegion.
export function isTempoMapSource(v: number | TempoMapSource): v is TempoMapSource {
  return typeof v === 'object' && v !== null && Array.isArray((v as TempoMapSource).tempos)
}
