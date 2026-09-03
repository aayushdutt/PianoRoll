import { describe, expect, it } from 'vitest'
import { deriveMidi } from './derive'
import { audibleDuration, type MidiFile, nominalTempoMap } from './types'

// ── Helpers ───────────────────────────────────────────────────────────────

function makeMidi(pitchesByTrack: number[][]): MidiFile {
  return {
    name: 'test',
    duration: 10,
    bpm: 120,
    timeSignature: [4, 4],
    ...nominalTempoMap(120, [4, 4]),
    tracks: pitchesByTrack.map((pitches, i) => ({
      id: `track-${i}`,
      name: `Track ${i + 1}`,
      channel: i,
      instrument: 0,
      isDrum: false,
      colorIndex: i,
      notes: pitches.map((pitch, n) => ({
        pitch,
        time: n * 0.5,
        duration: 0.4,
        velocity: 0.8,
      })),
    })),
  }
}

function pitchesOf(midi: MidiFile): number[][] {
  return midi.tracks.map((t) => t.notes.map((n) => n.pitch))
}

describe('deriveMidi', () => {
  it('returns the source object at transpose 0 (identity path)', () => {
    const src = makeMidi([[60, 62, 64]])
    expect(deriveMidi(src, { transpose: 0 })).toBe(src)
  })

  it('shifts every note on every track by the transpose', () => {
    const src = makeMidi([
      [60, 62],
      [48, 50],
    ])
    expect(pitchesOf(deriveMidi(src, { transpose: 5 }))).toEqual([
      [65, 67],
      [53, 55],
    ])
    expect(pitchesOf(deriveMidi(src, { transpose: -3 }))).toEqual([
      [57, 59],
      [45, 47],
    ])
  })

  it('never folds or clamps: out-of-range pitches stay out of range', () => {
    // Off the piano in the file, or pushed there by the transpose — either
    // way the note is still audible, it just has no key to be drawn on.
    const src = makeMidi([[10, 108, 127]])
    expect(pitchesOf(deriveMidi(src, { transpose: 0 }))).toEqual([[10, 108, 127]])
    expect(pitchesOf(deriveMidi(src, { transpose: 2 }))).toEqual([[12, 110, 129]])
  })

  it('does not mutate the source', () => {
    const src = makeMidi([[60]])
    deriveMidi(src, { transpose: 7 })
    expect(pitchesOf(src)).toEqual([[60]])
  })

  // Guards the spread in the note map: the pedal pass adds an optional
  // `releaseAt`, and a field-by-field rebuild would silently drop it.
  it('preserves every other note field, including releaseAt', () => {
    const src = makeMidi([[60]])
    const first = src.tracks[0]!.notes[0]!
    src.tracks[0]!.notes[0] = { ...first, releaseAt: first.time + 3 }
    const note = deriveMidi(src, { transpose: 1 }).tracks[0]!.notes[0]!
    expect(note.pitch).toBe(61)
    expect(note.releaseAt).toBe(first.time + 3)
    expect(audibleDuration(note)).toBe(3)
    expect(note.velocity).toBe(0.8)
    expect(note.duration).toBe(0.4)
  })

  it('preserves track metadata and file-level fields', () => {
    const src = makeMidi([[60]])
    const out = deriveMidi(src, { transpose: 4 })
    expect(out.name).toBe(src.name)
    expect(out.duration).toBe(src.duration)
    expect(out.bpm).toBe(src.bpm)
    expect(out.timeSignature).toEqual(src.timeSignature)
    expect(out.tempos).toBe(src.tempos)
    expect(out.tracks[0]!.id).toBe('track-0')
  })

  it('keeps notes in ascending time order', () => {
    const src = makeMidi([[10, 60, 120, 61]])
    const times = deriveMidi(src, { transpose: 3 }).tracks[0]!.notes.map((n) => n.time)
    expect(times).toEqual([0, 0.5, 1, 1.5])
  })

  it('treats a non-finite or fractional transpose as its integer part', () => {
    const src = makeMidi([[60]])
    expect(deriveMidi(src, { transpose: Number.NaN })).toBe(src)
    expect(pitchesOf(deriveMidi(src, { transpose: 2.9 }))).toEqual([[62]])
  })
})
