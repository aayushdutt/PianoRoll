// Factories only touch the current Tone context via `getMasterBus()` (volume
// + soft-clip ceiling, one per context — see masterBus.ts), so they work
// identically inside `Tone.Offline(...)` for export rendering. Nothing here
// may connect to `getDestination()` directly: that bypasses the ceiling.

import {
  Chorus,
  Filter,
  FMSynth,
  getContext,
  type InputNode,
  PolySynth,
  Reverb,
  Sampler,
  Synth,
} from 'tone'
import type { MessageKey } from '../i18n'
import { getMasterBus } from './masterBus'

export type InstrumentId =
  | 'piano'
  | 'upright'
  | 'digital'
  | 'rhodes'
  | 'pad'
  | 'pluck'
  | 'marimba'
  | 'bells'
  | 'strings'
  | 'bass'
  | 'violin'
  | 'flute'
  | 'guitar'

export interface InstrumentInfo {
  id: InstrumentId
  nameKey: MessageKey // i18n key for display name
  descriptionKey: MessageKey // i18n key for short character-of-voice hint
  sampled: boolean // whether loading requires a network fetch
}

export const INSTRUMENTS: readonly InstrumentInfo[] = [
  {
    id: 'piano',
    nameKey: 'instrument.piano.name',
    descriptionKey: 'instrument.piano.description',
    sampled: true,
  },
  {
    id: 'upright',
    nameKey: 'instrument.upright.name',
    descriptionKey: 'instrument.upright.description',
    sampled: true,
  },
  {
    id: 'digital',
    nameKey: 'instrument.digital.name',
    descriptionKey: 'instrument.digital.description',
    sampled: false,
  },
  {
    id: 'rhodes',
    nameKey: 'instrument.rhodes.name',
    descriptionKey: 'instrument.rhodes.description',
    sampled: false,
  },
  {
    id: 'guitar',
    nameKey: 'instrument.guitar.name',
    descriptionKey: 'instrument.guitar.description',
    sampled: true,
  },
  {
    id: 'violin',
    nameKey: 'instrument.violin.name',
    descriptionKey: 'instrument.violin.description',
    sampled: true,
  },
  {
    id: 'flute',
    nameKey: 'instrument.flute.name',
    descriptionKey: 'instrument.flute.description',
    sampled: true,
  },
  {
    id: 'marimba',
    nameKey: 'instrument.marimba.name',
    descriptionKey: 'instrument.marimba.description',
    sampled: false,
  },
  {
    id: 'bells',
    nameKey: 'instrument.bells.name',
    descriptionKey: 'instrument.bells.description',
    sampled: false,
  },
  {
    id: 'strings',
    nameKey: 'instrument.strings.name',
    descriptionKey: 'instrument.strings.description',
    sampled: false,
  },
  {
    id: 'pad',
    nameKey: 'instrument.pad.name',
    descriptionKey: 'instrument.pad.description',
    sampled: false,
  },
  {
    id: 'pluck',
    nameKey: 'instrument.pluck.name',
    descriptionKey: 'instrument.pluck.description',
    sampled: false,
  },
  {
    id: 'bass',
    nameKey: 'instrument.bass.name',
    descriptionKey: 'instrument.bass.description',
    sampled: false,
  },
]

export interface InstrumentRuntime {
  triggerAttack(note: string, time: number, velocity: number): void
  triggerRelease(note: string, time: number): void
  // Combined attack+release lets scheduled playback fire one event per note
  // instead of two separate transport entries — cheaper on dense MIDIs and
  // lets Tone.Part batch events into a single transport slot.
  triggerAttackRelease(note: string, duration: number, time: number, velocity: number): void
  releaseAll(): void
  dispose(): void
}

/** Minimal `@tonejs/piano` instance (the package ships without TS types). */
type TonePianoInstance = {
  connect(destination: InputNode): TonePianoInstance
  strings: { value: number } // dB, the sampled-strings layer volume
  load(): Promise<void>
  keyDown(params: { note: string; velocity: number; time: number }): void
  keyUp(params: { note: string; time: number }): void
  stopAll(): void
  dispose(): void
}

type PianoConstructor = new (opts: { velocities: number }) => TonePianoInstance
type PianoModule = { Piano: PianoConstructor }
let pianoModule: PianoModule | null = null

async function getPianoModule(): Promise<PianoModule> {
  if (!pianoModule) {
    pianoModule = (await import('@tonejs/piano')) as unknown as PianoModule
  }
  return pianoModule
}

// Tone.Reverb renders its impulse response asynchronously (a nested offline
// render) and only then attaches it to the convolver. Nothing downstream waits
// for that — Tone's OfflineContext.render() doesn't either — so an export
// could start before the IR landed and bake the instrument dry. Every reverb
// is built through this helper and createInstrument awaits the batch.
// A Set that self-prunes on settle (rather than a drained array) so two
// instruments being built at once can't steal each other's IR promises;
// over-waiting on a neighbour's reverb is harmless, and allSettled keeps one
// failed IR from rejecting an unrelated instrument.
const pendingReverbs = new Set<Promise<unknown>>()
function makeReverb(opts: ConstructorParameters<typeof Reverb>[0]): Reverb {
  const r = new Reverb(opts)
  const ready = r.ready.finally(() => pendingReverbs.delete(ready))
  pendingReverbs.add(ready)
  return r
}

export async function createInstrument(id: InstrumentId): Promise<InstrumentRuntime> {
  const inst = await buildInstrument(id)
  await Promise.allSettled([...pendingReverbs])
  return inst
}

async function buildInstrument(id: InstrumentId): Promise<InstrumentRuntime> {
  switch (id) {
    case 'piano':
      return await createPiano()
    case 'upright':
      return await createUpright()
    case 'digital':
      return createDigitalPiano()
    case 'rhodes':
      return createRhodes()
    case 'pad':
      return createPad()
    case 'pluck':
      return createPluck()
    case 'marimba':
      return createMarimba()
    case 'bells':
      return createBells()
    case 'strings':
      return createStrings()
    case 'bass':
      return createBass()
    case 'violin':
      return await createViolin()
    case 'flute':
      return await createFlute()
    case 'guitar':
      return await createGuitar()
  }
}

async function createPiano(): Promise<InstrumentRuntime> {
  try {
    const { Piano } = await getPianoModule()
    const inst = new Piano({ velocities: 4 })
    // The package scales its top velocity layer by up to ×1.49, so a single
    // ff note already exceeds full scale (+6 dB measured, headroom bench).
    // -6 dB keeps ff playable through the ceiling without flattening the
    // layering that makes it a grand.
    inst.strings.value = -6
    inst.connect(getMasterBus())
    await inst.load()
    return {
      triggerAttack: (note, time, velocity) => inst.keyDown({ note, velocity, time }),
      triggerRelease: (note, time) => inst.keyUp({ note, time }),
      triggerAttackRelease: (note, duration, time, velocity) => {
        inst.keyDown({ note, velocity, time })
        inst.keyUp({ note, time: time + duration })
      },
      releaseAll: () => inst.stopAll(),
      dispose: () => inst.dispose(),
    }
  } catch (err) {
    console.warn('Piano samples unavailable, falling back to PolySynth', err)
    return createTriangleFallback()
  }
}

function createTriangleFallback(): InstrumentRuntime {
  const synth = new PolySynth(Synth, {
    oscillator: { type: 'triangle' },
    envelope: { attack: 0.005, decay: 0.08, sustain: 0.55, release: 0.5 },
  }).connect(getMasterBus())
  return wrapPolySynth(synth)
}

function createRhodes(): InstrumentRuntime {
  const synth = new PolySynth(FMSynth, {
    harmonicity: 3.2,
    modulationIndex: 6,
    oscillator: { type: 'sine' },
    envelope: { attack: 0.002, decay: 0.9, sustain: 0.12, release: 1.0 },
    modulation: { type: 'sine' },
    modulationEnvelope: { attack: 0.004, decay: 0.6, sustain: 0.05, release: 0.4 },
  })
  synth.volume.value = -2
  const chorus = new Chorus(0.8, 2.5, 0.35).start()
  synth.chain(chorus, getMasterBus())
  return wrapPolySynth(synth)
}

function createPad(): InstrumentRuntime {
  const synth = new PolySynth(Synth, {
    oscillator: { type: 'fatsawtooth', count: 3, spread: 24 },
    envelope: { attack: 0.6, decay: 0.4, sustain: 0.8, release: 1.6 },
  })
  synth.volume.value = -10
  const filter = new Filter({ frequency: 1600, type: 'lowpass', rolloff: -12 })
  const reverb = makeReverb({ decay: 3.5, wet: 0.35 })
  synth.chain(filter, reverb, getMasterBus())
  return wrapPolySynth(synth)
}

function createPluck(): InstrumentRuntime {
  const synth = new PolySynth(Synth, {
    oscillator: { type: 'sawtooth' },
    envelope: { attack: 0.002, decay: 0.18, sustain: 0, release: 0.9 },
  })
  synth.volume.value = -6
  const filter = new Filter({ frequency: 3800, type: 'highpass', rolloff: -12, Q: 0.5 })
  const lowpass = new Filter({ frequency: 6500, type: 'lowpass', rolloff: -24 })
  synth.chain(filter, lowpass, getMasterBus())
  return wrapPolySynth(synth)
}

function createMarimba(): InstrumentRuntime {
  // Bright FM mallet — high harmonicity for crisp "wood" partials, punchy
  // attack with zero sustain so notes pop and die quickly.
  const synth = new PolySynth(FMSynth, {
    harmonicity: 4.2,
    modulationIndex: 12,
    oscillator: { type: 'sine' },
    envelope: { attack: 0.001, decay: 0.18, sustain: 0, release: 0.25 },
    modulation: { type: 'triangle' },
    modulationEnvelope: { attack: 0.001, decay: 0.08, sustain: 0, release: 0.08 },
  })
  synth.volume.value = -5
  const reverb = makeReverb({ decay: 1.2, wet: 0.2 })
  synth.chain(reverb, getMasterBus())
  return wrapPolySynth(synth)
}

function createBells(): InstrumentRuntime {
  // Near-integer harmonicity offset gives the inharmonic overtone stack that
  // reads as "bell". Long modulation + carrier decay lets each strike ring
  // out through the reverb tail.
  const synth = new PolySynth(FMSynth, {
    harmonicity: 3.01,
    modulationIndex: 8,
    oscillator: { type: 'sine' },
    envelope: { attack: 0.002, decay: 2.4, sustain: 0, release: 2.8 },
    modulation: { type: 'sine' },
    modulationEnvelope: { attack: 0.002, decay: 0.5, sustain: 0, release: 1.8 },
  })
  synth.volume.value = -8
  const reverb = makeReverb({ decay: 4.0, wet: 0.4 })
  synth.chain(reverb, getMasterBus())
  return wrapPolySynth(synth)
}

function createStrings(): InstrumentRuntime {
  // Slow-attack fat sawtooth ensemble + lowpass + reverb reads as a section
  // of bowed strings. Detune + spread gives the "many players" feel.
  const synth = new PolySynth(Synth, {
    oscillator: { type: 'fatsawtooth', count: 5, spread: 40 },
    envelope: { attack: 0.35, decay: 0.25, sustain: 0.85, release: 1.4 },
  })
  synth.volume.value = -12
  const filter = new Filter({ frequency: 2400, type: 'lowpass', rolloff: -12 })
  const reverb = makeReverb({ decay: 2.4, wet: 0.32 })
  synth.chain(filter, reverb, getMasterBus())
  return wrapPolySynth(synth)
}

function createBass(): InstrumentRuntime {
  // Triangle core with a lowpass emphasis — round and pillowy even when
  // played in the middle register. Shorter release keeps fast bass lines tight.
  const synth = new PolySynth(Synth, {
    oscillator: { type: 'triangle' },
    envelope: { attack: 0.005, decay: 0.3, sustain: 0.75, release: 0.35 },
  })
  // -13 dB: eight held bass notes summed at low frequency have no crest to
  // hide behind — measured +7 dB over full scale at -4 (headroom bench).
  synth.volume.value = -13
  const filter = new Filter({ frequency: 1200, type: 'lowpass', rolloff: -24, Q: 0.8 })
  synth.chain(filter, getMasterBus())
  return wrapPolySynth(synth)
}

// ── Sampled instruments (lazy-loaded from bundled assets) ──────────────────
//
// Samples sourced from the MIT-licensed nbrosowsky/tonejs-instruments project
// and committed into `public/instrument-samples/` so the app doesn't depend on
// any upstream CDN remaining online. Each call builds a Sampler from the
// instrument's sample map; Tone interpolates between the sampled pitches to
// cover the full piano range. If a fetch still fails (e.g. offline), the
// caller falls through to a synth patch so the app never silently drops notes.

const SAMPLE_BASE = `${import.meta.env.BASE_URL}instrument-samples/`
const SAMPLE_LOAD_TIMEOUT_MS = 15_000

interface SampleSpec {
  folder: string // under SAMPLE_BASE, trailing slash omitted
  files: readonly string[] // raw filenames like ['A4.mp3', 'As3.mp3']
  release?: number
  attack?: number
  volumeDb?: number
}

// Filename convention: 'As3.mp3' = A#3, 'Cs4.mp3' = C#4 (lowercase 's' for
// sharp since '#' isn't URL-safe). Target only the exact sharp pattern
// `<A-G>s<digit>` so malformed filenames fail loud at Sampler setup
// instead of being silently mangled by a loose global replace.
function filenameToNote(file: string): string {
  const raw = file.replace(/\.mp3$/, '')
  return raw.replace(/^([A-G])s(\d)$/, '$1#$2')
}

// Decoded sample buffers cached by folder/file so repeated Sampler construction
// (e.g. every offline export) doesn't refetch or redecode. AudioBuffer is pure
// PCM data — safe to share across contexts (live Tone context AND offline
// render contexts), which is the key fix for slow exports: previously each
// export refetched MP3s and decoded them against a throwaway offline context.
const sampleBufferCache = new Map<string, Map<string, AudioBuffer>>()
const pendingFolderLoads = new Map<string, Promise<Map<string, AudioBuffer>>>()

async function loadFolderBuffers(spec: SampleSpec): Promise<Map<string, AudioBuffer>> {
  const existing = sampleBufferCache.get(spec.folder)
  if (existing && spec.files.every((f) => existing.has(f))) return existing

  const pending = pendingFolderLoads.get(spec.folder)
  if (pending) return pending

  const base = `${SAMPLE_BASE}${spec.folder}/`
  const load = Promise.race([
    (async () => {
      const folder = existing ?? new Map<string, AudioBuffer>()
      // Decode against the live online context. AudioBuffers returned here
      // remain valid when passed into a later OfflineContext Sampler.
      const ctx = getContext()
      await Promise.all(
        spec.files.map(async (file) => {
          if (folder.has(file)) return
          const res = await fetch(`${base}${file}`)
          const arr = await res.arrayBuffer()
          const decoded = await ctx.decodeAudioData(arr)
          folder.set(file, decoded)
        }),
      )
      sampleBufferCache.set(spec.folder, folder)
      return folder
    })(),
    new Promise<Map<string, AudioBuffer>>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Sample load timeout: ${spec.folder}`)),
        SAMPLE_LOAD_TIMEOUT_MS,
      ),
    ),
  ]).finally(() => {
    pendingFolderLoads.delete(spec.folder)
  })

  pendingFolderLoads.set(spec.folder, load)
  return load
}

async function createSampled(
  spec: SampleSpec,
  chain?: (sampler: Sampler) => void,
): Promise<InstrumentRuntime> {
  const buffers = await loadFolderBuffers(spec)

  const urls: Record<string, AudioBuffer> = {}
  for (const file of spec.files) {
    const buf = buffers.get(file)
    if (!buf) throw new Error(`Sample buffer missing after load: ${spec.folder}/${file}`)
    urls[filenameToNote(file)] = buf
  }

  const sampler = new Sampler({
    urls,
    release: spec.release ?? 1,
    attack: spec.attack ?? 0,
  })
  if (spec.volumeDb !== undefined) sampler.volume.value = spec.volumeDb
  if (chain) chain(sampler)
  else sampler.connect(getMasterBus())

  // Buffers are already decoded and passed by reference, so Sampler has
  // nothing async to wait on — no Tone.loaded() race needed.

  return {
    triggerAttack: (note, time, velocity) => sampler.triggerAttack(note, time, velocity),
    triggerRelease: (note, time) => sampler.triggerRelease(note, time),
    triggerAttackRelease: (note, duration, time, velocity) =>
      sampler.triggerAttackRelease(note, duration, time, velocity),
    releaseAll: () => sampler.releaseAll(),
    dispose: () => sampler.dispose(),
  }
}

// Preload sample buffers for an instrument spec without building a Sampler.
// Export pipeline calls this on the online context before `Tone.Offline` so
// that offline render doesn't pay fetch+decode cost.
export async function preloadSampleBuffers(id: InstrumentId): Promise<void> {
  const spec = SAMPLED_SPECS[id]
  if (!spec) return
  await loadFolderBuffers(spec)
}

// Spec lookup for sampled instruments. Keeping the spec objects in one place
// lets the preload path share exactly the same inputs as the Sampler path.
const SAMPLED_SPECS: Partial<Record<InstrumentId, SampleSpec>> = {
  upright: {
    folder: 'piano',
    files: ['A1.mp3', 'A2.mp3', 'A3.mp3', 'A4.mp3', 'A5.mp3', 'A6.mp3', 'A7.mp3', 'C8.mp3'],
    release: 1.1,
    volumeDb: -6,
  },
  violin: {
    folder: 'violin',
    files: [
      'A3.mp3',
      'A4.mp3',
      'A5.mp3',
      'A6.mp3',
      'C4.mp3',
      'C5.mp3',
      'C6.mp3',
      'C7.mp3',
      'E4.mp3',
      'E5.mp3',
      'E6.mp3',
      'G3.mp3',
      'G4.mp3',
      'G5.mp3',
      'G6.mp3',
    ],
    release: 1.4,
    volumeDb: -5.5,
  },
  flute: {
    folder: 'flute',
    files: [
      'A4.mp3',
      'A5.mp3',
      'A6.mp3',
      'C4.mp3',
      'C5.mp3',
      'C6.mp3',
      'C7.mp3',
      'E4.mp3',
      'E5.mp3',
      'E6.mp3',
    ],
    release: 0.9,
    volumeDb: -7.5,
  },
  guitar: {
    folder: 'guitar-acoustic',
    files: [
      'A2.mp3',
      'A3.mp3',
      'A4.mp3',
      'As2.mp3',
      'As3.mp3',
      'As4.mp3',
      'B2.mp3',
      'B3.mp3',
      'B4.mp3',
      'C3.mp3',
      'C4.mp3',
      'C5.mp3',
      'Cs3.mp3',
      'Cs4.mp3',
      'Cs5.mp3',
      'D2.mp3',
      'D3.mp3',
      'D4.mp3',
      'D5.mp3',
      'Ds2.mp3',
      'Ds3.mp3',
      'Ds4.mp3',
      'E2.mp3',
      'E3.mp3',
      'E4.mp3',
      'F2.mp3',
      'F3.mp3',
      'F4.mp3',
      'Fs2.mp3',
      'Fs3.mp3',
      'Fs4.mp3',
      'G2.mp3',
      'G3.mp3',
      'G4.mp3',
      'Gs2.mp3',
      'Gs3.mp3',
      'Gs4.mp3',
    ],
    release: 0.8,
    volumeDb: -5.5,
  },
}

async function createViolin(): Promise<InstrumentRuntime> {
  try {
    return await createSampled(SAMPLED_SPECS.violin!, (s) => {
      const reverb = makeReverb({ decay: 1.8, wet: 0.22 })
      s.chain(reverb, getMasterBus())
    })
  } catch (err) {
    console.warn('Violin samples unavailable, falling back to synth strings', err)
    return createStrings()
  }
}

async function createFlute(): Promise<InstrumentRuntime> {
  try {
    return await createSampled(SAMPLED_SPECS.flute!, (s) => {
      const reverb = makeReverb({ decay: 1.4, wet: 0.18 })
      s.chain(reverb, getMasterBus())
    })
  } catch (err) {
    console.warn('Flute samples unavailable, falling back to synth', err)
    // No existing flute-ish synth — a soft triangle with gentle attack is the
    // closest approximation among what we already have.
    return createTriangleFallback()
  }
}

async function createUpright(): Promise<InstrumentRuntime> {
  try {
    // Eight well-spaced samples (one per octave plus C8) — Sampler
    // interpolates the semitones between. Piano interpolation sounds clean
    // because timbre doesn't change much within an octave.
    return await createSampled(SAMPLED_SPECS.upright!, (s) => {
      // Slight room reverb — the upright sits "in the room" vs the Grand's
      // concert stage, but neither wants heavy ambience.
      const reverb = makeReverb({ decay: 1.4, wet: 0.15 })
      s.chain(reverb, getMasterBus())
    })
  } catch (err) {
    console.warn('Upright samples unavailable, falling back to Grand', err)
    return createPiano()
  }
}

function createDigitalPiano(): InstrumentRuntime {
  // Clean stage-piano voice: a near-unity-harmonicity FM patch gives a subtle
  // bell attack over a mostly sine body — reads as "digital Yamaha-style"
  // rather than acoustic grand. Gentle chorus widens the stereo image.
  const synth = new PolySynth(FMSynth, {
    harmonicity: 1.0,
    modulationIndex: 2.6,
    oscillator: { type: 'sine' },
    envelope: { attack: 0.003, decay: 0.9, sustain: 0.25, release: 0.85 },
    modulation: { type: 'sine' },
    modulationEnvelope: { attack: 0.003, decay: 0.35, sustain: 0, release: 0.3 },
  })
  // Sine-carrier FM lands quieter per-voice than the sawtooth/triangle-based
  // patches in this file; +2 dB nudges it past Rhodes/Marimba so it reads as
  // the bright "stage piano" it's meant to be.
  // Level set by the headroom bench (docs/AUDIO_CLIP_FIX_2026-09-05.md): the
  // FM attack is peaky (crest ~21 dB), so it sits lower than it sounds.
  synth.volume.value = -4
  const chorus = new Chorus(1.1, 2.0, 0.2).start()
  const reverb = makeReverb({ decay: 1.1, wet: 0.14 })
  synth.chain(chorus, reverb, getMasterBus())
  return wrapPolySynth(synth)
}

async function createGuitar(): Promise<InstrumentRuntime> {
  try {
    // Guitar has a dense sample map (every semitone A2..G#4), so interpolation
    // artefacts are minimal and the plucked attack reads cleanly.
    return await createSampled(SAMPLED_SPECS.guitar!, (s) => {
      const reverb = makeReverb({ decay: 1.2, wet: 0.14 })
      s.chain(reverb, getMasterBus())
    })
  } catch (err) {
    console.warn('Guitar samples unavailable, falling back to synth pluck', err)
    return createPluck()
  }
}

/** PolySynth voice used by non-sampled patches — narrow to what we invoke. */
type PolyToneSource = {
  triggerAttack(note: string, time: number, velocity: number): void
  triggerRelease(note: string, time: number): void
  triggerAttackRelease(note: string, duration: number, time: number, velocity: number): void
  releaseAll(): void
  dispose(): void
}

function wrapPolySynth(synth: PolyToneSource): InstrumentRuntime {
  return {
    triggerAttack: (note, time, velocity) => synth.triggerAttack(note, time, velocity),
    triggerRelease: (note, time) => synth.triggerRelease(note, time),
    triggerAttackRelease: (note, duration, time, velocity) =>
      synth.triggerAttackRelease(note, duration, time, velocity),
    releaseAll: () => synth.releaseAll(),
    dispose: () => synth.dispose(),
  }
}

// MIDI note-name conversion lives in `./midiNoteName` so tone-free consumers
// (tests, pure helpers) can import it without dragging the Tone bundle.
export { midiToNoteName } from './midiNoteName'
