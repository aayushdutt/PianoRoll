import type { AppServices } from '../../core/services'
import type { LearnOverlay } from '../overlays/LearnOverlay'
import type { ExerciseDescriptor } from './Exercise'
import type { LearnState } from './LearnState'
import type { LearnProgressStore } from './progress'

// Scoped services passed to every exercise. Anything an exercise might need
// comes through here — there should never be a reason to import `appState`
// or any module-level singleton from inside an exercise folder.
//
// Layering: `services` are cross-cutting (clock/synth/renderer/input).
// `learnState`, `progress`, and `overlay` are Learn-mode-owned and live on
// the context itself so the controller can wire them without bloating the
// global AppServices bag.
//
// `log` and `storage` are scoped to the current exercise id so an exercise
// can't accidentally read/write another's data. The runner builds the
// scoped wrappers when it instantiates the exercise.
export interface ExerciseContext {
  descriptor: ExerciseDescriptor
  services: AppServices
  // Learn's own store for loaded MIDI + transport. Exercises read `loadedMidi`
  // and drive `currentTime` / status through this, never through `services.store`.
  learnState: LearnState
  progress: LearnProgressStore
  // Shared cinematic render layer. Exercises imperatively drive
  // `pulseTargetZone`, `drawLoopBand`, etc. — the overlay is created and
  // mounted once by `LearnController` so every exercise gets the same feel.
  overlay: LearnOverlay
  // Host element the exercise mounts into. Same element the hub was using
  // before the exercise took over — the runner clears it before handing off.
  host: HTMLElement
  // Close the exercise and return to the hub. Replaces the legacy
  // `learn:close-exercise` CustomEvent: exercises invoke this directly
  // instead of dispatching a stringly-typed DOM event.
  onClose: (reason: 'completed' | 'abandoned') => void
  log: ExerciseLog
  storage: ExerciseStorage
}

// Per-exercise narrow surface on top of the analytics + progress modules.
// Exercises stay untethered from the typed registry so future renames don't
// ripple into every exercise module.
export interface ExerciseLog {
  hit(pitch: number): void
  miss(pitch: number, expected?: number): void
  event(name: string, data?: Record<string, unknown>): void
}

// Per-exercise persistence, scoped under `midee.learn.ex.<id>.<key>` so
// settings don't collide across exercises. For one-off values — larger
// structured state should live on LearnProgressStore.
export interface ExerciseStorage {
  get<T>(key: string, fallback: T): T
  set<T>(key: string, value: T): void
}
