import type { MidiFile, MidiNote, MidiTrack } from '../core/midi/types'
import type { CapturedEvent } from './MidiEncoding'

// Converts a live session's captured events into the internal `MidiFile`
// shape used by renderer + synth + export. Pairs on/off events into durations
// and closes any dangling on at the session end so notes don't sustain past
// the recording.
export function sessionToMidiFile(
  events: readonly CapturedEvent[],
  duration: number,
  bpm: number,
  name = 'Live session',
): MidiFile {
  const pending = new Map<number, Array<{ time: number; velocity: number }>>()
  const notes: MidiNote[] = []

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
          duration: Math.max(0.05, e.time - on.time),
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
        duration: Math.max(0.05, duration - on.time),
        velocity: on.velocity,
      })
    }
  }
  notes.sort((a, b) => a.time - b.time)

  const track: MidiTrack = {
    id: 'track-0',
    name: 'Live performance',
    channel: 0,
    instrument: 0,
    isDrum: false,
    notes,
    colorIndex: 0,
  }

  return {
    name,
    duration,
    bpm,
    timeSignature: [4, 4],
    tracks: [track],
  }
}
