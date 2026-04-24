// Persistence shape for the learn suite. Everything the user accumulates
// across sessions lives here — streak, XP, per-exercise stats, per-pitch
// heatmap, per-piece state, user settings — stored as a single JSON blob
// under `midee.learn.v1` so schema migrations are one file, not many keys.
//
// This file is intentionally types-only + factory. Pure helpers that mutate
// the schema live in `./progress-actions.ts`; the stateful store binding is
// in `./progress.ts`. Splitting the three lets tests exercise the action
// functions without touching localStorage.

export interface PitchStats {
  hits: number
  misses: number
  // ISO date (yyyy-mm-dd) — used by daily-drill planning to age out stale
  // weaknesses. Kept local-time so "today" means the user's today.
  lastSeen: string
}

export interface ExerciseStats {
  completions: number
  // 0..1
  bestAccuracy: number
  totalTime_s: number
  lastCompleted: string
}

export interface PieceStats {
  // Self-reported progression label. `mastered` ⇔ `masteredAt` is set.
  state: 'learning' | 'maintaining' | 'performing'
  // Highest tempo % the user has cleared the piece at.
  bestTempo: number
  bestAccuracy: number
  lastPracticed: string
  masteredAt: string | null
}

export interface LearnSettings {
  // How to color the two-hand split when playing along. Default 'pitch-split'
  // (below/above middle C) because most user-edited MIDI lacks clean track
  // separation; `tracks` is the power-user opt-in.
  handColor: 'pitch-split' | 'tracks'
  clefPreference: 'treble' | 'bass' | 'grand'
  // Key filter for generated exercises (sight-reading, scales). 'C' = no
  // accidentals. Exercise-specific UIs can still override per session.
  keyFilter: string
  // HUD hit-rate counter visibility — off by default to keep learn mode
  // ambient rather than anxiety-inducing.
  showScoreCounter: boolean
}

export interface LearnProgressV1 {
  version: 1
  streak: { days: number; lastDay: string }
  xp: { total: number }
  exercises: Record<string, ExerciseStats>
  heatmap: { perPitch: Record<number, PitchStats> }
  pieces: Record<string, PieceStats>
  settings: LearnSettings
}

export const DEFAULT_SETTINGS: LearnSettings = {
  handColor: 'pitch-split',
  clefPreference: 'grand',
  keyFilter: 'C',
  showScoreCounter: false,
}

export function emptyProgress(): LearnProgressV1 {
  return {
    version: 1,
    streak: { days: 0, lastDay: '' },
    xp: { total: 0 },
    exercises: {},
    heatmap: { perPitch: {} },
    pieces: {},
    settings: { ...DEFAULT_SETTINGS },
  }
}

// Migration hook for `jsonPersisted`. Currently a pass-through because V1 is
// the only schema; when V2 lands, add a branch that converts `version === 1`
// records and falls through to defaults on anything unrecognised.
//
// The merge is intentionally one layer deep on every nested object — a
// shallow spread would wholesale-replace e.g. `settings`, so when we add a
// new settings field in a future release, users with existing data would
// read `undefined` for it. This function pre-pays that cost once.
export function migrateProgress(raw: unknown): LearnProgressV1 {
  if (
    !raw ||
    typeof raw !== 'object' ||
    !('version' in raw) ||
    (raw as { version: number }).version !== 1
  ) {
    return emptyProgress()
  }
  const v1 = raw as Partial<LearnProgressV1>
  const base = emptyProgress()
  return {
    version: 1,
    streak: { ...base.streak, ...(v1.streak ?? {}) },
    xp: { ...base.xp, ...(v1.xp ?? {}) },
    exercises: v1.exercises ?? {},
    heatmap: { perPitch: v1.heatmap?.perPitch ?? {} },
    pieces: v1.pieces ?? {},
    settings: { ...base.settings, ...(v1.settings ?? {}) },
  }
}
