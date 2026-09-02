import { Midi } from '@tonejs/midi'
import { describe, expect, it, vi } from 'vitest'
import { PracticeEngine } from '../../learn/engines/PracticeEngine'
import type { MasterClock } from '../clock/MasterClock'
import { EmptyMidiError, parseMidiFile, parseMidiFileWithStats } from './parser'
import { TRACK_COLOR_SLOTS } from './types'

// ── Helpers ───────────────────────────────────────────────────────────────

// Builds a single-track MIDI ArrayBuffer using @tonejs/midi's writer.
// Same approach as MidiEncoding.test.ts — proven to work in vitest/Node.
async function makeBuf(
  notes: Array<{ midi: number; time: number; duration: number; velocity?: number }>,
  opts: { bpm?: number; channel?: number; trackName?: string } = {},
): Promise<ArrayBuffer> {
  const midi = new Midi()
  if (opts.bpm != null) midi.header.setTempo(opts.bpm)
  const track = midi.addTrack()
  if (opts.trackName) track.name = opts.trackName
  if (opts.channel != null) track.channel = opts.channel
  for (const n of notes) {
    track.addNote({ midi: n.midi, time: n.time, duration: n.duration, velocity: n.velocity ?? 0.8 })
  }
  // .slice() detaches from the shared ArrayBuffer — same idiom as MidiEncoding tests.
  return midi.toArray().slice().buffer as ArrayBuffer
}

async function makeEmptyBuf(): Promise<ArrayBuffer> {
  const midi = new Midi()
  return midi.toArray().slice().buffer as ArrayBuffer
}

function makeFakeClock() {
  const listeners = new Set<(t: number) => void>()
  let t = 0
  return {
    get currentTime() {
      return t
    },
    emit(newT: number) {
      t = newT
      for (const fn of listeners) fn(newT)
    },
    pause: vi.fn(),
    play: vi.fn(),
    seek: vi.fn((newT: number) => {
      t = Math.max(0, newT)
    }),
    subscribe(fn: (t: number) => void) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  }
}

// ── parseMidiFile — shape ─────────────────────────────────────────────────

describe('parseMidiFile — shape', () => {
  it('strips .mid extension from the name parameter', async () => {
    const buf = await makeBuf([{ midi: 60, time: 1, duration: 0.5 }])
    const result = await parseMidiFile(buf, 'Bach Prelude.mid')
    expect(result.name).toBe('Bach Prelude')
  })

  it('strips .midi extension (case-insensitive)', async () => {
    const buf = await makeBuf([{ midi: 60, time: 1, duration: 0.5 }])
    const result = await parseMidiFile(buf, 'Etude.MIDI')
    expect(result.name).toBe('Etude')
  })

  it('leaves names without an extension untouched', async () => {
    const buf = await makeBuf([{ midi: 60, time: 1, duration: 0.5 }])
    const result = await parseMidiFile(buf, 'Sonata')
    expect(result.name).toBe('Sonata')
  })

  it('falls back to "Untitled" for ArrayBuffer input with no name argument', async () => {
    const buf = await makeBuf([{ midi: 60, time: 1, duration: 0.5 }])
    const result = await parseMidiFile(buf)
    expect(result.name).toBe('Untitled')
  })

  it('reads BPM from the MIDI header', async () => {
    const buf = await makeBuf([{ midi: 60, time: 1, duration: 0.5 }], { bpm: 96 })
    const result = await parseMidiFile(buf, 'test')
    expect(result.bpm).toBeCloseTo(96, 0)
  })

  it('falls back to 120 BPM when the header has no tempo event', async () => {
    // makeBuf without bpm — Midi() default has no explicit tempo
    const midi = new Midi()
    const track = midi.addTrack()
    track.addNote({ midi: 60, time: 1, duration: 0.5, velocity: 0.8 })
    const buf = midi.toArray().slice().buffer as ArrayBuffer
    const result = await parseMidiFile(buf, 'test')
    // @tonejs/midi may add a default 120 BPM or leave tempos empty — either way
    // the parser resolves to 120.
    expect(result.bpm).toBeCloseTo(120, 0)
  })

  it('returns timeSignature [4, 4] as the default', async () => {
    const buf = await makeBuf([{ midi: 60, time: 1, duration: 0.5 }])
    const result = await parseMidiFile(buf, 'test')
    // @tonejs/midi defaults or our fallback both produce [4, 4]
    expect(result.timeSignature).toEqual([4, 4])
  })

  it('assigns sequential track IDs based on the filtered (non-empty) track order', async () => {
    const midi = new Midi()
    // Track 0: has notes
    const t0 = midi.addTrack()
    t0.addNote({ midi: 60, time: 1, duration: 0.5, velocity: 0.8 })
    // Track 1: has notes
    const t1 = midi.addTrack()
    t1.addNote({ midi: 64, time: 2, duration: 0.5, velocity: 0.8 })
    const buf = midi.toArray().slice().buffer as ArrayBuffer
    const result = await parseMidiFile(buf, 'test')
    expect(result.tracks[0]?.id).toBe('track-0')
    expect(result.tracks[1]?.id).toBe('track-1')
  })

  it('empty tracks are filtered before ID assignment — the first non-empty track is track-0', async () => {
    // Raw MIDI has two tracks; the first has no notes and is filtered out.
    // The second (with notes) must become track-0, not track-1.
    const midi = new Midi()
    midi.addTrack() // empty — no notes
    const second = midi.addTrack()
    second.addNote({ midi: 72, time: 1, duration: 0.5, velocity: 0.8 })
    const buf = midi.toArray().slice().buffer as ArrayBuffer
    const result = await parseMidiFile(buf, 'test')
    expect(result.tracks).toHaveLength(1)
    expect(result.tracks[0]?.id).toBe('track-0')
    expect(result.tracks[0]?.notes[0]?.pitch).toBe(72)
  })
})

// ── parseMidiFile — EmptyMidiError ────────────────────────────────────────

describe('parseMidiFile — EmptyMidiError', () => {
  it('throws EmptyMidiError when the MIDI has no tracks at all', async () => {
    const buf = await makeEmptyBuf()
    await expect(parseMidiFile(buf, 'empty')).rejects.toBeInstanceOf(EmptyMidiError)
  })

  it('EmptyMidiError has the expected name and message', async () => {
    const buf = await makeEmptyBuf()
    await expect(parseMidiFile(buf, 'empty')).rejects.toMatchObject({
      name: 'EmptyMidiError',
      message: 'MIDI contains no playable notes.',
    })
  })
})

// ── parseMidiFile — note transforms ──────────────────────────────────────

describe('parseMidiFile — note transforms', () => {
  it('clamps very short note durations to 0.05 s minimum', async () => {
    // 0.02 s survives MIDI tick quantization at 120 BPM / 480 PPQ (~9 ticks)
    // but is below the 0.05 clamp; the parser must raise it.
    const buf = await makeBuf([{ midi: 60, time: 1, duration: 0.02 }])
    const result = await parseMidiFile(buf, 'test')
    const note = result.tracks[0]!.notes[0]!
    expect(note.duration).toBeGreaterThanOrEqual(0.05)
  })

  it('does not clamp durations that are already above 0.05 s', async () => {
    const buf = await makeBuf([{ midi: 60, time: 1, duration: 0.5 }])
    const result = await parseMidiFile(buf, 'test')
    const note = result.tracks[0]!.notes[0]!
    expect(note.duration).toBeGreaterThanOrEqual(0.4) // some rounding from tick encoding
  })

  it('preserves pitch and velocity through the parse round-trip', async () => {
    const buf = await makeBuf([{ midi: 72, time: 0.5, duration: 0.3, velocity: 0.6 }])
    const result = await parseMidiFile(buf, 'test')
    const note = result.tracks[0]!.notes[0]!
    expect(note.pitch).toBe(72)
    expect(note.velocity).toBeCloseTo(0.6, 1)
  })

  it('produces notes in ascending time order', async () => {
    // Added in descending order — parser must sort ascending.
    const buf = await makeBuf([
      { midi: 67, time: 3, duration: 0.5 },
      { midi: 64, time: 2, duration: 0.5 },
      { midi: 60, time: 1, duration: 0.5 },
    ])
    const result = await parseMidiFile(buf, 'test')
    const times = result.tracks[0]!.notes.map((n) => n.time)
    expect(times).toEqual([...times].sort((a, b) => a - b))
  })
})

// ── parseMidiFile — track metadata ────────────────────────────────────────

describe('parseMidiFile — track metadata', () => {
  it('marks channel-9 tracks as drums (isDrum: true)', async () => {
    const buf = await makeBuf([{ midi: 36, time: 1, duration: 0.1 }], { channel: 9 })
    const result = await parseMidiFile(buf, 'test')
    expect(result.tracks[0]?.isDrum).toBe(true)
  })

  it('marks non-channel-9 tracks as not drums (isDrum: false)', async () => {
    const buf = await makeBuf([{ midi: 60, time: 1, duration: 0.5 }], { channel: 0 })
    const result = await parseMidiFile(buf, 'test')
    expect(result.tracks[0]?.isDrum).toBe(false)
  })

  it('uses the track name from the MIDI file', async () => {
    const buf = await makeBuf([{ midi: 60, time: 1, duration: 0.5 }], { trackName: 'Piano' })
    const result = await parseMidiFile(buf, 'test')
    expect(result.tracks[0]?.name).toBe('Piano')
  })

  it('falls back to "Track 1" when the MIDI track has no name', async () => {
    // @tonejs/midi emits '' for unnamed tracks; the parser replaces falsy names
    // with "Track N+1". addTrack() without setting .name produces name = ''.
    const buf = await makeBuf([{ midi: 60, time: 1, duration: 0.5 }])
    const result = await parseMidiFile(buf, 'test')
    expect(result.tracks[0]?.name).toBe('Track 1')
  })

  it('wraps colorIndex back to 0 after TRACK_COLOR_SLOTS tracks', async () => {
    const count = TRACK_COLOR_SLOTS + 1
    const midi = new Midi()
    for (let i = 0; i < count; i++) {
      const track = midi.addTrack()
      track.addNote({ midi: 40 + i, time: i + 1, duration: 0.5, velocity: 0.8 })
    }
    const buf = midi.toArray().slice().buffer as ArrayBuffer
    const result = await parseMidiFile(buf, 'test')
    expect(result.tracks).toHaveLength(count)
    expect(result.tracks.map((t) => t.colorIndex)).toEqual([
      ...Array.from({ length: TRACK_COLOR_SLOTS }, (_, i) => i),
      0,
    ])
  })

  it('does not carry a literal `color` — tracks only reference a palette slot', async () => {
    const buf = await makeBuf([{ midi: 60, time: 1, duration: 0.5 }])
    const result = await parseMidiFile(buf, 'test')
    expect(result.tracks[0]).not.toHaveProperty('color')
    expect(Object.keys(result.tracks[0]!)).not.toContain('color')
  })
})

// ── parseMidiFile → PracticeEngine pipeline ───────────────────────────────

describe('parseMidiFile → PracticeEngine pipeline', () => {
  it('parsed note order produces the correct step sequence in PracticeEngine', async () => {
    // Notes added in descending time order — parser sorts ascending;
    // PracticeEngine must see them in the correct wait order.
    const buf = await makeBuf(
      [
        { midi: 67, time: 3, duration: 0.5 },
        { midi: 64, time: 2, duration: 0.5 },
        { midi: 60, time: 1, duration: 0.5 },
      ],
      { bpm: 120 },
    )
    const midi = await parseMidiFile(buf, 'pipeline-test')

    const clock = makeFakeClock()
    const engine = new PracticeEngine(clock as unknown as MasterClock, {
      onWaitStart: vi.fn(),
      onWaitEnd: vi.fn(),
    })
    engine.loadMidi(midi)
    engine.setEnabled(true)

    // First step should be pitch 60 at t=1.
    const first = engine.peekNextStep()
    expect(first).not.toBeNull()
    expect(first?.pitches.has(60)).toBe(true)
  })

  it('drum track in parsed MIDI is excluded — PracticeEngine has no wait step for it', async () => {
    // A drum-only MIDI must not engage any wait steps.
    const buf = await makeBuf([{ midi: 36, time: 2, duration: 0.1 }], { channel: 9 })
    const midi = await parseMidiFile(buf, 'drums')

    const clock = makeFakeClock()
    const onWaitStart = vi.fn()
    const engine = new PracticeEngine(clock as unknown as MasterClock, {
      onWaitStart,
      onWaitEnd: vi.fn(),
    })
    engine.loadMidi(midi)
    engine.setEnabled(true)

    clock.emit(2.01)
    expect(engine.isWaiting).toBe(false)
    expect(onWaitStart).not.toHaveBeenCalled()
    expect(engine.peekNextStep()).toBeNull()
  })
})

// ── parseMidiFile — sustain pedal (CC64) ─────────────────────────────────
// @tonejs/midi's writer does emit control changes (Track.addCC), so these
// fixtures are real encoded CC64 bytes — no hand-crafted buffer needed.

describe('parseMidiFile — sustain pedal', () => {
  it('round-trips CC64 through the writer as a 0–1 normalized value', async () => {
    const midi = new Midi()
    const t = midi.addTrack()
    t.addNote({ midi: 60, time: 0, duration: 0.5, velocity: 0.8 })
    t.addCC({ number: 64, value: 1, time: 0 })
    const reparsed = new Midi(midi.toArray().slice().buffer as ArrayBuffer)
    const cc = reparsed.tracks.flatMap((tr) => tr.controlChanges[64] ?? [])
    expect(cc).toHaveLength(1)
    expect(cc[0]?.value).toBeCloseTo(1, 2) // NOT 127 — threshold is >= 0.5
  })

  it('extends a note released under the pedal to the pedal-up time', async () => {
    const midi = new Midi()
    const t = midi.addTrack()
    t.addNote({ midi: 60, time: 0, duration: 0.5, velocity: 0.8 })
    t.addNote({ midi: 72, time: 3.5, duration: 0.5, velocity: 0.8 })
    t.addCC({ number: 64, value: 1, time: 0 })
    t.addCC({ number: 64, value: 0, time: 2 })
    const parsed = await parseMidiFile(midi.toArray().slice().buffer as ArrayBuffer, 'pedal')
    const note = parsed.tracks[0]!.notes[0]!
    expect(note.releaseAt).toBeCloseTo(2, 1)
    expect(note.duration).toBeCloseTo(0.5, 1) // notated length untouched
  })

  it('applies CC64 from a note-less track to notes on a sibling track (same channel)', async () => {
    const midi = new Midi()
    const notes = midi.addTrack()
    notes.channel = 0
    notes.addNote({ midi: 60, time: 0, duration: 0.5, velocity: 0.8 })
    notes.addNote({ midi: 72, time: 3.5, duration: 0.5, velocity: 0.8 })
    const pedal = midi.addTrack()
    pedal.channel = 0
    pedal.addCC({ number: 64, value: 1, time: 0 })
    pedal.addCC({ number: 64, value: 0, time: 2 })
    const parsed = await parseMidiFile(midi.toArray().slice().buffer as ArrayBuffer, 'pedal')
    expect(parsed.tracks).toHaveLength(1)
    expect(parsed.tracks[0]!.notes[0]!.releaseAt).toBeCloseTo(2, 1)
  })

  it('leaves notes untouched when the file has no CC64', async () => {
    const buf = await makeBuf([{ midi: 60, time: 0, duration: 0.5 }])
    const parsed = await parseMidiFile(buf, 'plain')
    expect(parsed.tracks[0]!.notes[0]!.releaseAt).toBeUndefined()
  })

  it('clamps an unlifted pedal to the file duration', async () => {
    const midi = new Midi()
    const t = midi.addTrack()
    t.addNote({ midi: 60, time: 0, duration: 0.5, velocity: 0.8 })
    t.addNote({ midi: 72, time: 4, duration: 1, velocity: 0.8 })
    t.addCC({ number: 64, value: 1, time: 0 })
    const parsed = await parseMidiFile(midi.toArray().slice().buffer as ArrayBuffer, 'stuck')
    const note = parsed.tracks[0]!.notes[0]!
    expect(note.releaseAt).toBeCloseTo(parsed.duration, 1)
  })

  it('cuts a sustained note when the same pitch is re-struck', async () => {
    const midi = new Midi()
    const t = midi.addTrack()
    t.addNote({ midi: 60, time: 0, duration: 0.5, velocity: 0.8 })
    t.addNote({ midi: 60, time: 2, duration: 0.5, velocity: 0.8 })
    t.addCC({ number: 64, value: 1, time: 0 })
    t.addCC({ number: 64, value: 0, time: 4 })
    const parsed = await parseMidiFile(midi.toArray().slice().buffer as ArrayBuffer, 'restrike')
    const [first, second] = parsed.tracks[0]!.notes
    expect(first?.releaseAt).toBeCloseTo(2, 1)
    expect(second?.releaseAt).toBeCloseTo(4, 1)
  })
})

// ── parseMidiFileWithStats — parse-quality counters ───────────────────────
// These feed the `midi_parse_quality` telemetry event: they describe the
// SOURCE file, so they're measured before any derive/fold step runs.

describe('parseMidiFileWithStats', () => {
  it('counts notes outside the 88-key range', async () => {
    const buf = await makeBuf([
      { midi: 12, time: 0, duration: 0.5 },
      { midi: 60, time: 1, duration: 0.5 },
      { midi: 120, time: 2, duration: 0.5 },
    ])
    const { stats } = await parseMidiFileWithStats(buf, 'wide')
    expect(stats.outOfRangeNotes).toBe(2)
  })

  it('reports no sustain pedal and a single tempo for a plain file', async () => {
    const buf = await makeBuf([{ midi: 60, time: 0, duration: 0.5 }], { bpm: 90 })
    const { stats } = await parseMidiFileWithStats(buf, 'plain')
    expect(stats.hasSustainPedal).toBe(false)
    expect(stats.outOfRangeNotes).toBe(0)
    expect(stats.tempoEvents).toBe(1)
  })

  it('detects CC64 on a track with no notes (the track filter must not hide it)', async () => {
    const midi = new Midi()
    const notes = midi.addTrack()
    notes.channel = 0
    notes.addNote({ midi: 60, time: 0, duration: 0.5, velocity: 0.8 })
    const pedal = midi.addTrack()
    pedal.channel = 0
    pedal.addCC({ number: 64, value: 1, time: 0 })
    pedal.addCC({ number: 64, value: 0, time: 1 })
    const buf = midi.toArray().slice().buffer as ArrayBuffer

    const { midi: parsed, stats } = await parseMidiFileWithStats(buf, 'pedalled')
    expect(stats.hasSustainPedal).toBe(true)
    // The CC-only track is still dropped from the note model.
    expect(parsed.tracks).toHaveLength(1)
  })
})
