import type { MasterClock } from '../core/clock/MasterClock'
import { Signal } from '../store/state'
import type { CapturedEvent } from './MidiEncoding'

// Captures every live note played during a session, independently of the
// looper. Unlike LoopEngine this recorder never plays back — it just hoards
// events until the user stops, then hands them over for MIDI encoding.
export class SessionRecorder {
  readonly recording = new Signal<boolean>(false)
  readonly elapsed = new Signal<number>(0)

  private events: CapturedEvent[] = []
  private startClockTime = 0
  private rafHandle: number | null = null

  constructor(private clock: MasterClock) {}

  start(): void {
    if (this.recording.value) return
    this.events = []
    this.startClockTime = this.clock.currentTime
    this.elapsed.set(0)
    this.recording.set(true)
    this.tick()
  }

  stop(): { events: CapturedEvent[]; duration: number } {
    if (!this.recording.value) return { events: [], duration: 0 }
    this.recording.set(false)
    if (this.rafHandle !== null) cancelAnimationFrame(this.rafHandle)
    this.rafHandle = null
    const duration = this.clock.currentTime - this.startClockTime
    return { events: this.events, duration: Math.max(0, duration) }
  }

  cancel(): void {
    if (this.rafHandle !== null) cancelAnimationFrame(this.rafHandle)
    this.rafHandle = null
    this.recording.set(false)
    this.events = []
    this.elapsed.set(0)
  }

  captureNoteOn(pitch: number, velocity: number, clockTime: number): void {
    if (!this.recording.value) return
    this.events.push({
      type: 'on',
      pitch,
      velocity,
      time: Math.max(0, clockTime - this.startClockTime),
    })
  }

  captureNoteOff(pitch: number, clockTime: number): void {
    if (!this.recording.value) return
    this.events.push({
      type: 'off',
      pitch,
      velocity: 0,
      time: Math.max(0, clockTime - this.startClockTime),
    })
  }

  get hasAny(): boolean {
    return this.events.length > 0
  }

  dispose(): void {
    if (this.rafHandle !== null) cancelAnimationFrame(this.rafHandle)
    this.rafHandle = null
  }

  private tick = (): void => {
    if (!this.recording.value) return
    this.elapsed.set(this.clock.currentTime - this.startClockTime)
    this.rafHandle = requestAnimationFrame(this.tick)
  }
}
