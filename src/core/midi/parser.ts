import { Midi } from '@tonejs/midi'
import type { MidiFile, MidiNote, MidiTrack } from './types'

// Thrown when the parser succeeds structurally but produces no playable notes.
// loadMidi() catches this alongside @tonejs/midi's own parse failures and
// surfaces a user-visible toast either way.
export class EmptyMidiError extends Error {
  constructor() {
    super('MIDI contains no playable notes.')
    this.name = 'EmptyMidiError'
  }
}

// Distinct, vibrant track colors — ordered for visual variety
const TRACK_COLORS = [
  0x6366f1, // indigo
  0xec4899, // pink
  0x06b6d4, // cyan
  0xf59e0b, // amber
  0x10b981, // emerald
  0x8b5cf6, // violet
  0xf97316, // orange
  0x3b82f6, // blue
  0xe11d48, // rose
  0x14b8a6, // teal
]

export async function parseMidiFile(source: File | ArrayBuffer, name?: string): Promise<MidiFile> {
  const buffer = source instanceof ArrayBuffer ? source : await source.arrayBuffer()
  const midi = new Midi(buffer)

  const tracks: MidiTrack[] = midi.tracks
    .filter((t) => t.notes.length > 0)
    .map((t, i) => {
      const notes: MidiNote[] = t.notes.map((n) => ({
        pitch: n.midi,
        time: n.time,
        duration: Math.max(n.duration, 0.05), // clamp to minimum visible duration
        velocity: n.velocity,
      }))
      // Guarantee ascending time order so downstream code (scheduler binary
      // search, visible-range culling) can rely on the invariant without
      // re-sorting. @tonejs/midi usually emits them sorted already, but edited
      // MIDIs can arrive out of order.
      notes.sort((a, b) => a.time - b.time)

      return {
        id: `track-${i}`,
        name: t.name || `Track ${i + 1}`,
        channel: t.channel,
        instrument: t.instrument.number,
        isDrum: t.instrument.percussion,
        notes,
        color: TRACK_COLORS[i % TRACK_COLORS.length] as number,
        colorIndex: i % TRACK_COLORS.length,
      }
    })

  if (tracks.length === 0) throw new EmptyMidiError()

  const bpm = midi.header.tempos[0]?.bpm ?? 120
  const rawTimeSig = midi.header.timeSignatures[0]?.timeSignature ?? [4, 4]
  const num = rawTimeSig[0] ?? 4
  const den = rawTimeSig[1] ?? 4

  const rawName = name ?? (source instanceof File ? source.name : 'Untitled')
  return {
    name: rawName.replace(/\.mid[i]?$/i, ''),
    duration: midi.duration,
    bpm,
    timeSignature: [num, den] as [number, number],
    tracks,
  }
}
