import type { ExerciseStats, LearnProgressV1, PitchStats } from './progress-schema'
import type { ExerciseResult, WeakSpot } from './Result'

// Pure state-transition helpers. Each function takes the previous state and
// returns the next state — nothing mutates the input, nothing reaches for
// localStorage. The reducer-style split keeps streak/XP/heatmap logic fully
// unit-testable without spinning up a DOM or a store.

// Local-date key in yyyy-mm-dd. Always the user's local day — UTC would put
// night-owl sessions on the wrong side of midnight and shatter streaks.
export function isoDay(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// Returns yyyy-mm-dd for the day *before* the given iso-day. Works by
// anchoring to noon to dodge DST one-hour shifts that would otherwise push
// the result forward or backward a day on transition dates.
function prevIsoDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number)
  if (!y || !m || !d) return ''
  const ref = new Date(y, m - 1, d, 12, 0, 0)
  ref.setDate(ref.getDate() - 1)
  return isoDay(ref)
}

// Bumps the streak if the user practiced today for the first time. Same-day
// replays are no-ops. Yesterday → today increments. Any other gap resets to 1.
export function applyStreak(
  prev: LearnProgressV1['streak'],
  today: string,
): { next: LearnProgressV1['streak']; extended: boolean } {
  if (!today) return { next: prev, extended: false }
  if (prev.lastDay === today) return { next: prev, extended: false }
  const isYesterday = prev.lastDay !== '' && prevIsoDay(today) === prev.lastDay
  const days = isYesterday ? prev.days + 1 : 1
  return { next: { days, lastDay: today }, extended: true }
}

export function applyXp(prev: LearnProgressV1['xp'], delta: number): LearnProgressV1['xp'] {
  const clamped = Math.max(0, Math.round(delta))
  return { total: prev.total + clamped }
}

// Folds per-pitch misses into the heatmap. Hits aren't attributed per-pitch
// yet (Phase 1 exercises only emit aggregate hit counts); the River port in
// Phase 2 will thread per-pitch hits into the same path.
export function applyHeatmap(
  prev: LearnProgressV1['heatmap'],
  weakSpots: readonly WeakSpot[],
  today: string,
): LearnProgressV1['heatmap'] {
  if (weakSpots.length === 0) return prev
  const next: Record<number, PitchStats> = { ...prev.perPitch }
  for (const spot of weakSpots) {
    const cur = next[spot.pitch] ?? { hits: 0, misses: 0, lastSeen: today }
    next[spot.pitch] = {
      hits: cur.hits,
      misses: cur.misses + spot.count,
      lastSeen: today,
    }
  }
  return { perPitch: next }
}

export function applyExerciseCompletion(
  prev: Record<string, ExerciseStats>,
  result: ExerciseResult,
  today: string,
): Record<string, ExerciseStats> {
  const cur = prev[result.exerciseId]
  const merged: ExerciseStats = {
    completions: (cur?.completions ?? 0) + (result.completed ? 1 : 0),
    bestAccuracy: Math.max(cur?.bestAccuracy ?? 0, result.accuracy),
    totalTime_s: (cur?.totalTime_s ?? 0) + Math.max(0, result.duration_s),
    lastCompleted: today,
  }
  return { ...prev, [result.exerciseId]: merged }
}

// Commit a full ExerciseResult into the progress schema. Returns the next
// state plus a flag per sub-change so the store layer can fire typed
// analytics (streak_extended, etc) without re-deriving what changed.
export interface CommitOutcome {
  next: LearnProgressV1
  streakExtended: boolean
  xpGained: number
}

export function commitResult(
  prev: LearnProgressV1,
  result: ExerciseResult,
  today: string,
): CommitOutcome {
  const streakUpdate = applyStreak(prev.streak, today)
  const xpNext = applyXp(prev.xp, result.xp)
  const heatmapNext = applyHeatmap(prev.heatmap, result.weakSpots, today)
  const exercisesNext = applyExerciseCompletion(prev.exercises, result, today)
  return {
    next: {
      ...prev,
      streak: streakUpdate.next,
      xp: xpNext,
      heatmap: heatmapNext,
      exercises: exercisesNext,
    },
    streakExtended: streakUpdate.extended,
    xpGained: Math.max(0, Math.round(result.xp)),
  }
}
