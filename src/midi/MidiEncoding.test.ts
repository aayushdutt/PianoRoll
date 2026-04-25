import { Midi } from '@tonejs/midi'
import { describe, expect, it } from 'vitest'
import { type CapturedEvent, encodeCapturedEvents } from './MidiEncoding'

// Round-trip helper — encodes, then parses the output back with @tonejs/midi
// so assertions can target the logical note model instead of raw bytes.
async function roundTrip(
  events: CapturedEvent[],
  opts?: Parameters<typeof encodeCapturedEvents>[1],
) {
  const bytes = await encodeCapturedEvents(events, opts)
  const midi = new Midi(bytes.slice().buffer)
  return midi.tracks[0]!.notes.map((n) => ({
    pitch: n.midi,
    time: Number(n.time.toFixed(3)),
    duration: Number(n.duration.toFixed(3)),
  }))
}

describe('encodeCapturedEvents', () => {
  it('pairs a single note on/off into one note', async () => {
    const notes = await roundTrip([
      { type: 'on', pitch: 60, velocity: 0.8, time: 0 },
      { type: 'off', pitch: 60, velocity: 0, time: 1 },
    ])
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatchObject({ pitch: 60, duration: 1 })
  })

  it('closes orphan note-ons at the last event time by default', async () => {
    const notes = await roundTrip([
      { type: 'on', pitch: 64, velocity: 0.9, time: 0 },
      { type: 'on', pitch: 67, velocity: 0.9, time: 0.5 },
      { type: 'off', pitch: 67, velocity: 0, time: 1 },
    ])
    const orphan = notes.find((n) => n.pitch === 64)!
    expect(orphan.duration).toBeCloseTo(1, 1)
  })

  it('respects closeOrphansAt override', async () => {
    const notes = await roundTrip([{ type: 'on', pitch: 72, velocity: 1, time: 0 }], {
      closeOrphansAt: 4,
    })
    expect(notes[0]!.duration).toBeCloseTo(4, 1)
  })

  it('handles repeated on/off pairs on the same pitch (FIFO)', async () => {
    const notes = (
      await roundTrip([
        { type: 'on', pitch: 60, velocity: 1, time: 0 },
        { type: 'on', pitch: 60, velocity: 1, time: 0.5 },
        { type: 'off', pitch: 60, velocity: 0, time: 1 },
        { type: 'off', pitch: 60, velocity: 0, time: 1.5 },
      ])
    ).sort((a, b) => a.time - b.time)
    expect(notes).toHaveLength(2)
    expect(notes[0]).toMatchObject({ time: 0, duration: 1 })
    expect(notes[1]).toMatchObject({ time: 0.5, duration: 1 })
  })

  it('ignores off events with no matching on', async () => {
    const notes = await roundTrip([
      { type: 'off', pitch: 60, velocity: 0, time: 0.5 },
      { type: 'on', pitch: 62, velocity: 1, time: 1 },
      { type: 'off', pitch: 62, velocity: 0, time: 2 },
    ])
    expect(notes).toHaveLength(1)
    expect(notes[0]!.pitch).toBe(62)
  })

  it('clamps very short notes to a minimum duration', async () => {
    const notes = await roundTrip([
      { type: 'on', pitch: 60, velocity: 1, time: 0 },
      { type: 'off', pitch: 60, velocity: 0, time: 0 },
    ])
    expect(notes[0]!.duration).toBeGreaterThan(0)
  })

  it('produces an empty track for no events', async () => {
    const bytes = await encodeCapturedEvents([])
    const midi = new Midi(bytes.slice().buffer)
    expect(midi.tracks[0]!.notes).toHaveLength(0)
  })
})
