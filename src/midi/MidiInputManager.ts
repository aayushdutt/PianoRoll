import { Signal } from '../store/state'
import type { MasterClock } from '../core/clock/MasterClock'

export interface MidiNoteEvent {
  pitch: number
  velocity: number    // 0–1, normalised from MIDI 0–127
  clockTime: number   // MasterClock.currentTime at the moment of the event
}

export type MidiDeviceStatus = 'unavailable' | 'disconnected' | 'connected'

// Manages Web MIDI access, device hot-plug, and raw message parsing.
// Emits noteOn / noteOff signals synchronously on each incoming message.
export class MidiInputManager {
  readonly status     = new Signal<MidiDeviceStatus>(
    typeof navigator !== 'undefined' && typeof navigator.requestMIDIAccess === 'function'
      ? 'disconnected'
      : 'unavailable',
  )
  readonly deviceName = new Signal<string>('')

  // Fires on every note-on / note-off — subscribers are called synchronously.
  // Using Signal means subscribers always see the latest event; since JS is
  // single-threaded, rapid-fire events are processed sequentially.
  readonly noteOn  = new Signal<MidiNoteEvent | null>(null)
  readonly noteOff = new Signal<MidiNoteEvent | null>(null)

  private access: MIDIAccess | null = null

  constructor(private readonly clock: MasterClock) {}

  // Must be called from a user-gesture handler (button click) so the browser
  // grants MIDI permission. Also a good place to resume the AudioContext.
  async requestAccess(): Promise<void> {
    if (this.status.value === 'unavailable') return

    try {
      this.access = await navigator.requestMIDIAccess({ sysex: false })
      this.access.onstatechange = () => this.rebindInputs()
      this.rebindInputs()
    } catch (err) {
      console.warn('[MidiInputManager] Access denied:', err)
      this.status.set('disconnected')
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
  }

  private handleMessage(e: MIDIMessageEvent): void {
    const data = e.data
    if (!data || data.length < 2) return

    const status   = data[0]! & 0xf0   // strip channel nibble
    const pitch    = data[1]!
    const rawVel   = data[2] ?? 0
    const velocity = rawVel / 127
    const clockTime = this.clock.currentTime

    if (status === 0x90 && rawVel > 0) {
      // Note-on
      this.noteOn.set({ pitch, velocity, clockTime })
    } else if (status === 0x80 || (status === 0x90 && rawVel === 0)) {
      // Note-off (also handles velocity-0 note-on, common in hardware)
      this.noteOff.set({ pitch, velocity: 0, clockTime })
    }
    // Ignore CC, pitch-bend, aftertouch, etc. for now
  }

  dispose(): void {
    if (!this.access) return
    for (const input of this.access.inputs.values()) {
      input.onmidimessage = null
    }
    this.access.onstatechange = null
    this.access = null
    this.status.set('disconnected')
  }
}
