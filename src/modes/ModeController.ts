import type { AppServices } from '../core/services'
import type { ComputerKeyboardInput } from '../midi/ComputerKeyboardInput'
import type { MidiInputManager } from '../midi/MidiInputManager'
import type { AppMode } from '../store/state'
import type { DropZone } from '../ui/DropZone'
import type { TrackPanel } from '../ui/TrackPanel'

// Every mode receives the same context bag. Controllers pull what they need and
// ignore the rest — keeps the wiring in App.init declarative and centralises
// cross-cutting deps so a new mode can't quietly reach into App internals.
//
// Callbacks here are App-level operations the controllers may need to trigger
// (reset transient state, open the file picker, prime audio on user gesture).
// We pass them in instead of importing App to keep a one-way dependency graph.
export interface ModeContext {
  services: AppServices
  // Root container for mode-owned UI — LearnController and future modes mount
  // their own chrome here. Home/Play/Live don't need it today (their UI lives
  // inside Controls), but they could use it if they ever grow overlays.
  overlay: HTMLElement
  trackPanel: TrackPanel
  dropzone: DropZone
  keyboardInput: ComputerKeyboardInput
  midiInput: MidiInputManager
  resetInteractionState: () => void
  openFilePicker: () => void
  primeInteractiveAudio: () => void
}

// Opt-in bag passed to `enter`. Controllers pick the fields they understand
// and ignore the rest — no discriminator so callers don't have to re-state
// the mode they just named in `setMode(mode, opts)`.
export interface EnterOptions {
  // Live mode: whether to nudge the AudioContext awake on entry. True when
  // user intent is explicit (clicking the Live tab); false when the mode
  // dissolves in from e.g. a first-keypress or an error recovery path and
  // audio priming should stay tied to the actual user gesture.
  primeAudio?: boolean
}

export interface ModeController {
  readonly id: AppMode
  // Whether this mode's user presses should feed the live-performance
  // capture pipeline (looper + session recorder + burst particles). Learn
  // sets this to `false` so practice presses don't pollute a saved session
  // or overdub onto a live loop. Replaces scattered `mode === 'learn'`
  // branches in App.
  readonly capturesLivePerformance: boolean
  // Called when the mode becomes active. No-ops are fine — e.g. re-entering
  // play-mode while a MIDI is already loaded. Controllers should be
  // idempotent on repeated entry with the same context.
  enter(opts?: EnterOptions): void
  // Called when another mode is about to take over. Default no-op; override
  // to release per-mode resources (subscriptions, overlays, timers).
  exit?(): void
}
