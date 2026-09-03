import {
  applySustain,
  buildPedalIntervals,
  mergePedalIntervals,
  type PedalEvent,
  type PedalInterval,
} from './sustain'
import {
  type MeterEntry,
  MIDI_MAX,
  MIDI_MIN,
  type MidiFile,
  type MidiNote,
  type MidiTrack,
  type TempoEntry,
  TRACK_COLOR_SLOTS,
} from './types'

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

// What a real-world file contains beyond the notes we keep. Measured here
// (the only place the raw @tonejs/midi object exists) and reported by the
// caller — the parser itself stays side-effect-free.
export interface MidiParseStats {
  outOfRangeNotes: number // notes outside A0–C8: audible, but nothing to draw them on
  hasSustainPedal: boolean // any CC64 event, on any track
  tempoEvents: number // >1 means the file carries a tempo map (the beat grid follows it)
}

export async function parseMidiFile(source: File | ArrayBuffer, name?: string): Promise<MidiFile> {
  return (await parseMidiFileWithStats(source, name)).midi
}

export async function parseMidiFileWithStats(
  source: File | ArrayBuffer,
  name?: string,
): Promise<{ midi: MidiFile; stats: MidiParseStats }> {
  const buffer = source instanceof ArrayBuffer ? source : await source.arrayBuffer()
  const { Midi } = await loadMidiModule()
  const midi = new Midi(buffer)

  // Read CC64 across ALL tracks before the notes filter below drops
  // CC-only tracks — piano MIDI routinely puts pedal on its own track, on the
  // same channel as the notes it applies to. Merge per channel for that reason.
  const pedalEventsByChannel = new Map<number, PedalEvent[]>()
  for (const t of midi.tracks) {
    const cc = t.controlChanges[64]
    if (!cc || cc.length === 0) continue
    const list = pedalEventsByChannel.get(t.channel) ?? []
    for (const ev of cc) list.push({ time: ev.time, value: ev.value })
    pedalEventsByChannel.set(t.channel, list)
  }
  const hasSustainPedal = pedalEventsByChannel.size > 0
  let outOfRangeNotes = 0

  const tracks: MidiTrack[] = midi.tracks
    .filter((t) => t.notes.length > 0)
    .map((t, i) => {
      const notes: MidiNote[] = t.notes.map((n) => {
        if (n.midi < MIDI_MIN || n.midi > MIDI_MAX) outOfRangeNotes++
        return {
          pitch: n.midi,
          time: n.time,
          duration: Math.max(n.duration, 0.05), // clamp to minimum visible duration
          velocity: n.velocity,
        }
      })
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

  // Pedal resolution is pitch-independent, so it runs here on the parsed
  // pitches; deriveMidi (transpose) preserves `releaseAt` downstream.
  //
  // `duration` must cover the pedalled tail: playback stops and the export
  // trims at `duration`, so a final chord held on the pedal past its notated
  // end would otherwise be cut off mid-ring. An unlifted pedal is clamped to
  // the notated end inside buildPedalIntervals, so only an explicit pedal-up
  // past the last note-off can extend it.
  let duration = midi.duration
  let pedal: PedalInterval[] | null = null
  if (hasSustainPedal) {
    const pedalByChannel = new Map<number, PedalInterval[]>()
    for (const [channel, events] of pedalEventsByChannel) {
      pedalByChannel.set(channel, buildPedalIntervals(events, midi.duration))
    }
    pedal = mergePedalIntervals(pedalByChannel.values())
    const sustained = applySustain(tracks, pedalByChannel)
    for (let i = 0; i < tracks.length; i++) {
      tracks[i]!.notes = sustained[i]!
      for (const n of sustained[i]!) {
        if (n.releaseAt !== undefined && n.releaseAt > duration) duration = n.releaseAt
      }
    }
  }

  // Tempo/meter maps. `TempoEvent.time` is optional and `TimeSignatureEvent`
  // has no seconds field at all, so both go through `header.ticksToSeconds`
  // here — the last place ticks are allowed to exist. Sorted and de-duplicated
  // so `tempoMap.ts` can assume ascending order; a nominal entry at time 0 is
  // injected when the file carries none, so both arrays are never empty.
  const tempos: TempoEntry[] = midi.header.tempos
    .map((t) => ({ time: t.time ?? midi.header.ticksToSeconds(t.ticks), bpm: t.bpm }))
    .filter((t) => Number.isFinite(t.time) && t.bpm > 0)
    .sort((a, b) => a.time - b.time)

  const timeSignatures: MeterEntry[] = midi.header.timeSignatures
    .map((ts) => ({
      time: midi.header.ticksToSeconds(ts.ticks),
      numerator: ts.timeSignature[0] ?? 4,
      denominator: ts.timeSignature[1] ?? 4,
    }))
    .filter((m) => Number.isFinite(m.time) && m.numerator > 0 && m.denominator > 0)
    .sort((a, b) => a.time - b.time)

  const bpm = tempos[0]?.bpm ?? 120
  const num = timeSignatures[0]?.numerator ?? 4
  const den = timeSignatures[0]?.denominator ?? 4
  if (tempos.length === 0) tempos.push({ time: 0, bpm })
  if (timeSignatures.length === 0)
    timeSignatures.push({ time: 0, numerator: num, denominator: den })

  const rawName = name ?? (source instanceof File ? source.name : 'Untitled')
  return {
    midi: {
      name: rawName.replace(/\.mid[i]?$/i, ''),
      duration,
      bpm,
      timeSignature: [num, den] as [number, number],
      tempos,
      timeSignatures,
      tracks,
      // exactOptionalPropertyTypes: omit rather than assign undefined.
      ...(pedal && pedal.length > 0 ? { pedal } : {}),
    },
    stats: { outOfRangeNotes, hasSustainPedal, tempoEvents: midi.header.tempos.length },
  }
}
