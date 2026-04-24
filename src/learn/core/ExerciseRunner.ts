import type { AppServices } from '../../core/services'
import { track, trackEvent } from '../../telemetry'
import type { LearnOverlay } from '../overlays/LearnOverlay'
import type { Exercise, ExerciseDescriptor } from './Exercise'
import type { ExerciseContext, ExerciseLog, ExerciseStorage } from './ExerciseContext'
import type { LearnState } from './LearnState'
import type { LearnProgressStore } from './progress'
import type { ExerciseResult } from './Result'
import { Session } from './Session'

// Deps injected by `LearnController` — all Learn-scoped so the runner never
// reaches into the global AppServices for Learn-only state.
export interface ExerciseRunnerDeps {
  services: AppServices
  learnState: LearnState
  progress: LearnProgressStore
  overlay: LearnOverlay
  host: HTMLElement
  // Called when the runner decides an exercise's lifecycle is over (completed,
  // abandoned, or mode-level swap). LearnController wires this to its hub
  // switch + session summary.
  onClose: (reason: 'completed' | 'abandoned') => void
  // Injectable wall clock so tests can freeze time without mocking Date.
  nowMs?: () => number
}

// Orchestrates the lifecycle of a single exercise. The hub (eventually)
// calls `launch(descriptor)` to start a run; `close()` tears it down. A
// Runner owns one exercise at a time — launching a new one while another
// is active closes the previous first.
//
// Responsibilities:
//   - Build the scoped ExerciseContext (progress, services, log, storage)
//   - Subscribe/unsubscribe to InputBus and the clock while active
//   - Commit the exercise's result to progress on exit
//   - Emit the exercise_started / exercise_completed / exercise_abandoned
//     analytics events so exercises don't have to
export class ExerciseRunner {
  // Subscribers registered with the InputBus while the current exercise is
  // active; unsubscribed on every close. Always empty when no exercise runs.
  private unsubs: Array<() => void> = []
  private currentExercise: Exercise | null = null
  private currentDescriptor: ExerciseDescriptor | null = null
  private session: Session | null = null
  private readonly services: AppServices
  private readonly learnState: LearnState
  private readonly progress: LearnProgressStore
  private readonly overlay: LearnOverlay
  private readonly host: HTMLElement
  private readonly onClose: (reason: 'completed' | 'abandoned') => void
  private readonly nowMs: () => number

  constructor(deps: ExerciseRunnerDeps) {
    this.services = deps.services
    this.learnState = deps.learnState
    this.progress = deps.progress
    this.overlay = deps.overlay
    this.host = deps.host
    this.onClose = deps.onClose
    this.nowMs = deps.nowMs ?? (() => Date.now())
  }

  get isActive(): boolean {
    return this.currentExercise !== null
  }

  get activeId(): string | null {
    return this.currentDescriptor?.id ?? null
  }

  async launch(descriptor: ExerciseDescriptor): Promise<void> {
    if (this.currentExercise) this.close('abandoned')

    if (descriptor.preload) await descriptor.preload()

    // Build the session + exercise up-front but don't publish them onto
    // `this` until `mount` succeeds. If mount throws, a subsequent launch
    // shouldn't observe a half-wired previous exercise.
    const session = new Session(this.nowMs)
    this.session = session
    const ctx: ExerciseContext = {
      descriptor,
      services: this.services,
      learnState: this.learnState,
      progress: this.progress,
      overlay: this.overlay,
      host: this.host,
      onClose: (reason) => this.onClose(reason),
      log: this.buildLog(descriptor),
      storage: this.buildStorage(descriptor),
    }

    const ex = descriptor.factory(ctx)
    try {
      await ex.mount(this.host)
    } catch (err) {
      this.session = null
      throw err
    }

    this.currentExercise = ex
    this.currentDescriptor = descriptor
    session.start()
    ex.start()
    this.subscribe(ex)

    trackEvent('exercise_started', {
      exercise_id: descriptor.id,
      category: descriptor.category,
      difficulty: descriptor.difficulty,
    })
  }

  close(reason: 'completed' | 'abandoned' = 'completed'): ExerciseResult | null {
    const ex = this.currentExercise
    const desc = this.currentDescriptor
    const session = this.session
    if (!ex || !desc || !session) return null

    // Detach inputs before asking for a result so a stray post-stop event
    // can't flip counters after we've snapshotted them. `session.end()` is
    // wrapped in try/finally so a throw inside `ex.result()` or `ex.unmount()`
    // can't leave `endMs === 0` — `session.duration_s` would otherwise keep
    // growing with wall-clock time against a detached session.
    this.unsubscribe()
    ex.stop()

    let result: ExerciseResult | null = null
    try {
      session.end()
      result = ex.result()
    } finally {
      try {
        ex.unmount()
      } catch (err) {
        console.error('[ExerciseRunner] unmount threw:', err)
      }
      this.currentExercise = null
      this.currentDescriptor = null
      this.session = null
    }

    if (result) {
      // If the exercise didn't set `completed` to match the close reason,
      // the close reason wins — the runner has the authoritative view.
      const finalResult: ExerciseResult = { ...result, completed: reason === 'completed' }
      this.progress.commit(finalResult)
      if (reason === 'completed') {
        trackEvent('exercise_completed', {
          exercise_id: desc.id,
          duration_s: Math.round(finalResult.duration_s),
          accuracy: Number(finalResult.accuracy.toFixed(3)),
          xp: Math.round(finalResult.xp),
          completed: true,
        })
      } else {
        trackEvent('exercise_abandoned', {
          exercise_id: desc.id,
          duration_s: Math.round(finalResult.duration_s),
        })
      }
      return finalResult
    }

    // Exercise opted out of producing a result (too-short session). Still
    // fire abandoned analytics so the funnel has a clean step for "started
    // then bailed", but commit nothing to progress.
    if (reason === 'abandoned') {
      trackEvent('exercise_abandoned', {
        exercise_id: desc.id,
        duration_s: Math.round(session.duration_s),
      })
    }
    return null
  }

  // ── Internal helpers ────────────────────────────────────────────────────

  private subscribe(ex: Exercise): void {
    const bus = this.services.input
    const clock = this.services.clock
    if (ex.onNoteOn) {
      this.unsubs.push(
        bus.noteOn.subscribe((e) => {
          if (e) ex.onNoteOn?.(e)
        }),
      )
    }
    if (ex.onNoteOff) {
      this.unsubs.push(
        bus.noteOff.subscribe((e) => {
          if (e) ex.onNoteOff?.(e)
        }),
      )
    }
    if (ex.onTick) {
      this.unsubs.push(clock.subscribe((t) => ex.onTick?.(t)))
    }
  }

  private unsubscribe(): void {
    for (const off of this.unsubs) off()
    this.unsubs = []
  }

  private buildLog(descriptor: ExerciseDescriptor): ExerciseLog {
    const session = this.session!
    return {
      hit: (_pitch) => session.hit(),
      miss: (pitch, expected) => session.miss(pitch, expected),
      // Free-form escape hatch for exercise-specific events not in the typed
      // registry. Prefixed so they're trivially filterable in PostHog.
      event: (name, data) =>
        track(`exercise.${descriptor.id}.${name}`, { exercise_id: descriptor.id, ...(data ?? {}) }),
    }
  }

  private buildStorage(descriptor: ExerciseDescriptor): ExerciseStorage {
    const prefix = `midee.learn.ex.${descriptor.id}.`
    return {
      get<T>(key: string, fallback: T): T {
        try {
          const raw = localStorage.getItem(prefix + key)
          if (raw === null) return fallback
          return JSON.parse(raw) as T
        } catch {
          return fallback
        }
      },
      set<T>(key: string, value: T): void {
        try {
          localStorage.setItem(prefix + key, JSON.stringify(value))
        } catch {
          // Quota or private-mode — best-effort.
        }
      },
    }
  }
}
