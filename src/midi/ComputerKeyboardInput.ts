import type { MasterClock } from '../core/clock/MasterClock'
import { createEventSignal } from '../store/eventSignal'
import type { MidiNoteEvent } from './MidiInputManager'

// FL Studio / DAW-style typing-keyboard layout.
// Two octaves: the bottom row (Z..) plus its black keys on the S..row;
// the top row (Q..) plus its black keys on the number row.
const DEFAULT_OCTAVE = 4
const NOTE_MAP: Record<string, number> = {
  // Lower octave — starts at C of current octave
  KeyZ: 0,
  KeyS: 1,
  KeyX: 2,
  KeyD: 3,
  KeyC: 4,
  KeyV: 5,
  KeyG: 6,
  KeyB: 7,
  KeyH: 8,
  KeyN: 9,
  KeyJ: 10,
  KeyM: 11,
  Comma: 12,
  KeyL: 13,
  Period: 14,
  Semicolon: 15,
  Slash: 16,
  // Upper octave — starts one octave higher
  KeyQ: 12,
  Digit2: 13,
  KeyW: 14,
  Digit3: 15,
  KeyE: 16,
  KeyR: 17,
  Digit5: 18,
  KeyT: 19,
  Digit6: 20,
  KeyY: 21,
  Digit7: 22,
  KeyU: 23,
  KeyI: 24,
  Digit9: 25,
  KeyO: 26,
  Digit0: 27,
  KeyP: 28,
}

const DEFAULT_VELOCITY = 0.75

// Reads the browser keydown/keyup stream and translates it into synthetic
// MIDI note events. Only active while live mode is enabled.
export class ComputerKeyboardInput {
  readonly noteOn = createEventSignal<MidiNoteEvent | null>(null)
  readonly noteOff = createEventSignal<MidiNoteEvent | null>(null)
  readonly octave = createEventSignal<number>(DEFAULT_OCTAVE)
  // Software sustain pedal — currently UNBOUND, see below. Kept as a signal so
  // the App wiring (and the MIDI-device pedal merged with it in
  // LivePerformanceBus) is untouched: players with hardware pedals are
  // unaffected by this.
  //
  // Space used to be the damper, but Space is now the transport key in every
  // mode. The obvious replacement, Shift, cannot work: every command letter in
  // live mode (R L U C M P) is ALSO a note key, which is exactly why commands
  // live behind Shift — so Shift is structurally the command modifier and
  // cannot simultaneously be a pedal you hold while playing. Cmd/Ctrl/Alt are
  // owned by the browser un-preventably (Cmd+W, Ctrl+R). Parked until usage
  // data says whether the Shift command layer is worth keeping; if it is not,
  // Shift becomes the pedal, and if it is, the pedal moves to right-Shift with
  // the command layer on left-Shift.
  readonly pedal = createEventSignal<boolean>(false)

  private active = false
  private held = new Map<string, number>() // code → pitch (for correct release after octave change)
  private pedalHeld = false

  constructor(private readonly clock: MasterClock) {}

  enable(): void {
    if (this.active) return
    this.active = true
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
  }

  disable(): void {
    if (!this.active) return
    this.active = false
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
    this.releaseAllHeld()
    if (this.pedalHeld) {
      this.pedalHeld = false
      this.pedal.set(false)
    }
  }

  shiftOctaveUp(): void {
    const next = Math.min(this.octave.value + 1, 7)
    if (next !== this.octave.value) this.octave.set(next)
  }

  shiftOctaveDown(): void {
    const next = Math.max(this.octave.value - 1, 0)
    if (next !== this.octave.value) this.octave.set(next)
  }

  private releaseAllHeld(): void {
    const t = this.clock.currentTime
    for (const [, pitch] of this.held) {
      this.noteOff.set({ pitch, velocity: 0, clockTime: t })
    }
    this.held.clear()
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (this.shouldIgnore(e)) return

    if (e.code === 'ArrowDown') {
      e.preventDefault()
      this.shiftOctaveDown()
      return
    }
    if (e.code === 'ArrowUp') {
      e.preventDefault()
      this.shiftOctaveUp()
      return
    }

    const offset = NOTE_MAP[e.code]
    if (offset === undefined) return

    e.preventDefault()
    if (e.repeat) return
    if (this.held.has(e.code)) return

    const pitch = 12 * (this.octave.value + 1) + offset
    if (pitch < 21 || pitch > 108) return

    this.held.set(e.code, pitch)
    this.noteOn.set({ pitch, velocity: DEFAULT_VELOCITY, clockTime: this.clock.currentTime })
  }

  private onKeyUp = (e: KeyboardEvent): void => {
    const pitch = this.held.get(e.code)
    if (pitch === undefined) return
    this.held.delete(e.code)
    this.noteOff.set({ pitch, velocity: 0, clockTime: this.clock.currentTime })
  }

  private shouldIgnore(e: KeyboardEvent): boolean {
    // Shift reserves letter keys for app-level hotkeys (Shift+R record,
    // Shift+L loop, etc.); without this guard the user would also trigger a
    // note via the FL-style key map whenever they hit a shortcut.
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return true
    const target = e.target as HTMLElement | null
    if (!target) return false
    const tag = target.tagName
    return tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable
  }

  dispose(): void {
    this.disable()
  }
}
