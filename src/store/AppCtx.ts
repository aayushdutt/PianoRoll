import { createContext, useContext } from 'solid-js'
import type { AppServices } from '../core/services'
import type { ComputerKeyboardInput } from '../midi/ComputerKeyboardInput'
import type { MidiInputManager } from '../midi/MidiInputManager'
import type { LearnController } from '../modes/LearnController'
import type { DropZone } from '../ui/DropZone'
import type { TrackPanel } from '../ui/TrackPanel'
import type { AppStore } from './state'

// Context value threaded via `<AppCtx.Provider value={ctx}>`. `services` and
// `store` are the long-term surface; the rest are handles Solid mode components
// need while `App` still owns imperative UI shells (Controls, TrackPanel,
// DropZone, modals, etc.) mounted outside `#solid-root`. Further collapsing
// those into Solid-only wiring is optional follow-up, not a blocked migration.
export interface AppCtxValue {
  services: AppServices
  store: AppStore
  // Transitional handles (removed progressively as each module ports):
  trackPanel: TrackPanel
  dropzone: DropZone
  keyboardInput: ComputerKeyboardInput
  midiInput: MidiInputManager
  // LearnController is dynamic-imported on first Learn entry so its module
  // graph (LearnHub, LearnState, ExerciseRunner, IntervalsEngine, etc.)
  // stays out of the initial bundle. Resolves the same instance on repeat
  // calls.
  ensureLearnController: () => Promise<LearnController>
  resetInteractionState: () => void
  openFilePicker: () => void
  primeInteractiveAudio: () => void
}

export const AppCtx = createContext<AppCtxValue>()

export function useApp(): AppCtxValue {
  const v = useContext(AppCtx)
  if (!v) throw new Error('useApp() called outside <AppCtx.Provider>')
  return v
}
