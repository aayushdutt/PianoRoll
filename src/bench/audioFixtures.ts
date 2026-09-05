// Synthetic MIDI fixtures for the audio bench suites
// (docs/AUDIO_GLITCH_HARNESS_2026-09-05.md). Built in-page — no files —
// so the shapes are exact and the harness can't drift from the description.
//
// Every fixture holds its notes until the end of the piece: the failure we're
// measuring (summed voices crossing full scale / piling up) only shows when
// nothing is released.

import { type MidiFile, type MidiNote, type MidiTrack, nominalTempoMap } from '../core/midi/types'

// `piece-20` is the first 20 s of `pedal-piece` — the same realistic
// pedalled music, short enough to iterate level trims on (13 renders in
// ~25 s instead of ~3 min).
export const AUDIO_FIXTURE_IDS = [
  'single-ff',
  'chord5-ff',
  'cluster-ff',
  'cluster-mf',
  'stack-185',
  'piece-20',
  'pedal-piece',
] as const
export type AudioFixtureId = (typeof AUDIO_FIXTURE_IDS)[number]

export function isAudioFixtureId(id: string): id is AudioFixtureId {
  return (AUDIO_FIXTURE_IDS as readonly string[]).includes(id)
}

// Eight notes spread C3–E5 — a two-hand fortissimo grab, the local repro.
// Exported so live tooling can play the identical chord this fixture measures.
export const CLUSTER_PITCHES = [48, 52, 55, 59, 62, 67, 72, 76]
const CLUSTER_HOLD_S = 4

// Wyatt's method: one note per beat at 185 BPM, every note held. Twelve
// notes; the last one rings 3 s so the full stack is heard steady-state.
const STACK_PITCHES = [48, 52, 55, 59, 62, 64, 67, 71, 72, 76, 79, 83]
export const STACK_BPM = 185
const STACK_STEP_S = 60 / STACK_BPM
const STACK_TAIL_S = 3

function file(name: string, notes: MidiNote[], bpm: number): MidiFile {
  const duration = Math.max(...notes.map((n) => n.releaseAt ?? n.time + n.duration))
  const track: MidiTrack = {
    id: 'bench',
    name,
    channel: 0,
    instrument: 0,
    isDrum: false,
    colorIndex: 0,
    notes,
  }
  return {
    name,
    duration,
    bpm,
    timeSignature: [4, 4],
    ...nominalTempoMap(bpm, [4, 4]),
    tracks: [track],
  }
}

// One note, hardest hit, held: the volume anchor. Tuning must not lower this
// — it's what a player judges loudness on — while it brings chords down.
export function buildSingle(): MidiFile {
  return file('single-ff', [{ pitch: 60, time: 0, duration: 2, velocity: 1 }], 120)
}

// Five notes hit hard together — the realistic loud chord (the user's own
// repro was "4 or 5 keys with velocity"). This is the 95 % case tuning must
// keep clean; `cluster-ff` (eight notes at max velocity) is the 1 % case that
// may lean on the ceiling.
const CHORD5_PITCHES = [48, 52, 55, 60, 64]
export function buildChord5(): MidiFile {
  const notes = CHORD5_PITCHES.map((pitch) => ({ pitch, time: 0, duration: 3, velocity: 0.95 }))
  return file('chord5-ff', notes, 120)
}

export function buildCluster(velocity: number): MidiFile {
  const notes = CLUSTER_PITCHES.map((pitch) => ({
    pitch,
    time: 0,
    duration: CLUSTER_HOLD_S,
    velocity,
  }))
  return file(`cluster-v${velocity}`, notes, 120)
}

export function buildStack(): MidiFile {
  const end = (STACK_PITCHES.length - 1) * STACK_STEP_S + STACK_TAIL_S
  const notes = STACK_PITCHES.map((pitch, i) => {
    const time = i * STACK_STEP_S
    return { pitch, time, duration: end - time, velocity: 1 }
  })
  return file('stack-185', notes, STACK_BPM)
}

// Sustain-pedal emulation for a real piece: every note rings until the end of
// its bar, as a player holding the pedal through each bar would produce.
// Mirrors how the parser sets `releaseAt` (only when it extends the note).
export function applyBarSustain(midi: MidiFile): MidiFile {
  const [num, den] = midi.timeSignature
  const barS = (60 / midi.bpm) * num * (4 / den)
  let duration = 0
  const tracks = midi.tracks.map((t) => ({
    ...t,
    notes: t.notes.map((n) => {
      const barEnd = (Math.floor(n.time / barS + 1e-6) + 1) * barS
      const notatedEnd = n.time + n.duration
      const out: MidiNote = barEnd > notatedEnd ? { ...n, releaseAt: barEnd } : { ...n }
      duration = Math.max(duration, out.releaseAt ?? notatedEnd)
      return out
    }),
  }))
  return { ...midi, name: `${midi.name}+pedal`, duration, tracks }
}

// How many notes are audibly sounding at time t — maps a clip timestamp back
// onto "the Nth key pressed" for the stack fixture and onto chord density for
// real pieces.
export function notesSoundingAt(midi: MidiFile, t: number): number {
  let n = 0
  for (const track of midi.tracks) {
    for (const note of track.notes) {
      const end = note.releaseAt ?? note.time + note.duration
      if (note.time <= t && t < end) n++
    }
  }
  return n
}

// Keep only notes starting before `seconds`; notes are cut at the boundary so
// the render stops there too (plus the renderer's own tail).
export function truncateMidi(midi: MidiFile, seconds: number): MidiFile {
  const tracks = midi.tracks.map((t) => ({
    ...t,
    notes: t.notes
      .filter((n) => n.time < seconds)
      .map((n) => {
        const end = Math.min(n.releaseAt ?? n.time + n.duration, seconds)
        const out: MidiNote = { ...n, duration: Math.min(n.duration, seconds - n.time) }
        if (n.releaseAt !== undefined) out.releaseAt = end
        return out
      }),
  }))
  return { ...midi, name: `${midi.name}-${seconds}s`, duration: seconds, tracks }
}

export function buildSyntheticFixture(
  id: Exclude<AudioFixtureId, 'pedal-piece' | 'piece-20'>,
): MidiFile {
  switch (id) {
    case 'single-ff':
      return buildSingle()
    case 'chord5-ff':
      return buildChord5()
    case 'cluster-ff':
      return buildCluster(1)
    case 'cluster-mf':
      return buildCluster(0.6)
    case 'stack-185':
      return buildStack()
  }
}
