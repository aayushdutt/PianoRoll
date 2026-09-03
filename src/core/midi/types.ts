// All timing in seconds. No ticks, no beats anywhere outside the parser.

export interface MidiNote {
  pitch: number // 0–127 (MIDI note number)
  time: number // seconds from start
  duration: number // notated length in seconds — drives visuals and learn note-off
  velocity: number // 0–1
  // Audio-only release, in seconds from start. Set by the sustain-pedal pass
  // (src/core/midi/sustain.ts) and only ever present when it extends past
  // `time + duration`. Visuals and practice scoring must keep using `duration`.
  releaseAt?: number
}

// The one place the `releaseAt ?? notated end` fallback lives — schedulers call
// this instead of reading `duration` so pedalled notes ring for their full
// audible length.
export function audibleDuration(n: MidiNote): number {
  return (n.releaseAt ?? n.time + n.duration) - n.time
}

export interface MidiTrack {
  id: string
  name: string
  channel: number
  instrument: number // GM program number 0–127
  isDrum: boolean
  notes: MidiNote[]
  colorIndex: number // index into theme.trackColors for theme-aware note/particle rendering
}

// Size of every theme's `trackColors` palette; `colorIndex` is assigned modulo
// this. Keep in sync with `Theme.trackColors.length` (asserted in theme.test.ts).
export const TRACK_COLOR_SLOTS = 8

// One tempo-map entry. `time` is seconds (converted from ticks in the parser).
export interface TempoEntry {
  time: number
  bpm: number // quarter notes per minute, as MIDI defines it
}

// One meter entry. A meter change resets bar counting from its own `time`
// (standard MIDI convention — bars never straddle a meter change).
export interface MeterEntry {
  time: number
  numerator: number
  denominator: number
}

// One sustain-pedal hold, seconds. Half-open: down at `start`, up at `end`.
export interface PedalInterval {
  start: number
  end: number
}

export interface MidiFile {
  name: string
  // Seconds. The end of the last audible note — a pedalled tail counts, so
  // playback and export run until the sound actually stops.
  duration: number
  // Sustain-pedal holds, merged across channels, ascending and disjoint. For
  // display only (the pedal indicator): audio reads `MidiNote.releaseAt`,
  // which the parser already resolved from these. Absent when the file has
  // no CC64.
  pedal?: readonly PedalInterval[]
  // Nominal/display tempo and meter: the first event of each map. Also the
  // seconds↔ticks anchor for `transport.bpm`. Do NOT walk the map at those
  // call sites — note times are already resolved seconds.
  bpm: number
  timeSignature: [number, number]
  // Full maps, seconds, strictly ascending, ALWAYS at least one entry each:
  // the parser falls back to the nominal 120 / 4-4 at time 0 when the file
  // carries no events. `src/core/midi/tempoMap.ts` additionally tolerates
  // empty arrays and a first entry at t > 0, so hand-built files can't crash
  // the beat grid.
  tempos: TempoEntry[]
  timeSignatures: MeterEntry[]
  tracks: MidiTrack[]
}

// Single-entry maps for files with no tempo/meter events of their own —
// recorded sessions (single-tempo by construction) and test fixtures.
export function nominalTempoMap(
  bpm: number,
  timeSignature: [number, number],
): Pick<MidiFile, 'tempos' | 'timeSignatures'> {
  return {
    tempos: [{ time: 0, bpm }],
    timeSignatures: [{ time: 0, numerator: timeSignature[0], denominator: timeSignature[1] }],
  }
}

// Pitch constants
export const MIDI_MIN = 21 // A0
export const MIDI_MAX = 108 // C8
export const TOTAL_KEYS = MIDI_MAX - MIDI_MIN + 1 // 88

export function pitchToNoteName(pitch: number): string {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
  const octave = Math.floor(pitch / 12) - 1
  const name = names[pitch % 12]
  return `${name}${octave}`
}

export function isBlackKey(pitch: number): boolean {
  return [1, 3, 6, 8, 10].includes(pitch % 12)
}
