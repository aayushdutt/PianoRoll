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

import type { MeterEntry, TempoEntry } from './types'

// Anything carrying the two maps — `MidiFile` satisfies this structurally.
export interface TempoMapSource {
  tempos: readonly TempoEntry[]
  timeSignatures: readonly MeterEntry[]
}

const NOMINAL_BPM = 120
const NOMINAL_NUMERATOR = 4
const NOMINAL_DENOMINATOR = 4

// Absurd tempi (a corrupt file can encode 60000 bpm) would otherwise spin the
// beat walker for millions of iterations inside a draw call.
const MIN_BEAT_SECONDS = 0.02

export function tempoAt(src: TempoMapSource, time: number): number {
  const tempos = src.tempos
  if (tempos.length === 0) return NOMINAL_BPM
  // Files carry a handful of tempo events; a linear scan beats a binary search
  // and keeps this allocation-free.
  let bpm = tempos[0]!.bpm
  for (let i = 1; i < tempos.length; i++) {
    const t = tempos[i]!
    if (t.time > time) break
    bpm = t.bpm
  }
  return bpm > 0 ? bpm : NOMINAL_BPM
}

const NOMINAL_METER: MeterEntry = {
  time: 0,
  numerator: NOMINAL_NUMERATOR,
  denominator: NOMINAL_DENOMINATOR,
}

// The meter in force at `time`, plus the timestamp bar counting restarts from
// (the meter's own `time`, floored at 0 for a map that starts late).
export function meterAt(src: TempoMapSource, time: number): MeterEntry {
  const meters = src.timeSignatures
  if (meters.length === 0) return NOMINAL_METER
  let meter = meters[0]!
  for (let i = 1; i < meters.length; i++) {
    const m = meters[i]!
    if (m.time > time) break
    meter = m
  }
  return meter
}

function beatSeconds(bpm: number, denominator: number): number {
  const den = denominator > 0 ? denominator : NOMINAL_DENOMINATOR
  return Math.max(MIN_BEAT_SECONDS, (4 / den) * (60 / bpm))
}

// Length of one beat (in the meter's own beat unit) at `time`.
export function secondsPerBeatAt(src: TempoMapSource, time: number): number {
  return beatSeconds(tempoAt(src, time), meterAt(src, time).denominator)
}

// Length of the bar starting at `time`, assuming constant tempo across it.
// Exact for the common case (tempo changes land on bar lines); the walkers
// below integrate beat-by-beat when they don't.
export function secondsPerBarAt(src: TempoMapSource, time: number): number {
  const meter = meterAt(src, time)
  const numerator = meter.numerator > 0 ? meter.numerator : NOMINAL_NUMERATOR
  return numerator * beatSeconds(tempoAt(src, time), meter.denominator)
}

// Return `false` to stop the walk early.
export type BeatVisitor = (time: number, isBar: boolean) => boolean | void

// Safety net: a pathological map can't hang a frame.
const MAX_STEPS = 1_000_000

// Walk beat lines in [from, to], emitting only inside the window but counting
// bars from each meter anchor so phase is correct however far in the walker
// starts. Constant-tempo stretches before the window are skipped analytically,
// which is what makes this cheap enough for a per-frame draw call.
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
    if (segEnd <= from) continue
    if (segStart > to) break

    const numerator = meter.numerator > 0 ? meter.numerator : NOMINAL_NUMERATOR
    let t = segStart
    let beat = 0

    while (t <= to && t < segEnd) {
      if (++steps > MAX_STEPS) return
      const dur = beatSeconds(tempoAt(src, t), meter.denominator)
      if (t >= from) {
        if (visit(t, beat % numerator === 0) === false) return
        t += dur
        beat++
        continue
      }
      // Still before the window: jump whole beats up to the next boundary that
      // could change `dur` (a tempo change, the window start, or the meter end).
      const limit = Math.min(from, segEnd, nextTempoTimeAfter(src, t))
      const skip = Math.max(1, Math.floor((limit - t) / dur))
      t += skip * dur
      beat += skip
    }
  }
}

function nextTempoTimeAfter(src: TempoMapSource, time: number): number {
  const tempos = src.tempos
  for (let i = 0; i < tempos.length; i++) {
    const t = tempos[i]!
    if (t.time > time) return t.time
  }
  return Number.POSITIVE_INFINITY
}

export interface BeatLine {
  time: number
  isBar: boolean
}

// Array-returning convenience over `forEachBeatLine` — for tests and cold
// paths. The renderer uses the visitor form to stay allocation-free.
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
    if (!isBar) return
    if (t > cutoff) return false
    last = t
  })
  return Math.min(last, time)
}

// Seconds spanned by the `bars` bars immediately preceding `endTime`, using
// the real map rather than a constant. Clamps at 0 (the piece start).
export function barSpanBefore(src: TempoMapSource, endTime: number, bars: number): number {
  if (bars <= 0 || endTime <= 0) return 0
  const cutoff = endTime + 0.0005
  // Ring buffer of the last `bars + 1` bar lines: the one `bars` back is the
  // span's start. Bounded memory regardless of piece length.
  const ring: number[] = new Array(bars + 1).fill(0)
  let count = 0
  forEachBeatLine(src, 0, cutoff, (t, isBar) => {
    if (!isBar) return
    if (t > cutoff) return false
    ring[count % ring.length] = t
    count++
  })
  if (count === 0) return endTime
  const start = count > bars ? ring[(count - 1 - bars) % ring.length]! : 0
  return Math.max(0, endTime - start)
}

// Narrowing helper for the `number | TempoMapSource` overloads in LoopRegion.
export function isTempoMapSource(v: number | TempoMapSource): v is TempoMapSource {
  return typeof v === 'object' && v !== null && Array.isArray((v as TempoMapSource).tempos)
}
