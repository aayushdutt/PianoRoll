import {
  gainToDb,
  getContext,
  getDestination,
  getTransport,
  immediate,
  Part,
  start as toneStart,
} from 'tone'
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
  trackId: string
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
  // Tracks the user has muted via the Tracks panel. Checked at trigger time
  // inside the scheduled Part — new notes from a disabled track are skipped,
  // notes already in flight finish their natural decay (we don't track per-track
  // voice handles, and stealing them mid-note would click).
  private disabledTrackIds = new Set<string>()
  // Reference-counts live (non-scheduled) voices by pitch, keyed by voiceId.
  // Multiple input sources (MIDI, keyboard, guitar fretboard) can legitimately
  // hold the same MIDI pitch at once (e.g. two guitar strings fretted to the
  // same pitch, or a MIDI note doubled on the keyboard) — without this,
  // `liveNoteOff` from whichever source releases *first* would cut the
  // sample/envelope out from under every other source still holding that
  // pitch. Only actually releases the voice once no source holds it anymore.
  private heldLiveVoicesByPitch = new Map<number, Set<string>>()

  async load(source: MidiFile | AudioBuffer): Promise<void> {
    if (!(source instanceof AudioBuffer)) {
      this.midi = source as MidiFile
    }
    // A new file's tracks are unrelated to whatever the user muted previously.
    this.disabledTrackIds.clear()
    this.readyPromise = this.ensureInstrument(this.currentId).then(() => undefined)
    return this.readyPromise
  }

  setTrackEnabled(trackId: string, enabled: boolean): void {
    if (enabled) this.disabledTrackIds.delete(trackId)
    else this.disabledTrackIds.add(trackId)
  }

  getDisabledTrackIds(): ReadonlySet<string> {
    return this.disabledTrackIds
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
    // Ref-counted live voices belonged to the old instrument's runtime — a
    // stale entry here would block a real release on the new instrument
    // from ever reaching zero.
    this.heldLiveVoicesByPitch.clear()
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
    await toneStart()
    // A pause() or a newer play() happened during the awaits — abandon this
    // invocation so we don't resurrect transport audio against user intent.
    if (gen !== this.playGeneration) return

    const transport = getTransport()
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
            trackId: track.id,
          },
        ])
      }
    }

    // Tone's Part type wants events with a `time` field, but the runtime also
    // accepts `[time, payload]` tuples — cheaper for our 2-key payload. Cast
    // at the boundary; the named import still tree-shakes unused synths.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const part = new (Part as any)((time: number, ev: NoteEvent) => {
      // Re-resolve the instrument each tick so mid-playback switches take
      // effect without rebuilding the Part. setInstrument() releases the old
      // voice so overlapping notes from the previous instrument don't linger.
      if (this.disabledTrackIds.has(ev.trackId)) return
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
    getTransport().pause()
    this.releaseAllInstruments()
  }

  seek(time: number): void {
    const wasPlaying = getTransport().state === 'started'
    // Same latest-wins guard — a concurrent play() racing with a seek would
    // otherwise restart transport at a stale fromTime.
    this.playGeneration++
    getTransport().stop()
    this.clearScheduled()
    this.releaseAllInstruments()
    if (wasPlaying) void this.play(time)
  }

  setVolume(v: number): void {
    getDestination().volume.value = gainToDb(v)
  }

  setSpeed(s: number): void {
    this._speed = s
    getTransport().bpm.value = (this.midi?.bpm ?? 120) * s
  }

  // ── Live MIDI keyboard input ───────────────────────────────────────────

  primeLiveInput(): void {
    if (this.liveWarmupStarted) return
    this.liveWarmupStarted = true
    void toneStart().catch(() => undefined)
    void this.ensureInstrument(this.currentId).catch(() => undefined)
  }

  // `voiceId` identifies the specific press for ref-counting — omit it only
  // for callers with no voice identity (legacy mouse/touch), which falls
  // back to a per-pitch key and so can still only collide with itself.
  liveNoteOn(pitch: number, velocity: number, voiceId?: string): void {
    this.primeLiveInput()
    const inst = this.instruments.get(this.currentId)
    if (!inst) return // still loading — first notes may drop, acceptable tradeoff
    this.trackLiveVoiceHeld(pitch, voiceId)
    inst.triggerAttack(midiToNoteName(pitch), immediate(), velocity)
  }

  liveNoteOff(pitch: number, voiceId?: string): void {
    if (!this.releaseLiveVoiceHeld(pitch, voiceId)) return
    const inst = this.instruments.get(this.currentId)
    if (!inst) return
    inst.triggerRelease(midiToNoteName(pitch), immediate())
  }

  liveReleaseAll(): void {
    this.releaseAllInstruments()
  }

  private trackLiveVoiceHeld(pitch: number, voiceId?: string): void {
    const key = voiceId ?? `legacy:${pitch}`
    let voices = this.heldLiveVoicesByPitch.get(pitch)
    if (!voices) {
      voices = new Set()
      this.heldLiveVoicesByPitch.set(pitch, voices)
    }
    voices.add(key)
  }

  // Returns true when the pitch should actually stop sounding — i.e. no
  // other tracked voice still holds it.
  private releaseLiveVoiceHeld(pitch: number, voiceId?: string): boolean {
    const key = voiceId ?? `legacy:${pitch}`
    const voices = this.heldLiveVoicesByPitch.get(pitch)
    if (!voices) return true // nothing tracked — release unconditionally (legacy callers)
    voices.delete(key)
    if (voices.size > 0) return false
    this.heldLiveVoicesByPitch.delete(pitch)
    return true
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
    return getContext().currentTime
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
    // Any in-flight live-voice ref-counts are meaningless once every
    // instrument has been forcibly released — drop them so a later
    // liveNoteOff for a pre-release voiceId can't wedge future ref-counting.
    this.heldLiveVoicesByPitch.clear()
    for (const inst of this.instruments.values()) inst.releaseAll()
  }

  dispose(): void {
    this.clearScheduled()
    getTransport().stop()
    for (const inst of this.instruments.values()) inst.dispose()
    this.instruments.clear()
  }
}
