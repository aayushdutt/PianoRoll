import type { MidiNote } from './types'

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

export interface PedalInterval {
  start: number // seconds, pedal down
  end: number // seconds, pedal up (clamped to the file end if never lifted)
}

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

// Pedal is down at `t` when some interval covers it. Intervals are sorted and
// non-overlapping by construction, so a linear scan from a moving cursor would
// work too; note counts here are small enough that clarity wins.
function pedalEndAt(intervals: readonly PedalInterval[], t: number): number | null {
  for (const iv of intervals) {
    if (iv.start > t) break
    if (t < iv.end) return iv.end
  }
  return null
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
        if (capped > notatedEnd) {
          releases[ref.t]![ref.i] = capped
          ringing.set(note.pitch, ref)
          continue
        }
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
