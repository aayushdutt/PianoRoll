import { describe, expect, it } from 'vitest'
import { type MidiFile, type MidiTrack, nominalTempoMap } from '../core/midi/types'
import { buildOfflineEvents } from './offlineEvents'

function track(id: string, pitches: number[]): MidiTrack {
  return {
    id,
    name: id,
    channel: 0,
    instrument: 0,
    isDrum: false,
    colorIndex: 0,
    notes: pitches.map((pitch, i) => ({
      pitch,
      time: i * 0.5,
      duration: 0.4,
      velocity: 0.8,
    })),
  }
}

const midi = (tracks: MidiTrack[]): MidiFile => ({
  name: 'test',
  bpm: 120,
  duration: 4,
  tracks,
  timeSignature: [4, 4],
  ...nominalTempoMap(120, [4, 4]),
})

describe('buildOfflineEvents', () => {
  it('flattens every track when no tracks are disabled', () => {
    const events = buildOfflineEvents(midi([track('a', [60, 62]), track('b', [64])]))
    expect(events).toHaveLength(3)
  })

  it('omits notes from disabled tracks so muted tracks do not appear in exports', () => {
    const events = buildOfflineEvents(
      midi([track('a', [60, 62]), track('b', [64])]),
      new Set(['a']),
    )
    expect(events).toHaveLength(1)
    expect(events[0]?.note).toBe('E4')
  })

  it('treats undefined and empty disabled sets as "all tracks audible"', () => {
    const m = midi([track('a', [60]), track('b', [64])])
    expect(buildOfflineEvents(m, undefined)).toHaveLength(2)
    expect(buildOfflineEvents(m, new Set())).toHaveLength(2)
  })

  it('schedules the pedal-extended length when a note has releaseAt', () => {
    const t = track('a', [60])
    t.notes[0] = { ...t.notes[0]!, releaseAt: 3 } // notated end is 0.4
    const events = buildOfflineEvents(midi([t]))
    expect(events[0]?.duration).toBe(3)
  })

  it('falls back to the notated duration when there is no releaseAt', () => {
    const events = buildOfflineEvents(midi([track('a', [60])]))
    expect(events[0]?.duration).toBe(0.4)
  })

  it('returns no events when every track is disabled', () => {
    const events = buildOfflineEvents(
      midi([track('a', [60]), track('b', [64])]),
      new Set(['a', 'b']),
    )
    expect(events).toEqual([])
  })
})
