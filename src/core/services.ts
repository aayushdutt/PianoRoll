import type { Metronome } from '../audio/Metronome'
import type { SynthEngine } from '../audio/SynthEngine'
import type { VisualizationSurface } from '../renderer/VisualizationSurface'
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
  // Typed against the instrument-agnostic contract (see
  // `renderer/VisualizationSurface.ts`), not the concrete `PianoRollRenderer`
  // — the only implementation today, but call sites here shouldn't need to
  // widen back to it. `app.ts` still owns and constructs the concrete
  // `PianoRollRenderer` instance; this is only the seam other services see.
  renderer: VisualizationSurface
  input: InputBus
}
