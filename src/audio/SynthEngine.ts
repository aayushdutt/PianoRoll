import * as Tone from 'tone'
import type { MidiFile, MidiNote, MidiTrack } from '../core/midi/types'
import type { AudioEngine } from './AudioEngine'

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private pianoInstance: any = null
  private fallbackSynth: Tone.PolySynth | null = null
  private midi: MidiFile | null = null
  private scheduledIds: number[] = []

  private _volume = 0.8

  // The transport-relative start time of the last full reschedule.
  // Used to distinguish "resume from pause" (no reschedule needed)
  // from "play after seek" (must reschedule).
  private scheduledFromTime = 0

  // Kept as a field so play() can await it without checking a boolean flag.
  // Resolves once the instrument is ready to make sound.
  private readyPromise: Promise<void> = Promise.resolve()
  private liveWarmupStarted = false

  constructor() {
    this.ensureFallbackSynth()
  }

  load(source: MidiFile | AudioBuffer): Promise<void> {
    if (!(source instanceof AudioBuffer)) {
      this.midi = source as MidiFile
    }

    if (!this.pianoInstance) {
      this.readyPromise = this.initInstrument()
    }
    return this.readyPromise
  }

  private async initInstrument(): Promise<void> {
    try {
      const { Piano } = await getPianoModule()
      if (!this.pianoInstance) {
        this.pianoInstance = new Piano({ velocities: 4 })
        this.pianoInstance.toDestination()
        await this.pianoInstance.load()
      }
    } catch (err) {
      console.warn('Piano samples unavailable, falling back to PolySynth', err)
      this.ensureFallbackSynth()
    }
  }

  async play(fromTime: number): Promise<void> {
    if (!this.midi) return

    // Wait for samples to finish downloading. On first play this may take
    // a moment; on subsequent calls readyPromise is already resolved (<1ms).
    await this.readyPromise

    // Ensure the AudioContext is running. Browser autoplay policy suspends it
    // until a user gesture. After the first call this returns in <1ms.
    await Tone.start()

    const transport = Tone.getTransport()

    // Fast path: transport is paused and position hasn't changed — just resume.
    // Avoids rescheduling thousands of notes on every pause → play.
    if (transport.state === 'paused'
        && Math.abs(fromTime - this.scheduledFromTime) < 0.05) {
      transport.start()
      return
    }

    // Full reschedule: initial play, or playing after a seek.
    this.clearScheduled()
    transport.stop()
    transport.position = 0
    this.scheduledFromTime = fromTime

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

    transport.start()
  }

  pause(): void {
    Tone.getTransport().pause()
    this.pianoInstance?.stopAll()
    this.fallbackSynth?.releaseAll()
  }

  seek(time: number): void {
    const wasPlaying = Tone.getTransport().state === 'started'
    // Stop and clear — forces a full reschedule on the next play() call
    Tone.getTransport().stop()
    this.clearScheduled()
    this.pianoInstance?.stopAll()
    this.fallbackSynth?.releaseAll()
    if (wasPlaying) void this.play(time)
  }

  setVolume(v: number): void {
    this._volume = v
    Tone.getDestination().volume.value = Tone.gainToDb(v)
  }

  setSpeed(s: number): void {
    Tone.getTransport().bpm.value = (this.midi?.bpm ?? 120) * s
  }

  // ── Live MIDI keyboard input ─────────────────────────────────────────────

  // Call during the user-gesture that connects MIDI so the instrument starts
  // loading in the background. By the time they play their first note it's ready.
  async ensureInstrument(): Promise<void> {
    await Tone.start()
    this.liveWarmupStarted = true
    if (!this.pianoInstance) {
      this.readyPromise = this.initInstrument()
    }
    await this.readyPromise
  }

  primeLiveInput(): void {
    if (this.liveWarmupStarted) return
    this.liveWarmupStarted = true
    this.ensureFallbackSynth()
    void Tone.start().catch(() => undefined)
    if (!this.pianoInstance) {
      this.readyPromise = this.initInstrument()
    }
  }

  // Trigger a note immediately (no Transport scheduling) for live input.
  liveNoteOn(pitch: number, velocity: number): void {
    this.primeLiveInput()
    const name = midiToNoteName(pitch)
    const t    = Tone.immediate()
    if (this.pianoInstance) {
      this.pianoInstance.keyDown({ note: name, velocity, time: t })
    } else {
      this.fallbackSynth?.triggerAttack(name, t, velocity)
    }
  }

  liveNoteOff(pitch: number): void {
    this.primeLiveInput()
    const name = midiToNoteName(pitch)
    const t    = Tone.immediate()
    if (this.pianoInstance) {
      this.pianoInstance.keyUp({ note: name, time: t })
    } else {
      this.fallbackSynth?.triggerRelease(name, t)
    }
  }

  liveReleaseAll(): void {
    this.pianoInstance?.stopAll()
    this.fallbackSynth?.releaseAll()
  }

  // ── Scheduled playback (internal) ────────────────────────────────────────

  private triggerNoteOn(note: MidiNote, track: MidiTrack, time: number): void {
    const name = midiToNoteName(note.pitch)
    if (this.pianoInstance) {
      this.pianoInstance.keyDown({ note: name, velocity: note.velocity, time })
    } else {
      this.fallbackSynth?.triggerAttack(name, time, note.velocity)
    }
  }

  private triggerNoteOff(note: MidiNote, time: number): void {
    const name = midiToNoteName(note.pitch)
    if (this.pianoInstance) {
      this.pianoInstance.keyUp({ note: name, time })
    } else {
      this.fallbackSynth?.triggerRelease(name, time)
    }
  }

  private clearScheduled(): void {
    const transport = Tone.getTransport()
    for (const id of this.scheduledIds) transport.clear(id)
    this.scheduledIds = []
  }

  private ensureFallbackSynth(): void {
    if (this.fallbackSynth) return
    this.fallbackSynth = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: 'triangle' },
      envelope: { attack: 0.005, decay: 0.08, sustain: 0.55, release: 0.5 },
    }).toDestination()
  }

  dispose(): void {
    this.clearScheduled()
    Tone.getTransport().stop()
    this.pianoInstance?.dispose()
    this.fallbackSynth?.dispose()
  }
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

function midiToNoteName(midi: number): string {
  const octave = Math.floor(midi / 12) - 1
  return `${NOTE_NAMES[midi % 12]!}${octave}`
}
