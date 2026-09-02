import type { MidiFile } from './types'

// Playback transpose: the one place raw parsed pitches become the pitches
// every consumer sees. Pure and cheap: the app derives once per transpose
// change, so the renderer, SynthEngine, offline export and practice engines
// read identical pitches by construction.
//
// Pitches are NOT clamped or folded into the 88-key range. A note outside
// A0–C8 (from the file, or pushed there by a transpose) stays where it is:
// the synth plays it, the roll and keyboard simply have no key to draw it on
// (Viewport.hasKey). Folding by octaves was tried and reads as wrong notes.

export interface DeriveOptions {
  transpose: number // semitones; 0 = passthrough
}

export function deriveMidi(source: MidiFile, opts: DeriveOptions): MidiFile {
  const transpose = Number.isFinite(opts.transpose) ? Math.trunc(opts.transpose) : 0
  // Nothing moves — hand back the same object so the common case allocates
  // nothing and reference-equality checks downstream stay meaningful.
  if (transpose === 0) return source

  const tracks = source.tracks.map((track) => ({
    ...track,
    // Spread: pitch is the only field this step owns; velocity, `releaseAt`
    // and anything added later must survive untouched.
    notes: track.notes.map((note) => ({ ...note, pitch: note.pitch + transpose })),
  }))
  return { ...source, tracks }
}
