import { type MidiFile, type MidiNote, type MidiTrack, TRACK_COLOR_SLOTS } from './types'

// `@tonejs/midi` is ~25 KB gz and only used inside this module + MidiEncoding.
// Both entry points (file picker, record export) are user-driven and already
// async, so dynamic-importing on first use keeps the SDK out of the initial
// bundle. The Promise is module-level cached so concurrent calls share one
// network/parse cost.
let midiModuleLoad: Promise<typeof import('@tonejs/midi')> | null = null
export function loadMidiModule(): Promise<typeof import('@tonejs/midi')> {
  if (!midiModuleLoad) midiModuleLoad = import('@tonejs/midi')
  return midiModuleLoad
}

// Thrown when the parser succeeds structurally but produces no playable notes.
// loadMidi() catches this alongside @tonejs/midi's own parse failures and
// surfaces a user-visible toast either way.
export class EmptyMidiError extends Error {
  constructor() {
    super('MIDI contains no playable notes.')
    this.name = 'EmptyMidiError'
  }
}

export async function parseMidiFile(source: File | ArrayBuffer, name?: string): Promise<MidiFile> {
  const buffer = source instanceof ArrayBuffer ? source : await source.arrayBuffer()
  const { Midi } = await loadMidiModule()
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
        colorIndex: i % TRACK_COLOR_SLOTS,
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
