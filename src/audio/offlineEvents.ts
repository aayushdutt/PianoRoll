// Pure helper extracted from OfflineAudioRenderer so the disabled-track
// filtering can be unit-tested without instantiating an OfflineAudioContext
// (which jsdom lacks) or pulling Tone (which won't resolve under vitest).

import { audibleDuration, type MidiFile } from '../core/midi/types'
import { midiToNoteName } from './midiNoteName'

export interface OfflineNoteEvent {
  time: number
  note: string
  duration: number // audible length (pedal-extended), not the notated one
  velocity: number
}

// Flattens midi.tracks → time-ordered note events, skipping any track the
// user has muted in the Tracks panel. The export pipeline calls this so the
// rendered MP4's audio matches what the user heard interactively.
export function buildOfflineEvents(
  midi: MidiFile,
  disabledTrackIds?: ReadonlySet<string>,
): OfflineNoteEvent[] {
  const events: OfflineNoteEvent[] = []
  for (const track of midi.tracks) {
    if (disabledTrackIds?.has(track.id)) continue
    for (const note of track.notes) {
      events.push({
        time: note.time,
        note: midiToNoteName(note.pitch),
        // Offline render has no speed control, so no 1/speed scaling here.
        duration: audibleDuration(note),
        velocity: note.velocity,
      })
    }
  }
  return events
}
