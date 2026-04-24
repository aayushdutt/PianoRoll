import type { Exercise, ExerciseDescriptor } from '../../core/Exercise'
import type { ExerciseContext } from '../../core/ExerciseContext'
import type { ExerciseResult } from '../../core/Result'
import { computeXp } from '../../core/scoring'
import { IntervalsEngine } from './engine'
import { BEGINNER_SET } from './theory'
import { IntervalsUi } from './ui'

// Question count for a standard session. Small enough that a single run is
// sub-3-minutes, large enough that the accuracy signal is meaningful. The
// hub recommends ~one run per practice sitting; long tails come from repeats.
const QUESTION_COUNT = 10

export const intervalsDescriptor: ExerciseDescriptor = {
  id: 'intervals',
  title: 'Intervals',
  category: 'ear-training',
  difficulty: 'beginner',
  blurb: 'Hear two notes and name the distance between them. Beginner set — M3, P4, P5, octave.',
  factory: (ctx) => new IntervalsExercise(ctx),
}

// C1 from the learn-mode plan. Presents an ascending two-note interval,
// asks the user to identify it from the active pool, and reports accuracy
// + streak at the end. No MIDI file required — the synth is the entire
// sound source. Keyboard shortcuts (Space replay, 1-N pick answer, Enter
// next) keep the flow snappy; the UI can be driven entirely by keyboard.
class IntervalsExercise implements Exercise {
  readonly descriptor = intervalsDescriptor
  private engine: IntervalsEngine
  private ui: IntervalsUi
  private onKeyDown = (e: KeyboardEvent): void => this.handleKeyDown(e)

  constructor(private ctx: ExerciseContext) {
    this.engine = new IntervalsEngine({
      services: ctx.services,
      questionCount: QUESTION_COUNT,
      set: BEGINNER_SET,
    })
    this.ui = new IntervalsUi({
      engine: this.engine,
      answerSet: BEGINNER_SET,
      onCloseExercise: () => this.requestClose(),
      onAnswered: (correct) => this.onAnswered(correct),
      onFinished: () => this.requestFinish(),
    })
  }

  async mount(host: HTMLElement): Promise<void> {
    // Ear training has no scheduled MIDI — clear whatever the renderer was
    // showing so the background stays quiet. The LearnOverlay is unused for
    // this exercise (no target zone, no loop band); leaving it present is
    // harmless since its Graphics are empty until imperatively drawn.
    this.ctx.services.renderer.clearMidi()
    // Prime the synth as early as possible so the first playCurrent() call
    // inside the UI doesn't lose the first ~30ms of attack to context warmup.
    this.ctx.services.synth.primeLiveInput()
    this.ui.mount(host)
  }

  start(): void {
    this.engine.start()
    window.addEventListener('keydown', this.onKeyDown)
  }

  stop(): void {
    window.removeEventListener('keydown', this.onKeyDown)
  }

  unmount(): void {
    this.ui.unmount()
  }

  result(): ExerciseResult | null {
    const hits = this.engine.hits.value
    const misses = this.engine.misses.value
    const attempts = hits + misses
    if (attempts === 0) return null
    const accuracy = hits / attempts
    return {
      exerciseId: this.descriptor.id,
      duration_s: 0, // runner computes real duration from Session
      accuracy,
      xp: computeXp({ accuracy, duration_s: 60, difficultyWeight: 0.9 }),
      // Ear-training doesn't map to per-pitch weak spots — the "weakness" is
      // per-interval, not per-key. The progress heatmap stays empty for this
      // exercise; a future per-interval weakness layer can land alongside
      // C2/C3 when we have more than one ear-training surface to coordinate.
      weakSpots: [],
      completed: this.engine.phase.value === 'done',
    }
  }

  // ── Local helpers ─────────────────────────────────────────────────────

  private onAnswered(correct: boolean): void {
    if (correct) {
      // Reuse the shared celebration swell so ear training feels coherent
      // with play-along — same visual reward vocabulary across exercises.
      const viewport = this.ctx.services.renderer.currentViewport
      this.ctx.overlay.celebrationSwell(
        viewport.config.canvasWidth / 2,
        viewport.nowLineY,
        0x7ee7b8,
      )
      this.ctx.log.hit(0)
    } else {
      this.ctx.log.miss(0)
    }
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if (e.ctrlKey || e.metaKey || e.altKey) return
    const target = e.target as HTMLElement | null
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return

    if (e.code === 'Space') {
      e.preventDefault()
      this.engine.playCurrent()
      return
    }
    if (e.code === 'Enter' && this.engine.phase.value === 'feedback') {
      e.preventDefault()
      this.engine.next()
      return
    }
    // Number keys 1..N pick the nth answer from the current set. Keeps the
    // quiz entirely keyboard-driven so power users don't have to reach for
    // the mouse between questions.
    if (this.engine.phase.value !== 'question') return
    const digit = /^Digit([1-9])$/.exec(e.code)
    if (!digit) return
    const idx = Number(digit[1]) - 1
    const pick = BEGINNER_SET[idx]
    if (!pick) return
    e.preventDefault()
    // Use the Feedback returned by `answer()` directly — reading
    // `engine.feedback.value` after the call would show the previous
    // question's feedback if `answer()` no-op'd (e.g. phase was already
    // 'feedback' from a racing click), which would double-fire celebration.
    const fb = this.engine.answer(pick)
    if (fb) this.onAnswered(fb.correct)
  }

  private requestClose(): void {
    this.ctx.onClose('abandoned')
  }

  private requestFinish(): void {
    this.ctx.onClose('completed')
  }
}
