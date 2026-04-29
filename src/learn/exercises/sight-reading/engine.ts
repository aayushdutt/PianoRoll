import { batch } from 'solid-js'
import { createStore, type SetStoreFunction } from 'solid-js/store'
import { classifyTiming, GOOD_WINDOW_SEC, LATE_HIT_WINDOW_SEC } from '../../core/scoring'
import type { EngineConfig, NoteSource, SessionScore, StreamNote } from './types'

export const KNOCKOUT_THRESHOLD = 10

// Duration → beat value mapping
const BEAT_VALUES: Record<string, number> = {
  whole: 4,
  half: 2,
  quarter: 1,
}

// Pick a duration for a spawned note based on tempo.
// Faster BPM → shorter durations to keep visual density reasonable.
function durationForBpm(bpm: number): StreamNote['duration'] {
  if (bpm >= 100) return 'quarter'
  if (bpm >= 72) return 'half'
  return 'whole'
}

const INITIAL_SCORE: SessionScore = {
  perfect: 0,
  good: 0,
  missed: 0,
  wrongKey: 0,
  streak: 0,
  bestStreak: 0,
  totalPlayed: 0,
  consecutiveMisses: 0,
  phase: 'idle',
  paused: false,
  bpm: 0,
  rampEnabled: false,
  noteGap: 1,
}

export class SightReadingEngine {
  readonly state: SessionScore
  private readonly write: SetStoreFunction<SessionScore>

  // Hot-path state — not reactive, read by renderer every frame.
  notes: StreamNote[] = []
  time = 0
  bpm: number
  started = false
  paused = false

  // Ramp mode — user-toggleable, increases BPM over time.
  rampEnabled = false
  private rampRate: number

  // Note spacing multiplier — user-adjustable, persists across restarts.
  noteGap = 1
  private userNoteGap: number | null = null

  // Per-pitch hit/miss tracking for weak-note analysis. Updated in noteOn()
  // and _recordMiss(). Keyed by MIDI pitch.
  readonly noteStats: Map<number, { hits: number; misses: number }> = new Map()

  private source: NoteSource | null = null
  private nextNoteTime = 0
  private noteIdCounter = 0
  private readonly config: EngineConfig
  // Persists across restarts within the same exercise session so the user's
  // tempo adjustment survives "Play Again".
  private userBpm: number | null = null

  constructor(config: EngineConfig) {
    this.config = config
    this.rampRate = config.bpmRamp
    this.rampEnabled = config.bpmRamp > 0
    this.bpm = config.bpm
    const [state, setState] = createStore<SessionScore>({ ...INITIAL_SCORE, bpm: config.bpm })
    this.state = state
    this.write = setState
  }

  attach(source: NoteSource): void {
    this.source = source
    this.notes = []
    this.time = 0
    this.bpm = this.userBpm ?? this.config.bpm
    this.noteGap = this.userNoteGap ?? 1
    this.rampEnabled = this.config.bpmRamp > 0
    this.rampRate = this.config.bpmRamp
    this.nextNoteTime = this.config.lookAheadBeats * (60 / this.bpm)
    this.noteIdCounter = 0
    this.started = false
    this.paused = false
    this.noteStats.clear()
    batch(() => {
      this.write({ ...INITIAL_SCORE, bpm: this.bpm, noteGap: this.noteGap })
    })
  }

  /** Set tempo, clamped to [30, 200] BPM. Persists across session restarts. */
  setBpm(bpm: number): void {
    const clamped = Math.max(30, Math.min(200, Math.round(bpm)))
    this.userBpm = clamped
    this.bpm = clamped
    this.write({ bpm: clamped })
  }

  /** Set note spacing multiplier, clamped to [0.3, 2.5]. Persists across restarts. */
  setNoteGap(gap: number): void {
    const clamped = Math.max(0.3, Math.min(2.5, Math.round(gap * 20) / 20))
    this.userNoteGap = clamped
    this.noteGap = clamped
    this.write({ noteGap: clamped })
  }

  /** Toggle tempo ramp. When enabled, BPM increases at `rampRate` BPM/sec. */
  setRamp(enabled: boolean): void {
    this.rampEnabled = enabled
    if (enabled && this.rampRate <= 0) {
      this.rampRate = 0.2
    }
    this.write({ rampEnabled: enabled })
  }

  pause(): void {
    this.paused = true
    batch(() => {
      this.write({ paused: true })
    })
  }

  resume(): void {
    this.paused = false
    batch(() => {
      this.write({ paused: false })
    })
  }

  start(): void {
    if (!this.source) return
    this.started = true
    batch(() => {
      this.write({ phase: 'playing' })
    })
  }

  tick(dt: number): void {
    if (!this.started || this.paused) return
    if (this.state.phase === 'knockedOut' || this.state.phase === 'complete') return

    // Ramp BPM when ramp mode is enabled.
    if (this.rampEnabled) {
      const prevBpmInt = Math.round(this.bpm)
      this.bpm = Math.min(this.config.maxBpm, this.bpm + this.rampRate * dt)
      if (Math.round(this.bpm) !== prevBpmInt) {
        this.write({ bpm: this.bpm })
      }
    }

    this.time += dt

    this._spawnNotes()
    this._updateNoteStates()
    this._cullOldNotes()
    this._checkSessionEnd()
  }

  private _spawnNotes(): void {
    if (!this.source || this.source.done) return
    const lookAheadSec = this.config.lookAheadBeats * (60 / this.bpm)
    const noteInterval = Math.max(0.35, this.noteGap * 1.2 * (60 / this.bpm))

    while (this.nextNoteTime < this.time + lookAheadSec) {
      const midi = this.source.next()
      if (midi === null) break
      const duration = durationForBpm(this.bpm)
      const note: StreamNote = {
        id: ++this.noteIdCounter,
        midi,
        duration,
        beats: BEAT_VALUES[duration]!,
        time: this.nextNoteTime,
        state: 'approaching',
        wrongKeyCount: 0,
      }
      this.notes.push(note)
      this.nextNoteTime += noteInterval
    }
  }

  private _updateNoteStates(): void {
    for (const note of this.notes) {
      if (note.state !== 'approaching' && note.state !== 'in-window') continue

      const delta = this.time - note.time
      if (Math.abs(delta) <= GOOD_WINDOW_SEC) {
        note.state = 'in-window'
      } else if (delta > LATE_HIT_WINDOW_SEC) {
        note.state = 'missed'
        note.missTime = this.time
        this._recordMiss(note.midi)
      }
    }
  }

  private _recordMiss(midi: number): void {
    const newConsecutive = this.state.consecutiveMisses + 1
    const knocked = !this.config.practiceMode && newConsecutive >= KNOCKOUT_THRESHOLD

    // Track per-pitch stats.
    const stat = this.noteStats.get(midi) ?? { hits: 0, misses: 0 }
    this.noteStats.set(midi, { hits: stat.hits, misses: stat.misses + 1 })

    batch(() => {
      this.write({
        missed: this.state.missed + 1,
        streak: 0,
        consecutiveMisses: newConsecutive,
        phase: knocked ? 'knockedOut' : this.state.phase,
      })
    })
  }

  private _cullOldNotes(): void {
    this.notes = this.notes.filter((n) => {
      if (n.state === 'hit' && n.hitTime !== undefined) {
        return this.time - n.hitTime <= 0.5
      }
      if (n.state === 'missed' && n.missTime !== undefined) {
        return this.time - n.missTime <= 0.45
      }
      return true
    })
  }

  private _checkSessionEnd(): void {
    if (!this.source?.done) return
    const hasActive = this.notes.some((n) => n.state === 'approaching' || n.state === 'in-window')
    if (!hasActive && this.state.phase === 'playing') {
      batch(() => {
        this.write({ phase: 'complete' })
      })
    }
  }

  noteOn(midi: number): 'hit' | 'wrong' | 'none' {
    if (this.paused) return 'none'
    // Find the earliest unresolved note (approaching or in-window).
    let target: StreamNote | null = null
    for (const note of this.notes) {
      if (note.state === 'approaching' || note.state === 'in-window') {
        if (target === null || note.time < target.time) {
          target = note
        }
      }
    }

    if (target === null) return 'none'

    if (target.midi === midi) {
      const verdict = classifyTiming(this.time, target.time)
      // 'miss' from classifyTiming means the press arrived after LATE_HIT_WINDOW;
      // at that point the note would already be culled by tick(), but guard anyway.
      const hitVerdict =
        verdict === 'miss' ? 'late' : (verdict as 'perfect' | 'good' | 'early' | 'late')

      target.state = 'hit'
      target.hitTime = this.time
      target.hitVerdict = hitVerdict

      // Track per-pitch stats.
      const stat = this.noteStats.get(target.midi) ?? { hits: 0, misses: 0 }
      this.noteStats.set(target.midi, { hits: stat.hits + 1, misses: stat.misses })

      const newStreak = this.state.streak + 1
      batch(() => {
        this.write({
          [hitVerdict === 'perfect' ? 'perfect' : 'good']:
            hitVerdict === 'perfect' ? this.state.perfect + 1 : this.state.good + 1,
          streak: newStreak,
          bestStreak: Math.max(this.state.bestStreak, newStreak),
          totalPlayed: this.state.totalPlayed + 1,
          consecutiveMisses: 0,
        })
      })
      return 'hit'
    }

    // Wrong pitch.
    target.wrongKeyCount++
    batch(() => {
      this.write({
        wrongKey: this.state.wrongKey + 1,
        streak: 0,
      })
    })
    return 'wrong'
  }

  /** Seconds of look-ahead currently visible (used by the renderer for pxPerSec). */
  get lookAheadSec(): number {
    return this.config.lookAheadBeats * (60 / this.bpm)
  }

  stop(): void {
    this.started = false
    this.paused = false
  }
}

export function gradeFromAccuracy(acc: number): 'S' | 'A' | 'B' | 'C' | 'D' {
  if (acc >= 0.95) return 'S'
  if (acc >= 0.85) return 'A'
  if (acc >= 0.7) return 'B'
  if (acc >= 0.55) return 'C'
  return 'D'
}
