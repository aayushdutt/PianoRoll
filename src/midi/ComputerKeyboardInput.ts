import type { MasterClock } from '../core/clock/MasterClock'
import { Signal } from '../store/state'
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
  readonly noteOn = new Signal<MidiNoteEvent | null>(null)
  readonly noteOff = new Signal<MidiNoteEvent | null>(null)
  readonly octave = new Signal<number>(DEFAULT_OCTAVE)
  // Software stand-in for a sustain pedal: Space-bar hold mirrors a damper.
  // Useful for users without hardware pedals; merged with the MIDI-device
  // pedal upstream in App so either source can engage sustain.
  readonly pedal = new Signal<boolean>(false)

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

    // Spacebar = software sustain pedal (hold to engage, release to lift).
    // Placed before arrow-key handling so auto-repeat doesn't re-emit.
    if (e.code === 'Space') {
      e.preventDefault()
      if (!this.pedalHeld) {
        this.pedalHeld = true
        this.pedal.set(true)
      }
      return
    }

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
    if (e.code === 'Space' && this.pedalHeld) {
      this.pedalHeld = false
      this.pedal.set(false)
      return
    }
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
