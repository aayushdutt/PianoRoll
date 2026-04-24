import type { ExerciseDescriptor } from '../core/Exercise'
import { intervalsDescriptor } from '../exercises/intervals'
import { playAlongDescriptor } from '../exercises/play-along'

// Registry of every exercise the hub knows about. Exercises register here so
// the hub renders a card for them and the daily-drill planner can pick from
// the full set without hard-coding ids.
//
// Add a descriptor by importing it here and pushing it into `CATALOG`. The
// registration side-effect is intentional — it keeps the hub a thin view
// over this array and lets exercises live in self-contained folders.
export const CATALOG: ExerciseDescriptor[] = [playAlongDescriptor, intervalsDescriptor]

export function findExercise(id: string): ExerciseDescriptor | undefined {
  return CATALOG.find((d) => d.id === id)
}
