import { MIDI_MAX, MIDI_MIN, type MidiFile } from './types'

// The one place raw parsed pitches become the pitches every consumer sees.
// Transpose is applied first, then anything outside A0–C8 is folded back in
// by whole octaves — in that order, so a transpose can never push notes off
// the 88-key layout (viewport has no geometry for them; see Viewport.hasKey).
//
// Pure and cheap: the app derives once at load and re-derives on a transpose
// change, so the renderer, SynthEngine, offline export and practice engines
// read identical pitches by construction instead of each applying their own.

export interface DeriveOptions {
  transpose: number // semitones; 0 = passthrough
}

export interface DerivedMidi {
  midi: MidiFile
  foldedCount: number // notes moved by the octave fold — surfaced once as a toast
}

// Octave-fold into [MIDI_MIN, MIDI_MAX]. Arithmetic rather than a while-loop
// so a garbage pitch (NaN, ±1e9) can't spin. The range spans 88 semitones, so
// one direction of correction always lands inside it.
export function foldPitch(pitch: number): number {
  if (pitch < MIDI_MIN) return pitch + 12 * Math.ceil((MIDI_MIN - pitch) / 12)
  if (pitch > MIDI_MAX) return pitch - 12 * Math.ceil((pitch - MIDI_MAX) / 12)
  return pitch
}

export function deriveMidi(source: MidiFile, opts: DeriveOptions): DerivedMidi {
  const transpose = Number.isFinite(opts.transpose) ? Math.trunc(opts.transpose) : 0
  let foldedCount = 0
  let anyChanged = false

  const tracks = source.tracks.map((track) => {
    let trackChanged = false
    const notes = track.notes.map((note) => {
      const shifted = note.pitch + transpose
      const pitch = foldPitch(shifted)
      if (pitch !== shifted) foldedCount++
      if (pitch === note.pitch) return note
      trackChanged = true
      // Spread: pitch is the only field this step owns, everything else
      // (velocity, and later `releaseAt`) must survive untouched.
      return { ...note, pitch }
    })
    if (!trackChanged) return track
    anyChanged = true
    return { ...track, notes }
  })

  // Nothing moved — hand back the same object so the common case allocates
  // nothing and reference-equality checks downstream stay meaningful.
  if (!anyChanged) return { midi: source, foldedCount }
  return { midi: { ...source, tracks }, foldedCount }
}
