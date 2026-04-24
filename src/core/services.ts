import type { Metronome } from '../audio/Metronome'
import type { SynthEngine } from '../audio/SynthEngine'
import type { PianoRollRenderer } from '../renderer/PianoRollRenderer'
import type { AppStore } from '../store/state'
import type { MasterClock } from './clock/MasterClock'
import type { InputBus } from './input/InputBus'

// Bundle of genuinely cross-cutting services passed to every mode controller.
// No mode-specific state belongs here — Learn-only primitives (LearnState,
// LearnProgressStore, LearnOverlay) live inside the Learn controller and reach
// exercises via `ExerciseContext`, not via this bag.
export interface AppServices {
  store: AppStore
  clock: MasterClock
  synth: SynthEngine
  metronome: Metronome
  renderer: PianoRollRenderer
  input: InputBus
}
