import type { MasterClock } from '../core/clock/MasterClock'
import { Signal } from '../store/state'

export interface MidiNoteEvent {
  pitch: number
  velocity: number // 0–1, normalised from MIDI 0–127
  clockTime: number // MasterClock.currentTime at the moment of the event
}

export type MidiDeviceStatus = 'unavailable' | 'disconnected' | 'connected' | 'blocked'

// Manages Web MIDI access, device hot-plug, and raw message parsing.
// Emits noteOn / noteOff signals synchronously on each incoming message.
export class MidiInputManager {
  readonly status = new Signal<MidiDeviceStatus>(
    typeof navigator !== 'undefined' && typeof navigator.requestMIDIAccess === 'function'
      ? 'disconnected'
      : 'unavailable',
  )
  readonly deviceName = new Signal<string>('')

  // Fires on every note-on / note-off — subscribers are called synchronously.
  // Using Signal means subscribers always see the latest event; since JS is
  // single-threaded, rapid-fire events are processed sequentially.
  readonly noteOn = new Signal<MidiNoteEvent | null>(null)
  readonly noteOff = new Signal<MidiNoteEvent | null>(null)

  // Sustain pedal (CC64) — true when the damper is engaged. Per the MIDI
  // spec, controller value <64 = off, >=64 = on. Subscribers decide how to
  // apply it (typically: delay note-off audio release until pedal-up).
  readonly pedal = new Signal<boolean>(false)

  private access: MIDIAccess | null = null

  constructor(private readonly clock: MasterClock) {}

  async requestAccess(opts?: { silent?: boolean }): Promise<boolean> {
    if (this.status.value === 'unavailable') return false

    try {
      this.access = await navigator.requestMIDIAccess({ sysex: false })
      this.access.onstatechange = () => this.rebindInputs()
      this.rebindInputs()
      return true
    } catch (err) {
      if (!opts?.silent) {
        console.warn('[MidiInputManager] Access denied:', err)
      }
      this.status.set('blocked')
      this.deviceName.set('')
      return false
    }
  }

  // Re-scan all inputs after a state change (hot-plug / unplug).
  private rebindInputs(): void {
    if (!this.access) return

    let anyConnected = false
    const names: string[] = []

    for (const input of this.access.inputs.values()) {
      // Always overwrite — ensures we don't accumulate duplicate handlers
      input.onmidimessage = (e) => this.handleMessage(e)
      if (input.state === 'connected') {
        anyConnected = true
        if (input.name) names.push(input.name)
      }
    }

    this.status.set(anyConnected ? 'connected' : 'disconnected')
    this.deviceName.set(names.join(', '))

    // No device means no pedal source — clear any stuck state so subscribers
    // can release sustained notes instead of leaving them ringing forever.
    if (!anyConnected && this.pedal.value) this.pedal.set(false)
  }

  private handleMessage(e: MIDIMessageEvent): void {
    const data = e.data
    if (!data || data.length < 2) return

    const status = data[0]! & 0xf0 // strip channel nibble
    const pitch = data[1]!
    const rawVel = data[2] ?? 0
    const velocity = rawVel / 127

    // `e.timeStamp` is a DOMHighResTimeStamp on the same clock as
    // `performance.now()` and reflects when the hardware event was dispatched,
    // not when our callback runs. Subtracting gives a negative delta (the event
    // is always in the past by the time we see it); applying it shifts the
    // visual hit-point back to the real key press.
    let clockTime = this.clock.currentTime
    if (typeof performance !== 'undefined' && Number.isFinite(e.timeStamp)) {
      const deltaSeconds = (e.timeStamp - performance.now()) / 1000
      clockTime = Math.max(0, clockTime + deltaSeconds * this.clock.speed)
    }

    if (status === 0x90 && rawVel > 0) {
      // Note-on
      this.noteOn.set({ pitch, velocity, clockTime })
    } else if (status === 0x80 || (status === 0x90 && rawVel === 0)) {
      // Note-off (also handles velocity-0 note-on, common in hardware)
      this.noteOff.set({ pitch, velocity: 0, clockTime })
    } else if (status === 0xb0 && pitch === 64) {
      // CC64 — sustain pedal. `pitch` here is actually the controller number.
      // Dedupe same-state emissions (hardware often streams redundant 127s).
      const down = rawVel >= 64
      if (down !== this.pedal.value) this.pedal.set(down)
    }
    // Ignore other CC, pitch-bend, aftertouch, etc. for now
  }

  dispose(): void {
    if (!this.access) return
    for (const input of this.access.inputs.values()) {
      input.onmidimessage = null
    }
    this.access.onstatechange = null
    this.access = null
    this.status.set('disconnected')
    this.deviceName.set('')
    if (this.pedal.value) this.pedal.set(false)
  }
}
