import { Midi } from '@tonejs/midi'
import type { MidiFile } from '../core/midi/types'

// Shared note-event format used by both LoopEngine and SessionRecorder.
// Time is in seconds from the start of the capture.
export interface CapturedEvent {
  type: 'on' | 'off'
  pitch: number
  velocity: number
  time: number
}

export interface EncodeOptions {
  bpm?: number
  /** Close any orphan note-ons at this time (seconds). Defaults to the last
   *  event's time so nothing extends past the capture. */
  closeOrphansAt?: number
  trackName?: string
  midiName?: string
}

export function encodeCapturedEvents(
  events: readonly CapturedEvent[],
  opts: EncodeOptions = {},
): Uint8Array {
  const bpm = opts.bpm ?? 120
  const trackName = opts.trackName ?? 'Performance'
  const midiName = opts.midiName ?? 'midee capture'

  const lastEventTime = events.length === 0 ? 0 : events[events.length - 1]!.time
  const orphanCloseAt = opts.closeOrphansAt ?? lastEventTime

  const pending = new Map<number, Array<{ time: number; velocity: number }>>()
  const notes: Array<{ pitch: number; time: number; duration: number; velocity: number }> = []

  for (const e of events) {
    if (e.type === 'on') {
      const q = pending.get(e.pitch) ?? []
      q.push({ time: e.time, velocity: e.velocity })
      pending.set(e.pitch, q)
    } else {
      const on = pending.get(e.pitch)?.shift()
      if (on) {
        notes.push({
          pitch: e.pitch,
          time: on.time,
          duration: Math.max(0.01, e.time - on.time),
          velocity: on.velocity,
        })
      }
    }
  }

  for (const [pitch, queue] of pending) {
    for (const on of queue) {
      notes.push({
        pitch,
        time: on.time,
        duration: Math.max(0.01, orphanCloseAt - on.time),
        velocity: on.velocity,
      })
    }
  }

  const midi = new Midi()
  midi.header.setTempo(bpm)
  midi.name = midiName
  const track = midi.addTrack()
  track.name = trackName
  for (const n of notes) {
    track.addNote({ midi: n.pitch, time: n.time, duration: n.duration, velocity: n.velocity })
  }
  return midi.toArray()
}

// Re-encode an internal MidiFile (parsed or synthesised) back to .mid bytes.
// Preserves every track and its note set so the DAW sees the same structure
// the app was playing.
export function midiFileToBytes(source: MidiFile): Uint8Array {
  const midi = new Midi()
  midi.header.setTempo(source.bpm)
  midi.name = source.name
  for (const t of source.tracks) {
    const track = midi.addTrack()
    track.name = t.name
    track.channel = t.channel
    for (const n of t.notes) {
      track.addNote({
        midi: n.pitch,
        time: n.time,
        duration: n.duration,
        velocity: n.velocity,
      })
    }
  }
  return midi.toArray()
}

export function triggerMidiDownload(bytes: Uint8Array, filename: string): void {
  // Copy into a fresh buffer — TS's strict BlobPart typing rejects the
  // `Uint8Array<ArrayBufferLike>` that @tonejs/midi returns.
  const blob = new Blob([bytes.slice().buffer], { type: 'audio/midi' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}
