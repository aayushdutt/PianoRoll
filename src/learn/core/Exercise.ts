import type { BusNoteEvent } from '../../core/input/InputBus'
import type { ExerciseContext } from './ExerciseContext'
import type { ExerciseResult } from './Result'

// Classification surface exposed on the hub catalog. Every exercise declares
// which bucket it fits in and how hard it is so the hub can group, filter,
// and recommend without reaching into exercise internals.
export type ExerciseCategory =
  | 'play-along'
  | 'sight-reading'
  | 'ear-training'
  | 'theory'
  | 'technique'
  | 'reflection'

export type ExerciseDifficulty = 'beginner' | 'intermediate' | 'advanced'

// Everything the hub needs to render a catalog card and instantiate an
// exercise when the user taps it. Keep descriptors lightweight — heavy deps
// (OSMD, soundfonts) load lazily inside the factory / via `preload`.
export interface ExerciseDescriptor {
  id: string
  title: string
  category: ExerciseCategory
  difficulty: ExerciseDifficulty
  blurb: string
  // Instantiates a fresh exercise. Called once per launch; the runner
  // unmounts + discards the instance on exit.
  factory: (ctx: ExerciseContext) => Exercise
  // Optional dynamic-import hook run before `factory` when an exercise has
  // a large dep (OSMD, large soundfont). No-op for most exercises.
  preload?: () => Promise<void>
}

// The exercise-side contract. The runner mounts into a host element, starts
// the clock, feeds input events, and collects a result on exit. Every
// exercise implements this — nothing else.
export interface Exercise {
  readonly descriptor: ExerciseDescriptor

  // Attach DOM / PixiJS layers. Called before `start`. Can be async to
  // accommodate PixiJS Graphics that need a frame to settle, but most
  // exercises stay sync.
  mount(host: HTMLElement): void | Promise<void>

  // Begin accepting input + ticking logic. Called after `mount`.
  start(): void

  // Stop accepting input. Runner calls this before `unmount`; exercises
  // should ensure `result()` is valid immediately after.
  stop(): void

  // Tear down. Remove any render layers registered via ctx, detach DOM,
  // release timers. The runner won't clean up for you.
  unmount(): void

  // Hooks — all optional. The runner forwards InputBus and clock ticks
  // while the exercise is active; exercises opt in by implementing.
  onNoteOn?(evt: BusNoteEvent): void
  onNoteOff?(evt: BusNoteEvent): void
  onTick?(time: number): void

  // Final result. Called by the runner after `stop`. Return `null` if the
  // session produced nothing meaningful (e.g. user bailed in under a second).
  result(): ExerciseResult | null
}
