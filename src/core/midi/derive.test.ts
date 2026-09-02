import { describe, expect, it } from 'vitest'
import { deriveMidi, foldPitch } from './derive'
import {
  audibleDuration,
  MIDI_MAX,
  MIDI_MIN,
  type MidiFile,
  type MidiNote,
  nominalTempoMap,
} from './types'

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

// ── foldPitch ─────────────────────────────────────────────────────────────

describe('foldPitch', () => {
  it('leaves in-range pitches untouched', () => {
    expect(foldPitch(MIDI_MIN)).toBe(MIDI_MIN)
    expect(foldPitch(60)).toBe(60)
    expect(foldPitch(MIDI_MAX)).toBe(MIDI_MAX)
  })

  it('folds up by whole octaves', () => {
    expect(foldPitch(20)).toBe(32) // A0 - 1 → +1 octave
    expect(foldPitch(0)).toBe(24)
  })

  it('folds down by whole octaves', () => {
    expect(foldPitch(109)).toBe(97)
    expect(foldPitch(127)).toBe(103)
  })

  it('preserves pitch class', () => {
    for (const p of [0, 7, 19, 109, 120, 127]) {
      expect(foldPitch(p) % 12).toBe(p % 12)
    }
  })
})

// ── deriveMidi ────────────────────────────────────────────────────────────

describe('deriveMidi', () => {
  it('returns the source object when nothing changes (identity path)', () => {
    const src = makeMidi([[60, 62, 64]])
    const out = deriveMidi(src, { transpose: 0 })
    expect(out.midi).toBe(src)
    expect(out.midi.tracks[0]).toBe(src.tracks[0])
    expect(out.foldedCount).toBe(0)
  })

  it('folds low out-of-range notes up into the 88-key range', () => {
    const src = makeMidi([[12, 20, 60]])
    const out = deriveMidi(src, { transpose: 0 })
    expect(pitchesOf(out.midi)).toEqual([[24, 32, 60]])
    expect(out.foldedCount).toBe(2)
  })

  it('folds high out-of-range notes down into the 88-key range', () => {
    const src = makeMidi([[109, 127, 60]])
    const out = deriveMidi(src, { transpose: 0 })
    expect(pitchesOf(out.midi)).toEqual([[97, 103, 60]])
    expect(out.foldedCount).toBe(2)
  })

  it('folds pitches that are several octaves out', () => {
    const src = makeMidi([[0, 5]])
    const out = deriveMidi(src, { transpose: 0 })
    for (const p of out.midi.tracks[0]!.notes.map((n) => n.pitch)) {
      expect(p).toBeGreaterThanOrEqual(MIDI_MIN)
      expect(p).toBeLessThanOrEqual(MIDI_MAX)
    }
    expect(pitchesOf(out.midi)).toEqual([[24, 29]])
    expect(out.foldedCount).toBe(2)
  })

  it('counts folds across every track', () => {
    const src = makeMidi([
      [10, 60],
      [121, 60],
    ])
    const out = deriveMidi(src, { transpose: 0 })
    expect(out.foldedCount).toBe(2)
    expect(pitchesOf(out.midi)).toEqual([
      [22, 60],
      [97, 60],
    ])
  })

  it('applies transpose before folding', () => {
    // C8 (108) + 2 = 110, which is out of range → folds down an octave to 98.
    const src = makeMidi([[108, 60]])
    const out = deriveMidi(src, { transpose: 2 })
    expect(pitchesOf(out.midi)).toEqual([[98, 62]])
    expect(out.foldedCount).toBe(1)
  })

  it('transposes down and folds the bottom of the range back up', () => {
    const src = makeMidi([[21, 60]])
    const out = deriveMidi(src, { transpose: -3 })
    expect(pitchesOf(out.midi)).toEqual([[30, 57]])
    expect(out.foldedCount).toBe(1)
  })

  it('does not count a transposed-but-in-range note as folded', () => {
    const src = makeMidi([[60, 61]])
    const out = deriveMidi(src, { transpose: 5 })
    expect(pitchesOf(out.midi)).toEqual([[65, 66]])
    expect(out.foldedCount).toBe(0)
    expect(out.midi).not.toBe(src)
  })

  // Guards the spread in the note map: #1 of this plan adds an optional
  // `releaseAt`, and a field-by-field rebuild would silently drop it.
  it('preserves extra note fields', () => {
    const src = makeMidi([[10]])
    const first = src.tracks[0]!.notes[0]!
    src.tracks[0]!.notes[0] = { ...first, releaseAt: 4.2 } as MidiNote
    const out = deriveMidi(src, { transpose: 1 })
    const note = out.midi.tracks[0]!.notes[0]! as MidiNote & { releaseAt?: number }
    expect(note.pitch).toBe(23)
    expect(note.releaseAt).toBe(4.2)
    expect(note.velocity).toBe(0.8)
    expect(note.duration).toBe(0.4)
  })

  it('carries releaseAt through a fold and keeps audibleDuration intact', () => {
    // The pedal pass runs on raw pitches before derive; the octave fold must
    // not touch the audio-only release.
    const src = makeMidi([[120]])
    const first = src.tracks[0]!.notes[0]!
    src.tracks[0]!.notes[0] = { ...first, releaseAt: first.time + 3 }
    const note = deriveMidi(src, { transpose: 0 }).midi.tracks[0]!.notes[0]!
    expect(note.pitch).toBe(108) // folded down an octave
    expect(note.releaseAt).toBe(first.time + 3)
    expect(audibleDuration(note)).toBe(3)
  })

  it('preserves track metadata and file-level fields', () => {
    const src = makeMidi([[10]])
    const out = deriveMidi(src, { transpose: 0 })
    expect(out.midi.name).toBe(src.name)
    expect(out.midi.duration).toBe(src.duration)
    expect(out.midi.bpm).toBe(src.bpm)
    expect(out.midi.timeSignature).toEqual(src.timeSignature)
    expect(out.midi.tracks[0]!.id).toBe('track-0')
  })

  it('leaves unchanged tracks referentially identical', () => {
    const src = makeMidi([[60], [10]])
    const out = deriveMidi(src, { transpose: 0 })
    expect(out.midi.tracks[0]).toBe(src.tracks[0])
    expect(out.midi.tracks[1]).not.toBe(src.tracks[1])
  })

  it('keeps notes in ascending time order', () => {
    const src = makeMidi([[10, 60, 120, 61]])
    const out = deriveMidi(src, { transpose: 3 })
    const times = out.midi.tracks[0]!.notes.map((n) => n.time)
    expect(times).toEqual([0, 0.5, 1, 1.5])
    expect(src.tracks[0]!.notes.map((n) => n.pitch)).toEqual([10, 60, 120, 61])
  })

  it('treats a non-finite transpose as 0', () => {
    const src = makeMidi([[60]])
    expect(deriveMidi(src, { transpose: Number.NaN }).midi).toBe(src)
  })
})
