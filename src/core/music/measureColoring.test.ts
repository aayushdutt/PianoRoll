import { describe, expect, it } from 'vitest'
import type { MidiFile, MidiTrack } from '../midi/types'
import {
  buildMeasureColoring,
  measureColorIndexAt,
  measureDurationSeconds,
} from './measureColoring'

function track(notes: MidiTrack['notes'], isDrum = false): MidiTrack {
  return {
    id: 't1',
    name: 'test',
    channel: 0,
    instrument: 0,
    isDrum,
    notes,
    colorIndex: 0,
  }
}

function file(tracks: MidiTrack[], bpm = 120): MidiFile {
  const duration = Math.max(0, ...tracks.flatMap((t) => t.notes.map((n) => n.time + n.duration)))
  return { name: 'test', duration, bpm, timeSignature: [4, 4], tracks }
}

describe('measureDurationSeconds', () => {
  it('computes 4/4 bar length from tempo', () => {
    expect(measureDurationSeconds(120, [4, 4])).toBeCloseTo(2) // 4 quarters × 0.5s
    expect(measureDurationSeconds(60, [3, 4])).toBeCloseTo(3) // 3 quarters × 1s
  })
  it('returns 0 for unusable tempo/meter', () => {
    expect(measureDurationSeconds(0, [4, 4])).toBe(0)
  })
})

describe('buildMeasureColoring', () => {
  it('assigns a distinct fixed root per measure', () => {
    // Bar 0 (0–2s): C major triad → root C (0). Bar 1 (2–4s): G major triad → root G (7).
    const midi = file([
      track([
        { pitch: 60, time: 0, duration: 2, velocity: 0.8 }, // C4 whole bar
        { pitch: 64, time: 0, duration: 2, velocity: 0.8 }, // E4
        { pitch: 67, time: 0, duration: 2, velocity: 0.8 }, // G4
        { pitch: 67, time: 2, duration: 2, velocity: 0.8 }, // G4 whole bar
        { pitch: 71, time: 2, duration: 2, velocity: 0.8 }, // B4
        { pitch: 74, time: 2, duration: 2, velocity: 0.8 }, // D5
      ]),
    ])
    const coloring = buildMeasureColoring(midi, 0)
    expect(coloring.roots.length).toBe(2)
    expect(coloring.roots[0]).toBe(0) // C
    expect(coloring.roots[1]).toBe(7) // G
  })

  it('colors a note by its own measure root, independent of the playhead', () => {
    const midi = file([
      track([
        { pitch: 60, time: 0, duration: 2, velocity: 0.8 },
        { pitch: 64, time: 0, duration: 2, velocity: 0.8 },
        { pitch: 67, time: 0, duration: 2, velocity: 0.8 },
        { pitch: 67, time: 2, duration: 2, velocity: 0.8 },
        { pitch: 71, time: 2, duration: 2, velocity: 0.8 },
        { pitch: 74, time: 2, duration: 2, velocity: 0.8 },
      ]),
    ])
    const coloring = buildMeasureColoring(midi, 0)
    // In bar 0 the root is C, so C4 is the tonic (index 0).
    expect(measureColorIndexAt(60, 0, coloring)).toBe(0)
    // The B in bar 1 is the major third above the G root → chord-3rd (index 7).
    expect(measureColorIndexAt(71, 2.5, coloring)).toBe(7)
    // Same B pitch but placed in bar 0 (C root) would be diatonic degree 7 (index 6),
    // proving the color depends on the measure, not the pitch alone.
    expect(measureColorIndexAt(71, 0.5, coloring)).toBe(6)
  })

  it('uses real barlines (measureStarts) including an anacrusis', () => {
    // A 1s pickup, then two full 2s bars. Colors must pin to these measures, not
    // to a naive 2s grid starting at 0.
    const midi: MidiFile = {
      name: 'pickup',
      duration: 5,
      bpm: 120,
      timeSignature: [4, 4],
      measureStarts: [0, 1, 3],
      tracks: [
        track([
          { pitch: 60, time: 0, duration: 1, velocity: 0.8 }, // pickup bar: C
          { pitch: 67, time: 1, duration: 2, velocity: 0.8 }, // bar 1: G root
          { pitch: 71, time: 1, duration: 2, velocity: 0.8 },
          { pitch: 74, time: 1, duration: 2, velocity: 0.8 },
          { pitch: 60, time: 3, duration: 2, velocity: 0.8 }, // bar 2: C root
          { pitch: 64, time: 3, duration: 2, velocity: 0.8 },
          { pitch: 67, time: 3, duration: 2, velocity: 0.8 },
        ]),
      ],
    }
    const coloring = buildMeasureColoring(midi, 0)
    expect(coloring.roots.length).toBe(3) // pickup + 2 bars
    expect(coloring.roots[1]).toBe(7) // G
    expect(coloring.roots[2]).toBe(0) // C
    // A note anywhere inside bar 1 (1–3s) is colored by the G root, even at 2.9s.
    expect(measureColorIndexAt(71, 2.9, coloring)).toBe(7) // B = 3rd of G
    // The same time under a naive 2s grid would fall in a different chunk;
    // proving we honor the pickup offset.
    expect(measureColorIndexAt(60, 0.5, coloring)).toBe(0) // pickup C = tonic
  })

  it('excludes drum tracks from harmonic analysis', () => {
    const midi = file([
      track([{ pitch: 62, time: 0, duration: 2, velocity: 0.8 }]), // D pitched
      track([{ pitch: 36, time: 0, duration: 2, velocity: 0.9 }], true), // kick on a drum track
    ])
    const coloring = buildMeasureColoring(midi, 0)
    // Only the pitched D note drives the root.
    expect(coloring.roots[0]).toBe(2) // D
  })
})
