import * as Tone from 'tone'
import type { MasterClock } from '../core/clock/MasterClock'
import { Signal } from '../store/state'
import type { CapturedEvent } from './MidiEncoding'

export type LiveLooperState = 'idle' | 'armed' | 'recording' | 'playing' | 'overdubbing'

export type LoopEvent = CapturedEvent

export interface LoopCallbacks {
  // ctxTime is an AudioContext timestamp — callers pass it to
  // `inst.triggerAttack(note, ctxTime, vel)` or schedule a setTimeout for
  // visual alignment.
  onPlaybackNoteOn(pitch: number, velocity: number, ctxTime: number): void
  onPlaybackNoteOff(pitch: number, ctxTime: number): void
}

export type QuantizeDurationFn = (rawDuration: number) => number

// Beginner-friendly looper with the single-button overdub pattern you'd find
// on a Boss RC-1 or Ableton's Looper device:
//   idle → arm → (first note) → record → play → overdub → play → overdub → …
// Playback uses AudioContext-time scheduling with a ~150 ms lookahead so notes
// land sample-accurately regardless of UI thread hiccups.

const LOOKAHEAD_SEC = 0.15
const POLL_INTERVAL_MS = 25

export class LiveLooper {
  readonly state = new Signal<LiveLooperState>('idle')
  readonly progress = new Signal<number>(0)
  readonly layerCount = new Signal<number>(0)

  // Every committed layer, times relative to loop start (0..loopDuration).
  private layers: LoopEvent[][] = []
  private pendingOverdub: LoopEvent[] = []

  // Capture buffer during 'recording' — times relative to the first note.
  private recordBuffer: LoopEvent[] = []
  private recordStartCtxTime = 0

  // Anchored in AudioContext time so audio scheduling stays sample-accurate
  // and immune to wall-clock drift (battery-saver, GC pauses, etc.).
  private loopStartCtxTime = 0
  private loopDuration = 0

  // Per-layer playback cursor: the next (cycle, idx) pair we haven't scheduled
  // yet. We only push events into the audio graph up to LOOKAHEAD seconds in
  // the future, then the poll re-runs and advances further.
  private layerCursors: Array<{ cycle: number; idx: number }> = []

  // Per-layer tracking of pitches currently sounding from loop playback — so
  // undo/clear can emit explicit note-offs for any layer we're tearing out
  // mid-note. Without this, offs are lost with the layer and notes stick.
  private soundingByLayer: Set<number>[] = []

  private scheduleHandle: ReturnType<typeof setTimeout> | null = null
  private progressRafHandle: number | null = null

  // Last progress fraction actually emitted — used to skip redundant Signal
  // updates (60 Hz rAF was firing subscribers for sub-pixel motion).
  private lastProgressEmitted = -1

  constructor(
    _clock: MasterClock,
    private callbacks: LoopCallbacks,
    private quantizeDuration?: QuantizeDurationFn,
  ) {}

  toggle(): void {
    switch (this.state.value) {
      case 'idle':
        this.arm()
        break
      case 'armed':
        this.cancelArm()
        break
      case 'recording':
        this.finishBaseRecording()
        break
      case 'playing':
        this.startOverdub()
        break
      case 'overdubbing':
        this.commitOverdub()
        break
    }
  }

  clear(): void {
    this.stopSchedulers()
    this.releaseAllSounding()
    this.layers = []
    this.pendingOverdub = []
    this.recordBuffer = []
    this.loopDuration = 0
    this.layerCursors = []
    this.soundingByLayer = []
    this.layerCount.set(0)
    this.progress.set(0)
    this.lastProgressEmitted = -1
    this.state.set('idle')
  }

  undo(): void {
    if (this.state.value === 'overdubbing') {
      this.pendingOverdub = []
      this.state.set('playing')
      return
    }
    if (this.state.value !== 'playing') return
    if (this.layers.length <= 1) {
      this.clear()
      return
    }
    this.layers.pop()
    this.layerCursors.pop()
    // Fire note-offs for whatever the popped layer was still sounding — its
    // natural note-offs are gone with the layer, so without this the audio
    // and ghost visuals would stick until the user clears manually.
    const popped = this.soundingByLayer.pop()
    if (popped) {
      const now = Tone.getContext().currentTime
      for (const pitch of popped) this.callbacks.onPlaybackNoteOff(pitch, now)
    }
    this.layerCount.set(this.layers.length)
  }

  captureNoteOn(pitch: number, velocity: number, clockTime: number): void {
    if (this.state.value === 'armed') {
      this.recordStartCtxTime = Tone.getContext().currentTime
      this.state.set('recording')
    }
    if (this.state.value === 'recording') {
      this.recordBuffer.push({
        type: 'on',
        pitch,
        velocity,
        time: Math.max(0, Tone.getContext().currentTime - this.recordStartCtxTime),
      })
      return
    }
    if (this.state.value === 'overdubbing') {
      this.pendingOverdub.push({
        type: 'on',
        pitch,
        velocity,
        time: this.cyclePosNow(),
      })
    }
    // `clockTime` is unused in the capture path now — ctx time is derived here
    // for consistency with the scheduler. Parameter kept for call-site parity.
    void clockTime
  }

  captureNoteOff(pitch: number, clockTime: number): void {
    if (this.state.value === 'recording') {
      this.recordBuffer.push({
        type: 'off',
        pitch,
        velocity: 0,
        time: Math.max(0, Tone.getContext().currentTime - this.recordStartCtxTime),
      })
      return
    }
    if (this.state.value === 'overdubbing') {
      this.pendingOverdub.push({
        type: 'off',
        pitch,
        velocity: 0,
        time: this.cyclePosNow(),
      })
    }
    void clockTime
  }

  dispose(): void {
    this.stopSchedulers()
  }

  snapshot(): { events: LoopEvent[]; duration: number } {
    const merged = this.layers
      .flat()
      .slice()
      .sort((a, b) => a.time - b.time)
    return { events: merged, duration: this.loopDuration }
  }

  // ── transitions ────────────────────────────────────────────────────────

  private arm(): void {
    this.recordBuffer = []
    this.state.set('armed')
  }

  private cancelArm(): void {
    this.state.set('idle')
  }

  private finishBaseRecording(): void {
    if (this.recordBuffer.length === 0) {
      this.state.set('idle')
      return
    }
    // Loop length = "time between first note and tap-Stop", so any trailing
    // silence the user left (e.g. a chord ringing out) is preserved. Using
    // `last.time` instead would clip the tail and make the loop retrigger
    // immediately on note-off.
    const raw = Math.max(0.1, Tone.getContext().currentTime - this.recordStartCtxTime)
    this.loopDuration = this.quantizeDuration ? Math.max(0.1, this.quantizeDuration(raw)) : raw
    this.closeOrphans(this.recordBuffer, this.loopDuration)
    this.layers = [this.recordBuffer]
    this.recordBuffer = []
    this.layerCursors = [{ cycle: 0, idx: 0 }]
    this.soundingByLayer = [new Set()]
    this.loopStartCtxTime = Tone.getContext().currentTime
    this.layerCount.set(1)
    this.state.set('playing')
    this.startSchedulers()
  }

  private startOverdub(): void {
    this.pendingOverdub = []
    this.state.set('overdubbing')
  }

  private commitOverdub(): void {
    if (this.pendingOverdub.length === 0) {
      this.state.set('playing')
      return
    }
    this.closeOrphans(this.pendingOverdub, this.loopDuration)
    this.layers.push(this.pendingOverdub)
    this.pendingOverdub = []

    // Start the new layer's playback cursor at the current cycle/position so
    // future events from it fire from here forward (anything earlier in this
    // cycle is skipped — users know overdub captures "from here on").
    const pos = this.cyclePosNow()
    const cycle = this.cycleIndexNow()
    const cursor = { cycle, idx: this.firstIndexAtOrAfter(this.layers.at(-1)!, pos) }
    this.layerCursors.push(cursor)
    this.soundingByLayer.push(new Set())

    this.layerCount.set(this.layers.length)
    this.state.set('playing')
  }

  private closeOrphans(events: LoopEvent[], closeAt: number): void {
    const open = new Map<number, number>()
    for (const e of events) {
      if (e.type === 'on') open.set(e.pitch, (open.get(e.pitch) ?? 0) + 1)
      else open.set(e.pitch, Math.max(0, (open.get(e.pitch) ?? 0) - 1))
    }
    for (const [pitch, count] of open) {
      for (let i = 0; i < count; i++) {
        events.push({ type: 'off', pitch, velocity: 0, time: closeAt })
      }
    }
    events.sort((a, b) => a.time - b.time)
  }

  private cyclePosNow(): number {
    if (this.loopDuration <= 0) return 0
    const elapsed = Tone.getContext().currentTime - this.loopStartCtxTime
    const mod = elapsed - Math.floor(elapsed / this.loopDuration) * this.loopDuration
    return Math.max(0, Math.min(this.loopDuration, mod))
  }

  private cycleIndexNow(): number {
    if (this.loopDuration <= 0) return 0
    return Math.floor((Tone.getContext().currentTime - this.loopStartCtxTime) / this.loopDuration)
  }

  private firstIndexAtOrAfter(events: LoopEvent[], time: number): number {
    for (let i = 0; i < events.length; i++) {
      if (events[i]!.time >= time) return i
    }
    return events.length
  }

  // ── scheduler (audio) ──────────────────────────────────────────────────

  private startSchedulers(): void {
    this.stopSchedulers()
    this.lastProgressEmitted = -1
    this.schedulePoll()
    this.tickProgress()
  }

  private stopSchedulers(): void {
    if (this.scheduleHandle !== null) clearTimeout(this.scheduleHandle)
    this.scheduleHandle = null
    if (this.progressRafHandle !== null) cancelAnimationFrame(this.progressRafHandle)
    this.progressRafHandle = null
  }

  private schedulePoll = (): void => {
    if (this.state.value !== 'playing' && this.state.value !== 'overdubbing') return

    const ctx = Tone.getContext()
    const horizon = ctx.currentTime + LOOKAHEAD_SEC

    for (let li = 0; li < this.layers.length; li++) {
      const events = this.layers[li]!
      const cursor = this.layerCursors[li]!
      if (events.length === 0) continue

      // Scan forward, wrapping cycle when we exhaust the layer.
      while (true) {
        if (cursor.idx >= events.length) {
          cursor.cycle += 1
          cursor.idx = 0
        }
        const evt = events[cursor.idx]!
        const when = this.loopStartCtxTime + cursor.cycle * this.loopDuration + evt.time
        if (when >= horizon) break
        // If the scheduled time is in the past (shouldn't normally happen, but
        // can on extreme tab stalls), Tone clamps to `now`. Accept.
        this.dispatch(evt, when, li)
        cursor.idx += 1
      }
    }

    this.scheduleHandle = setTimeout(this.schedulePoll, POLL_INTERVAL_MS)
  }

  private dispatch(evt: LoopEvent, ctxTime: number, layerIdx: number): void {
    if (evt.type === 'on') {
      this.callbacks.onPlaybackNoteOn(evt.pitch, evt.velocity, ctxTime)
      this.soundingByLayer[layerIdx]?.add(evt.pitch)
    } else {
      this.callbacks.onPlaybackNoteOff(evt.pitch, ctxTime)
      this.soundingByLayer[layerIdx]?.delete(evt.pitch)
    }
  }

  // Emit note-offs for every pitch any layer has currently sounding. Used on
  // clear — without it, layers being torn down mid-note would leave both
  // audio and visuals stuck until the user triggered the pitch again.
  private releaseAllSounding(): void {
    const now = Tone.getContext().currentTime
    for (const set of this.soundingByLayer) {
      for (const pitch of set) this.callbacks.onPlaybackNoteOff(pitch, now)
      set.clear()
    }
  }

  // ── progress (visual) ──────────────────────────────────────────────────

  private tickProgress = (): void => {
    if (this.state.value !== 'playing' && this.state.value !== 'overdubbing') return
    const pos = this.cyclePosNow()
    const frac = pos / this.loopDuration
    // Emit only when the visible progress actually moved enough to matter —
    // 60 Hz rAF writes at 0.6°/frame on a 10s loop are imperceptible.
    if (Math.abs(frac - this.lastProgressEmitted) >= 0.01) {
      this.progress.set(frac)
      this.lastProgressEmitted = frac
    }
    this.progressRafHandle = requestAnimationFrame(this.tickProgress)
  }
}
