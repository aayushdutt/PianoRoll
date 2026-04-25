// Factories only touch the current Tone context via `getDestination()`,
// so they work identically inside `Tone.Offline(...)` for export rendering.

import {
  Chorus,
  Filter,
  FMSynth,
  getContext,
  getDestination,
  PolySynth,
  Reverb,
  Sampler,
  Synth,
} from 'tone'

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
  name: string // display name
  description: string // short character-of-voice hint
  sampled: boolean // whether loading requires a network fetch
}

export const INSTRUMENTS: readonly InstrumentInfo[] = [
  { id: 'piano', name: 'Piano', description: 'Warm acoustic grand', sampled: true },
  { id: 'upright', name: 'Upright', description: 'Intimate upright · HD', sampled: true },
  { id: 'digital', name: 'Digital', description: 'Clean stage piano', sampled: false },
  { id: 'rhodes', name: 'Rhodes', description: 'Mellow electric piano', sampled: false },
  { id: 'guitar', name: 'Guitar', description: 'Acoustic nylon · HD', sampled: true },
  { id: 'violin', name: 'Violin', description: 'Bowed strings · HD', sampled: true },
  { id: 'flute', name: 'Flute', description: 'Breathy wind · HD', sampled: true },
  { id: 'marimba', name: 'Marimba', description: 'Woody mallet', sampled: false },
  { id: 'bells', name: 'Bells', description: 'Crystalline chimes', sampled: false },
  { id: 'strings', name: 'Strings', description: 'Swelling ensemble', sampled: false },
  { id: 'pad', name: 'Pad', description: 'Airy sustained pad', sampled: false },
  { id: 'pluck', name: 'Pluck', description: 'Bright percussive', sampled: false },
  { id: 'bass', name: 'Bass', description: 'Round low sustain', sampled: false },
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
  toDestination(): TonePianoInstance
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

export async function createInstrument(id: InstrumentId): Promise<InstrumentRuntime> {
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
    inst.toDestination()
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
  }).toDestination()
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
  const chorus = new Chorus(0.8, 2.5, 0.35).start()
  synth.chain(chorus, getDestination())
  return wrapPolySynth(synth)
}

function createPad(): InstrumentRuntime {
  const synth = new PolySynth(Synth, {
    oscillator: { type: 'fatsawtooth', count: 3, spread: 24 },
    envelope: { attack: 0.6, decay: 0.4, sustain: 0.8, release: 1.6 },
  })
  synth.volume.value = -10
  const filter = new Filter({ frequency: 1600, type: 'lowpass', rolloff: -12 })
  const reverb = new Reverb({ decay: 3.5, wet: 0.35 })
  synth.chain(filter, reverb, getDestination())
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
  synth.chain(filter, lowpass, getDestination())
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
  synth.volume.value = -4
  const reverb = new Reverb({ decay: 1.2, wet: 0.2 })
  synth.chain(reverb, getDestination())
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
  const reverb = new Reverb({ decay: 4.0, wet: 0.4 })
  synth.chain(reverb, getDestination())
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
  const reverb = new Reverb({ decay: 2.4, wet: 0.32 })
  synth.chain(filter, reverb, getDestination())
  return wrapPolySynth(synth)
}

function createBass(): InstrumentRuntime {
  // Triangle core with a lowpass emphasis — round and pillowy even when
  // played in the middle register. Shorter release keeps fast bass lines tight.
  const synth = new PolySynth(Synth, {
    oscillator: { type: 'triangle' },
    envelope: { attack: 0.005, decay: 0.3, sustain: 0.75, release: 0.35 },
  })
  synth.volume.value = -4
  const filter = new Filter({ frequency: 1200, type: 'lowpass', rolloff: -24, Q: 0.8 })
  synth.chain(filter, getDestination())
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
  else sampler.toDestination()

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
    volumeDb: -3,
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
    volumeDb: -4,
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
    volumeDb: -6,
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
    volumeDb: -2,
  },
}

async function createViolin(): Promise<InstrumentRuntime> {
  try {
    return await createSampled(SAMPLED_SPECS.violin!, (s) => {
      const reverb = new Reverb({ decay: 1.8, wet: 0.22 })
      s.chain(reverb, getDestination())
    })
  } catch (err) {
    console.warn('Violin samples unavailable, falling back to synth strings', err)
    return createStrings()
  }
}

async function createFlute(): Promise<InstrumentRuntime> {
  try {
    return await createSampled(SAMPLED_SPECS.flute!, (s) => {
      const reverb = new Reverb({ decay: 1.4, wet: 0.18 })
      s.chain(reverb, getDestination())
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
      const reverb = new Reverb({ decay: 1.4, wet: 0.15 })
      s.chain(reverb, getDestination())
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
  synth.volume.value = -6
  const chorus = new Chorus(1.1, 2.0, 0.2).start()
  const reverb = new Reverb({ decay: 1.1, wet: 0.14 })
  synth.chain(chorus, reverb, getDestination())
  return wrapPolySynth(synth)
}

async function createGuitar(): Promise<InstrumentRuntime> {
  try {
    // Guitar has a dense sample map (every semitone A2..G#4), so interpolation
    // artefacts are minimal and the plucked attack reads cleanly.
    return await createSampled(SAMPLED_SPECS.guitar!, (s) => {
      const reverb = new Reverb({ decay: 1.2, wet: 0.14 })
      s.chain(reverb, getDestination())
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

// ── MIDI note-name table ────────────────────────────────────────────────

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const MIDI_NOTE_NAMES: readonly string[] = (() => {
  const out: string[] = new Array(128)
  for (let m = 0; m < 128; m++) {
    const octave = Math.floor(m / 12) - 1
    out[m] = `${NOTE_NAMES[m % 12]!}${octave}`
  }
  return out
})()

export function midiToNoteName(midi: number): string {
  return MIDI_NOTE_NAMES[midi]!
}
