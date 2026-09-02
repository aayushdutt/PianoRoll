import { describe, expect, it } from 'vitest'
import { applySustain, buildPedalIntervals, type PedalInterval } from './sustain'
import type { MidiNote } from './types'

const note = (pitch: number, time: number, duration: number): MidiNote => ({
  pitch,
  time,
  duration,
  velocity: 0.8,
})

// One channel, one track — the common case.
function single(notes: MidiNote[], intervals: PedalInterval[]): MidiNote[] {
  return applySustain([{ channel: 0, notes }], new Map([[0, intervals]]))[0]!
}

describe('buildPedalIntervals', () => {
  it('treats value >= 0.5 as down (@tonejs/midi normalizes CC to 0–1)', () => {
    const intervals = buildPedalIntervals(
      [
        { time: 0, value: 0.5 },
        { time: 1, value: 0.49 },
      ],
      10,
    )
    expect(intervals).toEqual([{ start: 0, end: 1 }])
  })

  it('ignores a pedal press below the threshold', () => {
    expect(
      buildPedalIntervals(
        [
          { time: 0, value: 0.4 },
          { time: 1, value: 0 },
        ],
        10,
      ),
    ).toEqual([])
  })

  it('sorts events from multiple tracks before pairing them', () => {
    const intervals = buildPedalIntervals(
      [
        { time: 3, value: 0 },
        { time: 1, value: 1 },
      ],
      10,
    )
    expect(intervals).toEqual([{ start: 1, end: 3 }])
  })

  it('collapses repeated downs into one interval', () => {
    const intervals = buildPedalIntervals(
      [
        { time: 0, value: 1 },
        { time: 1, value: 1 },
        { time: 2, value: 0 },
      ],
      10,
    )
    expect(intervals).toEqual([{ start: 0, end: 2 }])
  })

  it('clamps an unlifted pedal to the file duration', () => {
    expect(buildPedalIntervals([{ time: 2, value: 1 }], 9)).toEqual([{ start: 2, end: 9 }])
  })
})

describe('applySustain', () => {
  it('extends a note released while the pedal is down to the pedal-up time', () => {
    const [n] = single([note(60, 1, 0.5)], [{ start: 1.2, end: 4 }])
    expect(n?.releaseAt).toBe(4)
    expect(n?.duration).toBe(0.5) // notated length untouched
  })

  it('extends a note whose pedal was already down at its start', () => {
    const [n] = single([note(60, 1, 0.5)], [{ start: 0, end: 4 }])
    expect(n?.releaseAt).toBe(4)
  })

  it('leaves a note alone when the pedal lifts before its notated end', () => {
    const [n] = single([note(60, 1, 2)], [{ start: 0.5, end: 1.5 }])
    expect(n?.releaseAt).toBeUndefined()
    expect(Object.hasOwn(n as object, 'releaseAt')).toBe(false)
  })

  it('leaves a note alone when the pedal has not been pressed yet', () => {
    const [n] = single([note(60, 1, 0.5)], [{ start: 3, end: 5 }])
    expect(n?.releaseAt).toBeUndefined()
  })

  it('cuts a sustained note at the re-strike of the same pitch', () => {
    const notes = single([note(60, 0, 0.5), note(60, 2, 0.5)], [{ start: 0, end: 8 }])
    expect(notes[0]?.releaseAt).toBe(2)
    expect(notes[1]?.releaseAt).toBe(8)
  })

  it('does not cut across different pitches', () => {
    const notes = single([note(60, 0, 0.5), note(62, 2, 0.5)], [{ start: 0, end: 8 }])
    expect(notes[0]?.releaseAt).toBe(8)
    expect(notes[1]?.releaseAt).toBe(8)
  })

  it('drops releaseAt entirely when a re-strike cuts back to the notated end', () => {
    // Same pitch struck again right as the first note ends — nothing to extend.
    const notes = single([note(60, 0, 1), note(60, 1, 1)], [{ start: 0, end: 8 }])
    expect(notes[0]?.releaseAt).toBeUndefined()
    expect(Object.hasOwn(notes[0] as object, 'releaseAt')).toBe(false)
    expect(notes[1]?.releaseAt).toBe(8)
  })

  it('cuts a re-strike coming from a sibling track on the same channel', () => {
    const a = [note(60, 0, 0.5)]
    const b = [note(60, 2, 0.5)]
    const out = applySustain(
      [
        { channel: 0, notes: a },
        { channel: 0, notes: b },
      ],
      new Map([[0, [{ start: 0, end: 8 }]]]),
    )
    expect(out[0]?.[0]?.releaseAt).toBe(2)
    expect(out[1]?.[0]?.releaseAt).toBe(8)
  })

  it('keeps channels independent — pedal on one channel does not reach another', () => {
    const out = applySustain(
      [
        { channel: 0, notes: [note(60, 0, 0.5)] },
        { channel: 1, notes: [note(60, 0, 0.5)] },
      ],
      new Map([[0, [{ start: 0, end: 8 }]]]),
    )
    expect(out[0]?.[0]?.releaseAt).toBe(8)
    expect(out[1]?.[0]?.releaseAt).toBeUndefined()
  })

  it('ignores pedal on a channel that has no notes', () => {
    const out = applySustain(
      [{ channel: 0, notes: [note(60, 0, 0.5)] }],
      new Map([[3, [{ start: 0, end: 8 }]]]),
    )
    expect(out[0]?.[0]?.releaseAt).toBeUndefined()
  })

  it('holds a never-lifted pedal to the file duration', () => {
    // buildPedalIntervals owns the EOF clamp; applySustain just reads the span.
    const [n] = single([note(60, 0, 0.5)], buildPedalIntervals([{ time: 0, value: 1 }], 6))
    expect(n?.releaseAt).toBe(6)
  })

  it('caps the extension at 15 s past the notated end', () => {
    const [n] = single([note(60, 0, 1)], [{ start: 0, end: 90 }])
    expect(n?.releaseAt).toBe(16)
  })

  it('returns unchanged notes by reference and never mutates the input', () => {
    const input = [note(60, 0, 0.5), note(62, 20, 0.5)]
    const out = single(input, [{ start: 0, end: 4 }])
    expect(out[1]).toBe(input[1])
    expect(input[0]?.releaseAt).toBeUndefined()
    expect(out[0]).not.toBe(input[0])
  })

  it('is a no-op when no channel has pedal data', () => {
    const input = [note(60, 0, 0.5)]
    const out = applySustain([{ channel: 0, notes: input }], new Map())
    expect(out[0]?.[0]).toBe(input[0])
  })
})
