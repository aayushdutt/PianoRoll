import type { ClefMode } from './music'

export type NoteDuration = 'whole' | 'half' | 'quarter' | 'eighth'
export type { ClefMode } from './music'

export interface StreamNote {
  id: number
  midi: number
  duration: NoteDuration
  beats: number // whole=4, half=2, quarter=1, eighth=0.5
  time: number // engine seconds when onset should cross the now-line
  state: 'approaching' | 'in-window' | 'hit' | 'missed'
  hitTime?: number // engine.time when hit (for animation)
  missTime?: number // engine.time when missed
  hitVerdict?: 'perfect' | 'good' | 'early' | 'late'
  wrongKeyCount: number // wrong-pitch presses on this note before resolution
}

export interface SessionScore {
  perfect: number
  good: number
  missed: number
  wrongKey: number
  streak: number
  bestStreak: number
  totalPlayed: number
  consecutiveMisses: number // for lives-dots display
  phase: 'idle' | 'playing' | 'knockedOut' | 'complete'
  paused: boolean
  bpm: number // reactive copy updated in tick() when integer value changes
  rampEnabled: boolean
  noteGap: number // reactive copy of note spacing multiplier (1.0 = default)
}

export type TierKey = 'landmark' | 'c-major-1' | 'c-major-2' | 'grand-staff' | 'key-sigs' | 'arcade'

export interface TierConfig {
  name: string
  pitchPool: number[] // explicit MIDI pitches allowed
  defaultBpm: number
  sessionLength: number // note count (use Infinity for arcade/knockout)
  clef: ClefMode
  keySignature: string
}

export interface EngineConfig {
  bpm: number
  bpmRamp: number // BPM gained per real second (0 = practice mode)
  maxBpm: number
  lookAheadBeats: number // beats visible ahead of the now-line (default 4)
  practiceMode: boolean
}

export interface NoteSource {
  next(): number | null // returns next MIDI pitch, or null when exhausted
  readonly progress: number // 0..1
  readonly done: boolean
}
