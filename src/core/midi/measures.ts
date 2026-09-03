// Real musical barline computation.
//
// Everything downstream of the parser works in *seconds*, but the only place
// that actually knows where a measure begins is the MIDI header (tempo map +
// time-signature map, both keyed by ticks). This module walks those maps to
// produce the absolute start time of every barline, so chord coloring can be
// pinned to genuine measures instead of a fixed-length arithmetic grid.
//
// It also handles **anacrusis** (pickup measures). Standard MIDI has no concept
// of a pickup — a piece that begins with a 1-beat upbeat still starts at tick 0
// with the nominal time signature, so a naive grid places its barlines out of
// phase and chord colors appear to change mid-measure. We recover the pickup by
// finding the whole-beat phase where the bass voice's onsets line up as
// downbeats (see detectAnacrusisTicks), restricted to simple meters where that
// estimate is trustworthy.

import type { Midi } from '@tonejs/midi'

export interface TimeSigChange {
  ticks: number
  numerator: number
  denominator: number
}

export interface Onset {
  tick: number
  pitch: number // MIDI note number; used to isolate the bass voice
}

export interface BarlineOptions {
  ppq: number // ticks per quarter note
  timeSignatures: TimeSigChange[] // sorted or unsorted; may be empty (→ 4/4)
  endTick: number // last tick that must be covered (e.g. last note end)
  onsets: Onset[] // note onsets, used only for anacrusis detection
}

// Onsets within this many semitones of the lowest note are treated as the bass
// voice for anacrusis detection.
const BASS_REGISTER_SEMITONES = 7

// Ticks per measure for a given meter: numerator beats, each worth 4/den quarters.
function barTicksFor(ppq: number, numerator: number, denominator: number): number {
  if (!(numerator > 0) || !(denominator > 0)) return 0
  return (ppq * 4 * numerator) / denominator
}

// Ticks per beat (one note of value 1/denominator).
function beatTicksFor(ppq: number, denominator: number): number {
  if (!(denominator > 0)) return 0
  return (ppq * 4) / denominator
}

// Detect a pickup measure as a whole number of beats. Returns the offset in
// ticks (0 = no anacrusis) of the first real downbeat relative to tick 0.
//
// The signal is the **bass voice**: in tonal music the lowest notes attack on
// strong beats, so the whole-beat phase where bass onsets pile up is the true
// downbeat. We deliberately look only at the bass register (and count each
// onset time once) so a dense off-beat chord can't out-vote a single bass note
// on the downbeat — the failure mode of a plain onset count on vamp-style
// accompaniments (e.g. Satie, where the bass is on beat 1 but 4-note chords sit
// on the off-beats). Phase 0 (no pickup) is the default and is only overridden
// when another phase wins by a clear margin.
export function detectAnacrusisTicks(
  ppq: number,
  numerator: number,
  denominator: number,
  onsets: Onset[],
): number {
  const barTicks = barTicksFor(ppq, numerator, denominator)
  const beatTicks = beatTicksFor(ppq, denominator)
  if (barTicks <= 0 || beatTicks <= 0 || numerator < 2 || onsets.length === 0) return 0

  // Restrict to simple meters (quarter-or-larger beat: x/2, x/4). Compound
  // meters (x/8, x/16) have a dotted-note beat that a whole-note-value phase
  // grid can't represent cleanly, so estimating a pickup there is unreliable —
  // we leave those pieces on their tick-0 grid rather than risk mis-phasing.
  if (denominator !== 2 && denominator !== 4) return 0

  // Need a few bars of material before trusting the phase estimate.
  const span = Math.max(...onsets.map((o) => o.tick))
  if (span < barTicks * 3) return 0

  // Isolate bass-voice onset *times* (each time counted once, so chords don't
  // ballot-stuff), then require a handful of them to bother estimating.
  const minPitch = Math.min(...onsets.map((o) => o.pitch))
  const bassTicks = new Set<number>()
  for (const o of onsets) {
    if (o.pitch <= minPitch + BASS_REGISTER_SEMITONES) bassTicks.add(o.tick)
  }
  if (bassTicks.size < 3) return 0

  const tolerance = beatTicks / 8 // notation MIDIs are exact; allow slight slop
  const scoreAt = (offset: number): number => {
    let score = 0
    for (const t of bassTicks) {
      const phase = (((t - offset) % barTicks) + barTicks) % barTicks
      if (phase <= tolerance || phase >= barTicks - tolerance) score++
    }
    return score
  }

  const score0 = scoreAt(0)
  let best = 0
  let bestScore = score0
  for (let beat = 1; beat < numerator; beat++) {
    const score = scoreAt(beat * beatTicks)
    if (score > bestScore) {
      bestScore = score
      best = beat * beatTicks
    }
  }

  // Require a clear win over "no pickup" so ordinary downbeat-starting pieces
  // are left untouched.
  if (best !== 0 && bestScore < score0 + Math.max(2, score0 * 0.25)) return 0
  return best
}

// Compute absolute barline start ticks covering [0, endTick]. Always begins at
// 0. Handles a single meter (with anacrusis detection) and meter changes (each
// change is assumed to fall on a barline, as engravers emit them).
export function computeBarlineTicks(opts: BarlineOptions): number[] {
  const { ppq, endTick, onsets } = opts
  if (!(ppq > 0)) return [0]

  const sigs: TimeSigChange[] =
    opts.timeSignatures.length > 0
      ? [...opts.timeSignatures].sort((a, b) => a.ticks - b.ticks)
      : [{ ticks: 0, numerator: 4, denominator: 4 }]

  const barlines: number[] = [0]

  if (sigs.length === 1) {
    const sig = sigs[0]!
    const barTicks = barTicksFor(ppq, sig.numerator, sig.denominator)
    if (barTicks <= 0) return [0]

    const pickup = detectAnacrusisTicks(ppq, sig.numerator, sig.denominator, onsets)
    // With a pickup, measure 0 is the short bar [0, pickup); the first full bar
    // starts at `pickup`. Without one, the first barline is a full bar in.
    let t = pickup > 0 ? pickup : barTicks
    for (; t <= endTick + barTicks; t += barTicks) barlines.push(t)
    return dedupeSorted(barlines)
  }

  // Meter changes: emit barlines within each segment, then let the next
  // segment's own start tick act as its opening barline.
  for (let i = 0; i < sigs.length; i++) {
    const seg = sigs[i]!
    const segEnd = i + 1 < sigs.length ? sigs[i + 1]!.ticks : endTick + 1
    const barTicks = barTicksFor(ppq, seg.numerator, seg.denominator)
    if (barTicks <= 0) continue
    for (let t = seg.ticks; t < segEnd; t += barTicks) {
      if (t > 0) barlines.push(t)
      if (t > endTick + barTicks) break
    }
  }
  return dedupeSorted(barlines)
}

function dedupeSorted(values: number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b)
  const out: number[] = []
  for (const v of sorted) {
    const last = out[out.length - 1]
    if (last === undefined || Math.abs(v - last) > 1e-6) out.push(v)
  }
  return out
}

// Extract barlines from a parsed @tonejs/midi file and convert them to seconds
// using the real tempo map (so tempo changes are honored too). The returned
// array is the value stored on MidiFile.measureStarts.
export function computeMeasureStarts(midi: Midi): number[] {
  const header = midi.header
  const ppq = header.ppq

  const timeSignatures: TimeSigChange[] = header.timeSignatures.map((ts) => ({
    ticks: ts.ticks,
    numerator: ts.timeSignature[0] ?? 4,
    denominator: ts.timeSignature[1] ?? 4,
  }))

  let endTick = 0
  const onsets: Onset[] = []
  for (const track of midi.tracks) {
    // Percussion is a drum map, not harmony — its onsets shouldn't sway the
    // anacrusis phase estimate.
    if (track.instrument.percussion) continue
    for (const note of track.notes) {
      onsets.push({ tick: note.ticks, pitch: note.midi })
      const end = note.ticks + note.durationTicks
      if (end > endTick) endTick = end
    }
  }

  const barlineTicks = computeBarlineTicks({ ppq, timeSignatures, endTick, onsets })
  return barlineTicks.map((t) => header.ticksToSeconds(t))
}
