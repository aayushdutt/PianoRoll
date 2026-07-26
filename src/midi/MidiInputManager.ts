import type { MasterClock } from '../core/clock/MasterClock'
import { createEventSignal } from '../store/eventSignal'

export interface MidiNoteEvent {
  pitch: number
  velocity: number // 0–1, normalised from MIDI 0–127
  clockTime: number // MasterClock.currentTime at the moment of the event
  /** Stable for the lifetime of the physical or synthetic input source. */
  sourceId?: string
  /** Zero-based MIDI channel. Synthetic inputs omit this. */
  channel?: number
  /** Stable across the matching note-on/note-off pair. */
  voiceId?: string
  /** Physical fretboard identity, when the event came from guitar input. */
  string?: number
  fret?: number
}

export type MidiDeviceStatus = 'unavailable' | 'disconnected' | 'connected' | 'blocked'

// Shift the master-clock time back to when the hardware event actually fired.
// `eventTimeStamp` is a DOMHighResTimeStamp on the same clock as
// `performance.now()` and reflects hardware dispatch, not callback execution —
// so `eventTimeStamp - nowMs` is a negative delta (the event is always in the
// past). Scaling by `speed` keeps the visual hit-point aligned when playback is
// sped up/slowed down, and clamping at 0 prevents negative clock times.
export function backdateEventTime(
  clockTime: number,
  eventTimeStamp: number,
  nowMs: number,
  speed: number,
): number {
  const deltaSeconds = (eventTimeStamp - nowMs) / 1000
  return Math.max(0, clockTime + deltaSeconds * speed)
}

// Result of decoding one raw MIDI message into a logical intent. `kind: 'none'`
// covers ignored messages (other CC, pitch-bend, aftertouch, redundant pedal).
export type ParsedMidiMessage =
  | { kind: 'noteOn'; pitch: number; velocity: number; channel: number }
  | { kind: 'noteOff'; pitch: number; channel: number }
  | { kind: 'pedal'; down: boolean; channel: number }
  | { kind: 'none' }

// Pure decode of a raw MIDI status/data triplet. Handles the velocity-0
// note-on → note-off coercion (common in hardware) and CC64 sustain-pedal
// dedupe (hardware often streams redundant 127s) against `prevPedalDown`.
// `data` is the raw MIDIMessageEvent bytes; messages shorter than 2 bytes or of
// unhandled types resolve to `{ kind: 'none' }`.
export function parseMidiMessage(
  data: Uint8Array | number[] | null | undefined,
  prevPedalDown: boolean,
): ParsedMidiMessage {
  if (!data || data.length < 2) return { kind: 'none' }

  const statusByte = data[0]!
  const status = statusByte & 0xf0
  const channel = statusByte & 0x0f
  const pitch = data[1]!
  const rawVel = data[2] ?? 0

  if (status === 0x90 && rawVel > 0) {
    return { kind: 'noteOn', pitch, velocity: rawVel / 127, channel }
  }
  if (status === 0x80 || (status === 0x90 && rawVel === 0)) {
    // Note-off (also handles velocity-0 note-on, common in hardware).
    return { kind: 'noteOff', pitch, channel }
  }
  if (status === 0xb0 && pitch === 64) {
    // CC64 — sustain pedal. `pitch` here is the controller number; per spec
    // value <64 = off, >=64 = on. Dedupe same-state emissions.
    const down = rawVel >= 64
    return down === prevPedalDown ? { kind: 'none' } : { kind: 'pedal', down, channel }
  }
  // Ignore other CC, pitch-bend, aftertouch, etc. for now
  return { kind: 'none' }
}

// Manages Web MIDI access, device hot-plug, and raw message parsing.
// Emits noteOn / noteOff signals synchronously on each incoming message.
export class MidiInputManager {
  readonly status = createEventSignal<MidiDeviceStatus>(
    typeof navigator !== 'undefined' && typeof navigator.requestMIDIAccess === 'function'
      ? 'disconnected'
      : 'unavailable',
  )
  readonly deviceName = createEventSignal<string>('')

  // Fires on every note-on / note-off — subscribers are called synchronously.
  // Since JS is single-threaded, rapid-fire events are processed sequentially.
  readonly noteOn = createEventSignal<MidiNoteEvent | null>(null)
  readonly noteOff = createEventSignal<MidiNoteEvent | null>(null)

  // Sustain pedal (CC64) — true when the damper is engaged. Per the MIDI
  // spec, controller value <64 = off, >=64 = on. Subscribers decide how to
  // apply it (typically: delay note-off audio release until pedal-up).
  readonly pedal = createEventSignal<boolean>(false)

  private access: MIDIAccess | null = null
  private connectedSourceIds = new Set<string>()
  private activeVoices = new Map<string, MidiNoteEvent[]>()
  private nextVoiceId = 1

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
      input.onmidimessage = (e) => this.handleMessage(e, input.id)
      if (input.state === 'connected') {
        anyConnected = true
        if (input.name) names.push(input.name)
      }
    }

    const nextSourceIds = new Set(
      Array.from(this.access.inputs.values())
        .filter((input) => input.state === 'connected')
        .map((input) => input.id),
    )
    for (const sourceId of this.connectedSourceIds) {
      if (!nextSourceIds.has(sourceId)) this.releaseSourceVoices(sourceId)
    }
    this.connectedSourceIds = nextSourceIds
    this.status.set(anyConnected ? 'connected' : 'disconnected')
    this.deviceName.set(names.join(', '))

    // No device means no pedal source — clear any stuck state so subscribers
    // can release sustained notes instead of leaving them ringing forever.
    if (!anyConnected && this.pedal.value) this.pedal.set(false)
  }

  private voiceQueueKey(sourceId: string, channel: number, pitch: number): string {
    return `${sourceId}:${channel}:${pitch}`
  }

  private releaseSourceVoices(sourceId: string): void {
    const clockTime = this.clock.currentTime
    for (const [key, queue] of this.activeVoices) {
      if (!key.startsWith(`${sourceId}:`)) continue
      for (const voice of queue) this.noteOff.set({ ...voice, velocity: 0, clockTime })
      this.activeVoices.delete(key)
    }
  }

  private releaseAllVoices(): void {
    for (const sourceId of this.connectedSourceIds) this.releaseSourceVoices(sourceId)
    this.activeVoices.clear()
  }

  private handleMessage(e: MIDIMessageEvent, sourceId: string): void {
    const msg = parseMidiMessage(e.data, this.pedal.value)
    if (msg.kind === 'none') return

    let clockTime = this.clock.currentTime
    if (typeof performance !== 'undefined' && Number.isFinite(e.timeStamp)) {
      clockTime = backdateEventTime(clockTime, e.timeStamp, performance.now(), this.clock.speed)
    }

    if (msg.kind === 'noteOn') {
      const voice: MidiNoteEvent = {
        pitch: msg.pitch,
        velocity: msg.velocity,
        clockTime,
        sourceId,
        channel: msg.channel,
        voiceId: `midi:${sourceId}:${this.nextVoiceId++}`,
      }
      const key = this.voiceQueueKey(sourceId, msg.channel, msg.pitch)
      const queue = this.activeVoices.get(key) ?? []
      queue.push(voice)
      this.activeVoices.set(key, queue)
      this.noteOn.set(voice)
    } else if (msg.kind === 'noteOff') {
      const key = this.voiceQueueKey(sourceId, msg.channel, msg.pitch)
      const queue = this.activeVoices.get(key)
      const voice = queue?.shift()
      if (queue?.length === 0) this.activeVoices.delete(key)
      this.noteOff.set({
        pitch: msg.pitch,
        velocity: 0,
        clockTime,
        sourceId,
        channel: msg.channel,
        ...(voice?.voiceId ? { voiceId: voice.voiceId } : {}),
      })
    } else {
      this.pedal.set(msg.down)
    }
  }

  dispose(): void {
    if (!this.access) return
    this.releaseAllVoices()
    for (const input of this.access.inputs.values()) {
      input.onmidimessage = null
    }
    this.access.onstatechange = null
    this.access = null
    this.connectedSourceIds.clear()
    this.status.set('disconnected')
    this.deviceName.set('')
    if (this.pedal.value) this.pedal.set(false)
  }
}
