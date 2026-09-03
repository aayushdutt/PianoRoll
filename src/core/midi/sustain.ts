import type { MidiNote, PedalInterval } from './types'

export type { PedalInterval } from './types'

// Resolves CC64 (sustain pedal) into note data at parse time: a note whose
// notated end falls under a held pedal gets a `releaseAt` past that end.
// `InstrumentRuntime` has no pedal method (~12 instruments, only one with a
// real damper), so pedal lives in the data, not the audio graph — the same
// "deferred note-off" model LivePerformanceBus uses for live input.
//
// Constraints:
// - seconds only, like every other module outside the parser's tick math
// - pure: inputs are never mutated; notes without a release come back by
//   reference
// - `releaseAt` is emitted only when it extends past the notated end, and
//   never as `undefined` (exactOptionalPropertyTypes)
// - `duration` is left alone — visuals and learn stay notated

// Half-pedal is not modelled: @tonejs/midi normalizes CC values to 0–1, so
// down is value >= 0.5 (i.e. raw >= ~64).
const PEDAL_DOWN = 0.5

// A stuck pedal in a bad file would otherwise hold every note to EOF and blow
// the voice count.
const MAX_SUSTAIN_EXTENSION = 15

export interface PedalEvent {
  time: number
  value: number // 0–1, as @tonejs/midi reports it
}

export interface ChannelNotes {
  channel: number
  notes: readonly MidiNote[] // ascending time (parser invariant)
}

// Collapses raw CC64 events into down/up spans. Events may arrive from several
// tracks of one channel, so they are sorted here rather than assumed ordered.
// Repeated downs (or ups) are idempotent; an unlifted pedal ends at `endTime`.
export function buildPedalIntervals(
  events: readonly PedalEvent[],
  endTime: number,
): PedalInterval[] {
  const sorted = [...events].sort((a, b) => a.time - b.time)
  const intervals: PedalInterval[] = []
  let downAt: number | null = null
  for (const ev of sorted) {
    if (ev.value >= PEDAL_DOWN) {
      if (downAt === null) downAt = ev.time
    } else if (downAt !== null) {
      if (ev.time > downAt) intervals.push({ start: downAt, end: ev.time })
      downAt = null
    }
  }
  if (downAt !== null && endTime > downAt) intervals.push({ start: downAt, end: endTime })
  return intervals
}

// Index of the interval covering `t`, or -1. Intervals are ascending and
// disjoint by construction, so binary search. Shared by the parse-time pass
// (once per note) and the per-tick indicator lookup.
function intervalIndexAt(intervals: readonly PedalInterval[], t: number): number {
  let lo = 0
  let hi = intervals.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1
    const iv = intervals[mid]!
    if (t < iv.start) hi = mid - 1
    else if (t >= iv.end) lo = mid + 1
    else return mid
  }
  return -1
}

function pedalEndAt(intervals: readonly PedalInterval[], t: number): number | null {
  const i = intervalIndexAt(intervals, t)
  return i === -1 ? null : intervals[i]!.end
}

// Per-track note lists in, per-track note lists out (same order, same lengths).
// Takes every track at once because both the pedal spans and the re-strike cut
// are per CHANNEL across tracks — real piano MIDI often puts CC64 on its own
// note-less track beside the notes it applies to.
// The EOF clamp for an unlifted pedal lives in buildPedalIntervals, not here:
// a pedal-up event can legitimately sit past the last note-off, and truncating
// to the file duration would silently drop that tail.
export function applySustain(
  tracks: readonly ChannelNotes[],
  pedalByChannel: ReadonlyMap<number, readonly PedalInterval[]>,
): MidiNote[][] {
  // Parallel to `tracks`: the resolved release per note, or null for "notated".
  const releases: (number | null)[][] = tracks.map((t) => t.notes.map(() => null))

  const channels = new Set(tracks.map((t) => t.channel))
  for (const channel of channels) {
    const intervals = pedalByChannel.get(channel)
    if (!intervals || intervals.length === 0) continue

    // One time-ordered view of the channel's notes across all its tracks, so a
    // re-strike on one track can cut a sustained note on another.
    const refs: Array<{ t: number; i: number; note: MidiNote }> = []
    for (let t = 0; t < tracks.length; t++) {
      const track = tracks[t]!
      if (track.channel !== channel) continue
      for (let i = 0; i < track.notes.length; i++) refs.push({ t, i, note: track.notes[i]! })
    }
    refs.sort((a, b) => a.note.time - b.note.time)

    // Last still-ringing note per pitch, so the next strike can cut it.
    const ringing = new Map<number, { t: number; i: number; note: MidiNote }>()

    for (const ref of refs) {
      const { note } = ref
      const notatedEnd = note.time + note.duration

      const prev = ringing.get(note.pitch)
      if (prev && note.time > prev.note.time) {
        const prevRelease = releases[prev.t]![prev.i] ?? null
        // Repress-release: the new strike takes the string, so the sustained
        // tail of the previous note stops here.
        if (prevRelease !== null && prevRelease > note.time) {
          releases[prev.t]![prev.i] = note.time
        }
      }

      const pedalEnd = pedalEndAt(intervals, notatedEnd)
      if (pedalEnd !== null) {
        const capped = Math.min(pedalEnd, notatedEnd + MAX_SUSTAIN_EXTENSION)
        if (capped > notatedEnd) releases[ref.t]![ref.i] = capped
      }
      ringing.set(note.pitch, ref)
    }
  }

  return tracks.map((track, t) =>
    track.notes.map((note, i) => {
      const release = releases[t]![i] ?? null
      // Guard again after the re-strike cut: a cut can pull the release back to
      // (or before) the notated end, in which case the note is just notated.
      if (release === null || release <= note.time + note.duration) return note
      return { ...note, releaseAt: release }
    }),
  )
}

// Union of per-channel holds into one ascending, disjoint list — the file's
// pedal as a whole, for display. Touching intervals are joined so the
// indicator doesn't flicker on a pedal re-press at the exact same tick.
export function mergePedalIntervals(lists: Iterable<readonly PedalInterval[]>): PedalInterval[] {
  const all: PedalInterval[] = []
  for (const list of lists) for (const iv of list) if (iv.end > iv.start) all.push(iv)
  all.sort((a, b) => a.start - b.start)
  const out: PedalInterval[] = []
  for (const iv of all) {
    const last = out[out.length - 1]
    if (last && iv.start <= last.end) {
      if (iv.end > last.end) last.end = iv.end
    } else {
      out.push({ start: iv.start, end: iv.end })
    }
  }
  return out
}

// Pedal down at `t`? Runs on every clock tick while a piece plays.
export function pedalDownAt(intervals: readonly PedalInterval[], t: number): boolean {
  return intervalIndexAt(intervals, t) !== -1
}
