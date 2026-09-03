import { Midi } from '@tonejs/midi'
import { describe, expect, it } from 'vitest'
import { parseMidiFile } from './parser'
import {
  barBoundariesBetween,
  beatLinesBetween,
  meterAt,
  secondsPerBarAt,
  secondsPerBeatAt,
  type TempoMapSource,
  tempoAt,
} from './tempoMap'

// ── Fixture ───────────────────────────────────────────────────────────────

// PPQ 480. Tempo 120 → 60 and meter 4/4 → 3/4, both at tick 3840 (= 8 quarter
// notes = 4.0 s at 120 bpm). After the change a beat is 1 s and a bar is 3 s.
// Notes sit on downbeats: 0 (bar 1), 2 (bar 2), 4 (bar 3 = the change), 7
// (bar 4 — only correct if the meter change RESET bar counting).
const CHANGE_TICKS = 3840
const DOWNBEAT_TICKS = [0, 1920, 3840, 5280]

async function twoTempoBuf(): Promise<ArrayBuffer> {
  const midi = new Midi()
  midi.header.tempos = [
    { ticks: 0, bpm: 120 },
    { ticks: CHANGE_TICKS, bpm: 60 },
  ] as never
  midi.header.timeSignatures = [
    { ticks: 0, timeSignature: [4, 4] },
    { ticks: CHANGE_TICKS, timeSignature: [3, 4] },
  ] as never
  midi.header.update()
  const track = midi.addTrack()
  for (const t of DOWNBEAT_TICKS) {
    track.addNote({ midi: 60, ticks: t, durationTicks: 240, velocity: 0.8 })
  }
  return midi.toArray().slice().buffer as ArrayBuffer
}

// Hand-built maps for the pure-function cases.
const flat: TempoMapSource = {
  tempos: [{ time: 0, bpm: 120 }],
  timeSignatures: [{ time: 0, numerator: 4, denominator: 4 }],
}
const changed: TempoMapSource = {
  tempos: [
    { time: 0, bpm: 120 },
    { time: 4, bpm: 60 },
  ],
  timeSignatures: [
    { time: 0, numerator: 4, denominator: 4 },
    { time: 4, numerator: 3, denominator: 4 },
  ],
}

// ── Parser ────────────────────────────────────────────────────────────────

describe('parser tempo/meter maps', () => {
  it('emits both maps in seconds, ascending', async () => {
    const midi = await parseMidiFile(await twoTempoBuf(), 'two.mid')
    expect(midi.tempos).toEqual([
      { time: 0, bpm: 120 },
      { time: 4, bpm: 60 },
    ])
    expect(midi.timeSignatures).toEqual([
      { time: 0, numerator: 4, denominator: 4 },
      { time: 4, numerator: 3, denominator: 4 },
    ])
  })

  it('keeps the scalars as the nominal first entry', async () => {
    const midi = await parseMidiFile(await twoTempoBuf(), 'two.mid')
    expect(midi.bpm).toBe(120)
    expect(midi.timeSignature).toEqual([4, 4])
  })

  it('falls back to a nominal entry when the file carries no events', async () => {
    const midi = new Midi()
    midi.header.tempos = [] as never
    midi.header.timeSignatures = [] as never
    midi.addTrack().addNote({ midi: 60, time: 0, duration: 1, velocity: 0.8 })
    const parsed = await parseMidiFile(midi.toArray().slice().buffer as ArrayBuffer, 'bare.mid')
    expect(parsed.tempos).toEqual([{ time: 0, bpm: 120 }])
    expect(parsed.timeSignatures).toEqual([{ time: 0, numerator: 4, denominator: 4 }])
  })
})

// ── Lookups ───────────────────────────────────────────────────────────────

describe('tempoAt / meterAt', () => {
  it('holds the previous value until the next event', () => {
    expect(tempoAt(changed, 0)).toBe(120)
    expect(tempoAt(changed, 3.999)).toBe(120)
    expect(tempoAt(changed, 4)).toBe(60)
    expect(tempoAt(changed, 100)).toBe(60)
  })

  it('extends the first entry back before its own timestamp', () => {
    const late: TempoMapSource = { tempos: [{ time: 5, bpm: 90 }], timeSignatures: [] }
    expect(tempoAt(late, 0)).toBe(90)
    expect(meterAt(late, 0)).toEqual({ time: 0, numerator: 4, denominator: 4 })
  })

  it('falls back to 120 / 4-4 on empty maps', () => {
    const empty: TempoMapSource = { tempos: [], timeSignatures: [] }
    expect(tempoAt(empty, 12)).toBe(120)
    expect(meterAt(empty, 12).numerator).toBe(4)
    expect(secondsPerBarAt(empty, 12)).toBe(2)
  })
})

describe('secondsPerBeatAt / secondsPerBarAt', () => {
  it('is correct either side of the changes', () => {
    expect(secondsPerBeatAt(changed, 0)).toBeCloseTo(0.5, 9)
    expect(secondsPerBarAt(changed, 0)).toBeCloseTo(2, 9)
    expect(secondsPerBeatAt(changed, 4)).toBeCloseTo(1, 9)
    // 3/4 at 60 bpm → three 1 s beats.
    expect(secondsPerBarAt(changed, 4)).toBeCloseTo(3, 9)
  })

  it('counts the meter denominator as the beat unit', () => {
    const sixEight: TempoMapSource = {
      tempos: [{ time: 0, bpm: 120 }],
      timeSignatures: [{ time: 0, numerator: 6, denominator: 8 }],
    }
    // Quarter = 0.5 s, so an eighth is 0.25 s and a 6/8 bar is 1.5 s.
    expect(secondsPerBeatAt(sixEight, 0)).toBeCloseTo(0.25, 9)
    expect(secondsPerBarAt(sixEight, 0)).toBeCloseTo(1.5, 9)
  })
})

// ── Walker ────────────────────────────────────────────────────────────────

describe('beatLinesBetween', () => {
  it('emits a constant grid on a flat map', () => {
    const lines = beatLinesBetween(flat, 0, 2)
    expect(lines.map((l) => l.time)).toEqual([0, 0.5, 1, 1.5, 2])
    expect(lines.filter((l) => l.isBar).map((l) => l.time)).toEqual([0, 2])
  })

  it('changes beat spacing at the tempo change', () => {
    const times = beatLinesBetween(changed, 3, 7).map((l) => Number(l.time.toFixed(6)))
    expect(times).toEqual([3, 3.5, 4, 5, 6, 7])
  })

  it('keeps beat phase when the window starts mid-piece', () => {
    // The pre-window skip-ahead must not shift the grid off the anchor.
    const times = beatLinesBetween(flat, 10.2, 11.2).map((l) => Number(l.time.toFixed(6)))
    expect(times).toEqual([10.5, 11])
  })

  it('emits nothing before time 0', () => {
    expect(beatLinesBetween(flat, -5, -1)).toEqual([])
    expect(beatLinesBetween(flat, -1, 0.4).map((l) => l.time)).toEqual([0])
  })
})

describe('barBoundariesBetween', () => {
  it('resets bar counting at the meter change', () => {
    // 4/4 @ 120 → bars every 2 s. From the change, 3/4 @ 60 → bars every 3 s
    // counted from 4 s, NOT from 0 (a bar never straddles a meter change).
    expect(barBoundariesBetween(changed, 0, 13)).toEqual([0, 2, 4, 7, 10, 13])
  })

  it('lands on the downbeat notes of a real parsed file', async () => {
    const midi = await parseMidiFile(await twoTempoBuf(), 'two.mid')
    const noteTimes = midi.tracks[0]!.notes.map((n) => Number(n.time.toFixed(6)))
    expect(noteTimes).toEqual([0, 2, 4, 7])
    const bars = barBoundariesBetween(midi, 0, 7).map((t) => Number(t.toFixed(6)))
    expect(bars).toEqual(noteTimes)
  })
})
