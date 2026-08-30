import { beforeEach, describe, expect, it } from 'vitest'
import { ComputerKeyboardInput } from './ComputerKeyboardInput'

// Minimal clock stand-in — the input only reads `currentTime` for timestamps.
const clock = { currentTime: 0 } as unknown as ConstructorParameters<
  typeof ComputerKeyboardInput
>[0]

// A browser sets shiftKey === true on the Shift key's OWN keydown, so model
// that: an earlier version of these tests omitted it and passed against code
// where the shift-guard swallowed the pedal it was meant to allow.
function press(code: string, init: KeyboardEventInit = {}): void {
  const shiftKey = code === 'ShiftLeft' || code === 'ShiftRight'
  window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true, shiftKey, ...init }))
}

function release(code: string): void {
  window.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true }))
}

describe('ComputerKeyboardInput', () => {
  let input: ComputerKeyboardInput

  beforeEach(() => {
    input = new ComputerKeyboardInput(clock)
    input.enable()
  })

  it('plays a note from the FL-style map', () => {
    press('KeyZ')
    expect(input.noteOn.value?.pitch).toBe(60) // C4 at the default octave
  })

  describe('software sustain pedal (currently unbound)', () => {
    // Space was the damper until Space became the transport key everywhere.
    // Shift cannot take over: every live command letter (R L U C M P) is also a
    // note key, which is why commands sit behind Shift in the first place.
    // Parked rather than rebound — hardware MIDI pedals are a separate source
    // and keep working.
    it('is not engaged by Shift', () => {
      press('ShiftLeft')
      expect(input.pedal.value).toBe(false)
      press('ShiftRight')
      expect(input.pedal.value).toBe(false)
    })

    it('is not engaged by Space', () => {
      press('Space')
      expect(input.pedal.value).toBe(false)
      release('Space')
      expect(input.pedal.value).toBe(false)
    })
  })

  describe('the Shift guard that reserves letters for app hotkeys', () => {
    it('suppresses notes while Shift is held', () => {
      // Shift+C must run "clear loop", not sound a C — the command letters are
      // all note keys, so the guard is what keeps the two apart.
      press('KeyC', { shiftKey: true })
      expect(input.noteOn.value).toBeNull()
    })

    it('still plays that key unmodified', () => {
      press('KeyC')
      expect(input.noteOn.value?.pitch).toBe(64)
    })
  })
})
