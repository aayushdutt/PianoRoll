import * as Tone from 'tone'
import type { MidiFile } from '../core/midi/types'
import { createEventSignal } from '../store/eventSignal'
import type { AudioEngine } from './AudioEngine'
import {
  createInstrument,
  type InstrumentId,
  type InstrumentRuntime,
  midiToNoteName,
} from './instruments'

export type { InstrumentId, InstrumentInfo } from './instruments'
export { INSTRUMENTS } from './instruments'

interface NoteEvent {
  note: string
  duration: number
  velocity: number
}

export class SynthEngine implements AudioEngine {
  private instruments = new Map<InstrumentId, InstrumentRuntime>()
  private loadingPromises = new Map<InstrumentId, Promise<InstrumentRuntime>>()
  // Default voice is Upright (1.2 MB of our own samples) instead of the 30 MB
  // Salamander Grand set that @tonejs/piano pulls from an external CDN —
  // 25× lighter first-load, bulletproof against upstream CDN outages, still
  // musically pleasing. Users who specifically want the concert grand are
  // one tap away in the instrument dropdown.
  private currentId: InstrumentId = 'upright'
  // Emits the currently-active instrument id while its samples/patch are
  // loading, null otherwise. Only tracks the *current* instrument — background
  // preloads of other voices don't flicker the signal.
  readonly loadingInstrument = createEventSignal<InstrumentId | null>(null)
  private midi: MidiFile | null = null
  // Tone.Part holding every note as a single transport entry. Replaces N×2
  // transport.schedule calls on play/seek — O(N) work to build, but building a
  // Part is ~10× faster than N individual schedules on dense MIDIs (tested
  // 10k+ notes), and seek reuses the same Part via `part.start(0, offset)`.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private scheduledPart: any | null = null
  private _speed = 1
  private scheduledFromTime = 0
  private readyPromise: Promise<void> = Promise.resolve()
  private liveWarmupStarted = false
  // Latest-wins guard for `play()`. `play()` is async (awaits readyPromise +
  // Tone.start) and can be racing against a subsequent `pause()`. Without
  // this, calling pause during the async window lets the next transport.start
  // at the tail of play() fire after we thought we paused — audio leaks.
  // Each play() call increments; if a newer call or a pause() ran, the older
  // play() bails before hitting transport.start.
  private playGeneration = 0

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

    // Reflect loading in the signal only when we're loading the *current*
    // instrument — preloads of others happen silently in the background.
    if (id === this.currentId) this.loadingInstrument.set(id)

    const clearIfCurrent = (): void => {
      if (this.loadingInstrument.value === id) this.loadingInstrument.set(null)
    }
    const promise = createInstrument(id).then(
      (inst) => {
        this.instruments.set(id, inst)
        this.loadingPromises.delete(id)
        clearIfCurrent()
        return inst
      },
      (err) => {
        this.loadingPromises.delete(id)
        clearIfCurrent()
        throw err
      },
    )
    this.loadingPromises.set(id, promise)
    return promise
  }

  async play(fromTime: number): Promise<void> {
    if (!this.midi) return
    const gen = ++this.playGeneration
    await this.readyPromise
    await Tone.start()
    // A pause() or a newer play() happened during the awaits — abandon this
    // invocation so we don't resurrect transport audio against user intent.
    if (gen !== this.playGeneration) return

    const transport = Tone.getTransport()
    if (transport.state === 'paused' && Math.abs(fromTime - this.scheduledFromTime) < 0.05) {
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

    // Build (or rebuild) a single Tone.Part containing every note from fromTime
    // onward. One transport entry instead of 2×N — on a 10k-note MIDI, seek
    // goes from "visible stall" to "imperceptible".
    //
    // Notes are time-sorted (parser invariant) so binary-search skips past
    // events before fromTime without scanning them.
    const partEvents: [number, NoteEvent][] = []
    for (const track of this.midi.tracks) {
      const notes = track.notes
      let lo = 0
      let hi = notes.length
      while (lo < hi) {
        const mid = (lo + hi) >>> 1
        if (notes[mid]!.time < fromTime) lo = mid + 1
        else hi = mid
      }
      for (let i = lo; i < notes.length; i++) {
        const note = notes[i]!
        partEvents.push([
          note.time - fromTime,
          {
            note: midiToNoteName(note.pitch),
            duration: note.duration,
            velocity: note.velocity,
          },
        ])
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const part = new (Tone as any).Part((time: number, ev: NoteEvent) => {
      // Re-resolve the instrument each tick so mid-playback switches take
      // effect without rebuilding the Part. setInstrument() releases the old
      // voice so overlapping notes from the previous instrument don't linger.
      const inst = this.instruments.get(this.currentId)
      inst?.triggerAttackRelease(ev.note, ev.duration, time, ev.velocity)
    }, partEvents)
    part.start(0)
    this.scheduledPart = part

    transport.bpm.value = nominalBpm * this._speed
    transport.start()
  }

  pause(): void {
    // Bump the generation so any in-flight `play()` aborts before it can
    // reach `transport.start()` and resurrect audio after the pause.
    this.playGeneration++
    Tone.getTransport().pause()
    this.releaseAllInstruments()
  }

  seek(time: number): void {
    const wasPlaying = Tone.getTransport().state === 'started'
    // Same latest-wins guard — a concurrent play() racing with a seek would
    // otherwise restart transport at a stale fromTime.
    this.playGeneration++
    Tone.getTransport().stop()
    this.clearScheduled()
    this.releaseAllInstruments()
    if (wasPlaying) void this.play(time)
  }

  setVolume(v: number): void {
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

  // Scheduled variants for loop playback. Caller supplies an AudioContext time
  // so notes land sample-accurately even if the UI thread stalls.
  scheduleNoteOn(pitch: number, velocity: number, ctxTime: number): void {
    this.primeLiveInput()
    const inst = this.instruments.get(this.currentId)
    if (!inst) return
    inst.triggerAttack(midiToNoteName(pitch), ctxTime, velocity)
  }

  scheduleNoteOff(pitch: number, ctxTime: number): void {
    const inst = this.instruments.get(this.currentId)
    if (!inst) return
    inst.triggerRelease(midiToNoteName(pitch), ctxTime)
  }

  // Exposed so non-audio modules (UI, visuals) can convert AudioContext time
  // into a setTimeout delay without pulling Tone into their imports.
  get audioContextTime(): number {
    return Tone.getContext().currentTime
  }

  // ── Scheduled playback (internal) ──────────────────────────────────────

  private clearScheduled(): void {
    if (this.scheduledPart) {
      this.scheduledPart.stop(0)
      this.scheduledPart.clear()
      this.scheduledPart.dispose()
      this.scheduledPart = null
    }
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
