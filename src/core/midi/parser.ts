import { Midi } from '@tonejs/midi'
import type { MidiFile, MidiNote, MidiTrack } from './types'

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

export async function parseMidiFile(file: File): Promise<MidiFile> {
  const buffer = await file.arrayBuffer()
  const midi = new Midi(buffer)

  const tracks: MidiTrack[] = midi.tracks
    .filter(t => t.notes.length > 0)
    .map((t, i) => {
      const notes: MidiNote[] = t.notes.map(n => ({
        pitch: n.midi,
        time: n.time,
        duration: Math.max(n.duration, 0.05), // clamp to minimum visible duration
        velocity: n.velocity,
      }))

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

  const bpm = midi.header.tempos[0]?.bpm ?? 120
  const rawTimeSig = midi.header.timeSignatures[0]?.timeSignature ?? [4, 4]
  const num = rawTimeSig[0] ?? 4
  const den = rawTimeSig[1] ?? 4

  return {
    name: file.name.replace(/\.mid[i]?$/i, ''),
    duration: midi.duration,
    bpm,
    timeSignature: [num, den] as [number, number],
    tracks,
  }
}
