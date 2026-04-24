// Per-trial failure datum fed into the heatmap and weakness-drill planner.
// `count` bundles repeated misses on the same pitch so exercises can summarise
// "this pitch failed 4 times" without hoisting the same entry 4 times.
export interface WeakSpot {
  // The MIDI pitch (0..127) that the user failed to produce correctly.
  pitch: number
  // Optional — the pitch the user pressed instead, when known. Sight-reading
  // tells us this; wait-mode play-along usually doesn't.
  expected?: number
  count: number
}

// Payload committed to progress when an exercise ends. Every exercise
// returns this shape from `Exercise.result()`; the runner passes it to
// `LearnProgressStore.commit` before unmounting.
export interface ExerciseResult {
  exerciseId: string
  // Clock-time spent inside the exercise, in seconds. Used for practice-log
  // aggregation and for XP weighting.
  duration_s: number
  // 0..1. 1 = every trial correct on the first try.
  accuracy: number
  // Pre-computed XP for the session. The runner doesn't second-guess this so
  // different exercises can weight difficulty / accuracy / duration however
  // they choose. Kept non-negative.
  xp: number
  // Per-pitch failures for heatmap updates. Empty array is fine.
  weakSpots: WeakSpot[]
  // `true` = user played through cleanly. `false` = bailed out / closed early.
  // Drives the completions counter and the exercise_completed vs abandoned
  // analytics split.
  completed: boolean
}
