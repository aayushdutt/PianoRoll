// All timing in seconds. No ticks, no beats anywhere outside the parser.

export interface MidiNote {
  pitch: number // 0–127 (MIDI note number)
  time: number // seconds from start
  duration: number // seconds
  velocity: number // 0–1
}

export interface MidiTrack {
  id: string
  name: string
  channel: number
  instrument: number // GM program number 0–127
  isDrum: boolean
  notes: MidiNote[]
  color: number // PixiJS hex color — stable base color used for track list toggle
  colorIndex: number // index into theme.trackColors for theme-aware note/particle rendering
}

export interface MidiFile {
  name: string
  duration: number // seconds
  bpm: number
  timeSignature: [number, number]
  tracks: MidiTrack[]
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
