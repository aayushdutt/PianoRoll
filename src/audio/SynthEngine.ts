import * as Tone from 'tone'
import type { MidiFile, MidiNote, MidiTrack } from '../core/midi/types'
import type { AudioEngine } from './AudioEngine'

// ── Instrument roster ───────────────────────────────────────────────────
// Piano uses the sampled Salamander set (lazy-loaded, ~5MB). The other three
// are pure Tone synths — instant, zero network.

export type InstrumentId = 'piano' | 'rhodes' | 'pad' | 'pluck'

export interface InstrumentInfo {
  id: InstrumentId
  name: string       // display name
  sampled: boolean   // whether loading requires a network fetch
}

export const INSTRUMENTS: readonly InstrumentInfo[] = [
  { id: 'piano',  name: 'Piano',  sampled: true  },
  { id: 'rhodes', name: 'Rhodes', sampled: false },
  { id: 'pad',    name: 'Pad',    sampled: false },
  { id: 'pluck',  name: 'Pluck',  sampled: false },
]

interface InstrumentRuntime {
  triggerAttack(note: string, time: number, velocity: number): void
  triggerRelease(note: string, time: number): void
  releaseAll(): void
  dispose(): void
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PianoModule = { Piano: any }
let pianoModule: PianoModule | null = null

async function getPianoModule(): Promise<PianoModule> {
  if (!pianoModule) {
    pianoModule = await import('@tonejs/piano') as unknown as PianoModule
  }
  return pianoModule
}

export class SynthEngine implements AudioEngine {
  private instruments = new Map<InstrumentId, InstrumentRuntime>()
  private loadingPromises = new Map<InstrumentId, Promise<InstrumentRuntime>>()
  private currentId: InstrumentId = 'piano'
  private midi: MidiFile | null = null
  private scheduledIds: number[] = []
  private _volume = 0.8
  private _speed = 1
  private scheduledFromTime = 0
  private readyPromise: Promise<void> = Promise.resolve()
  private liveWarmupStarted = false

  async load(source: MidiFile | AudioBuffer): Promise<void> {
    if (!(source instanceof AudioBuffer)) {
      this.midi = source as MidiFile
    }
    this.readyPromise = this.ensureInstrument(this.currentId).then(() => undefined)
    return this.readyPromise
  }

  // Kick off piano sample download in the background — safe to call at app
  // boot. AudioContext still requires a user gesture before `play()`.
  preloadDefault(): void {
    void this.ensureInstrument(this.currentId).catch(() => undefined)
  }

  // Switch the active instrument for both scheduled and live playback.
  // Loading is lazy; selecting an unloaded instrument kicks off its init.
  async setInstrument(id: InstrumentId): Promise<void> {
    if (id === this.currentId) return
    // Release anything currently sounding on the old instrument
    this.instruments.get(this.currentId)?.releaseAll()
    this.currentId = id
    await this.ensureInstrument(id)
  }

  get instrument(): InstrumentId {
    return this.currentId
  }

  private ensureInstrument(id: InstrumentId): Promise<InstrumentRuntime> {
    const cached = this.instruments.get(id)
    if (cached) return Promise.resolve(cached)
    const existing = this.loadingPromises.get(id)
    if (existing) return existing

    const promise = this.createInstrument(id).then((inst) => {
      this.instruments.set(id, inst)
      this.loadingPromises.delete(id)
      return inst
    })
    this.loadingPromises.set(id, promise)
    return promise
  }

  private async createInstrument(id: InstrumentId): Promise<InstrumentRuntime> {
    switch (id) {
      case 'piano':  return await createPiano()
      case 'rhodes': return createRhodes()
      case 'pad':    return createPad()
      case 'pluck':  return createPluck()
    }
  }

  async play(fromTime: number): Promise<void> {
    if (!this.midi) return
    await this.readyPromise
    await Tone.start()

    const transport = Tone.getTransport()
    if (transport.state === 'paused'
        && Math.abs(fromTime - this.scheduledFromTime) < 0.05) {
      transport.start()
      return
    }

    this.clearScheduled()
    transport.stop()
    transport.position = 0
    this.scheduledFromTime = fromTime

    // Tone converts seconds→ticks using the *current* bpm at schedule time.
    // We schedule at the nominal tempo so every event's tick position encodes
    // the note's original musical moment, then reapply the speed-scaled bpm
    // right before start(). The transport then ticks `speed ×` faster and
    // events fire at `t / speed` wall time — matching MasterClock.currentTime,
    // which advances at `speed × wall`. If we schedule while bpm is already
    // `midi.bpm × speed`, the two scalings cancel and audio plays at 1× while
    // the visual clock is at `speed ×` → desync on fresh play / seek.
    const nominalBpm = this.midi.bpm
    transport.bpm.value = nominalBpm

    for (const track of this.midi.tracks) {
      for (const note of track.notes) {
        if (note.time < fromTime) continue
        const t = note.time - fromTime
        this.scheduledIds.push(
          transport.schedule((time) => this.triggerNoteOn(note, track, time), t),
          transport.schedule((time) => this.triggerNoteOff(note, time), t + note.duration),
        )
      }
    }

    transport.bpm.value = nominalBpm * this._speed
    transport.start()
  }

  pause(): void {
    Tone.getTransport().pause()
    this.releaseAllInstruments()
  }

  seek(time: number): void {
    const wasPlaying = Tone.getTransport().state === 'started'
    Tone.getTransport().stop()
    this.clearScheduled()
    this.releaseAllInstruments()
    if (wasPlaying) void this.play(time)
  }

  setVolume(v: number): void {
    this._volume = v
    Tone.getDestination().volume.value = Tone.gainToDb(v)
  }

  setSpeed(s: number): void {
    this._speed = s
    Tone.getTransport().bpm.value = (this.midi?.bpm ?? 120) * s
  }

  // ── Live MIDI keyboard input ───────────────────────────────────────────

  primeLiveInput(): void {
    if (this.liveWarmupStarted) return
    this.liveWarmupStarted = true
    void Tone.start().catch(() => undefined)
    void this.ensureInstrument(this.currentId).catch(() => undefined)
  }

  liveNoteOn(pitch: number, velocity: number): void {
    this.primeLiveInput()
    const inst = this.instruments.get(this.currentId)
    if (!inst) return // still loading — first notes may drop, acceptable tradeoff
    inst.triggerAttack(midiToNoteName(pitch), Tone.immediate(), velocity)
  }

  liveNoteOff(pitch: number): void {
    const inst = this.instruments.get(this.currentId)
    if (!inst) return
    inst.triggerRelease(midiToNoteName(pitch), Tone.immediate())
  }

  liveReleaseAll(): void {
    this.releaseAllInstruments()
  }

  // ── Scheduled playback (internal) ──────────────────────────────────────

  private triggerNoteOn(note: MidiNote, _track: MidiTrack, time: number): void {
    const inst = this.instruments.get(this.currentId)
    inst?.triggerAttack(midiToNoteName(note.pitch), time, note.velocity)
  }

  private triggerNoteOff(note: MidiNote, time: number): void {
    const inst = this.instruments.get(this.currentId)
    inst?.triggerRelease(midiToNoteName(note.pitch), time)
  }

  private clearScheduled(): void {
    const transport = Tone.getTransport()
    for (const id of this.scheduledIds) transport.clear(id)
    this.scheduledIds = []
  }

  private releaseAllInstruments(): void {
    for (const inst of this.instruments.values()) inst.releaseAll()
  }

  dispose(): void {
    this.clearScheduled()
    Tone.getTransport().stop()
    for (const inst of this.instruments.values()) inst.dispose()
    this.instruments.clear()
  }
}

// ── Instrument factories ────────────────────────────────────────────────

async function createPiano(): Promise<InstrumentRuntime> {
  try {
    const { Piano } = await getPianoModule()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inst: any = new Piano({ velocities: 4 })
    inst.toDestination()
    await inst.load()
    return {
      triggerAttack: (note, time, velocity) => inst.keyDown({ note, velocity, time }),
      triggerRelease: (note, time) => inst.keyUp({ note, time }),
      releaseAll: () => inst.stopAll(),
      dispose: () => inst.dispose(),
    }
  } catch (err) {
    console.warn('Piano samples unavailable, falling back to PolySynth', err)
    // Fall through — return a triangle synth so the app still plays.
    return createTriangleFallback()
  }
}

function createTriangleFallback(): InstrumentRuntime {
  const synth = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: 'triangle' },
    envelope: { attack: 0.005, decay: 0.08, sustain: 0.55, release: 0.5 },
  }).toDestination()
  return wrapPolySynth(synth)
}

function createRhodes(): InstrumentRuntime {
  // FMSynth with a bell-like modulator gives a passable electric piano.
  const synth = new Tone.PolySynth(Tone.FMSynth, {
    harmonicity: 3.2,
    modulationIndex: 6,
    oscillator: { type: 'sine' },
    envelope:   { attack: 0.002, decay: 0.9, sustain: 0.12, release: 1.0 },
    modulation: { type: 'sine' },
    modulationEnvelope: { attack: 0.004, decay: 0.6, sustain: 0.05, release: 0.4 },
  })
  const chorus = new Tone.Chorus(0.8, 2.5, 0.35).start()
  synth.chain(chorus, Tone.getDestination())
  return wrapPolySynth(synth)
}

function createPad(): InstrumentRuntime {
  // Soft sustaining pad with slow attack and detuned sawtooth voices.
  const synth = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: 'fatsawtooth', count: 3, spread: 24 },
    envelope:   { attack: 0.6, decay: 0.4, sustain: 0.8, release: 1.6 },
  })
  synth.volume.value = -10
  const filter = new Tone.Filter({ frequency: 1600, type: 'lowpass', rolloff: -12 })
  const reverb = new Tone.Reverb({ decay: 3.5, wet: 0.35 })
  synth.chain(filter, reverb, Tone.getDestination())
  return wrapPolySynth(synth)
}

function createPluck(): InstrumentRuntime {
  // Percussive plucked-string approximation using a short-envelope synth with
  // an HP-filtered sawtooth. PluckSynth can't back a PolySynth in Tone 15+
  // (it's not Monophonic), and we don't need a voice pool here.
  const synth = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: 'sawtooth' },
    envelope:   { attack: 0.002, decay: 0.18, sustain: 0, release: 0.9 },
  })
  synth.volume.value = -6
  const filter = new Tone.Filter({ frequency: 3800, type: 'highpass', rolloff: -12, Q: 0.5 })
  const lowpass = new Tone.Filter({ frequency: 6500, type: 'lowpass', rolloff: -24 })
  synth.chain(filter, lowpass, Tone.getDestination())
  return wrapPolySynth(synth)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function wrapPolySynth(synth: any): InstrumentRuntime {
  return {
    triggerAttack: (note, time, velocity) => synth.triggerAttack(note, time, velocity),
    triggerRelease: (note, time) => synth.triggerRelease(note, time),
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

function midiToNoteName(midi: number): string {
  return MIDI_NOTE_NAMES[midi]!
}
