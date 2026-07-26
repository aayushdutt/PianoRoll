// Intervals ear-training exercise — Exercise integration class.
// Presents an ascending two-note interval, asks the user to identify it from
// the active pool, and reports accuracy + streak at the end. Keyboard-driven
// (Space replay, 1-4 pick answer, Enter next). No MIDI file required — the
// synth is the entire sound source.

import { t } from '../../../i18n'
import type { Exercise, ExerciseDescriptor } from '../../core/Exercise'
import type { ExerciseContext } from '../../core/ExerciseContext'
import { createExerciseHarness, type Huddable } from '../../core/exerciseHarness'
import { isKeyboardShortcutIgnored } from '../../core/keyboard'
import type { ExerciseResult } from '../../core/Result'
import { standardResult } from '../../core/resultHelpers'
import { IntervalsEngine } from './engine'
import { BEGINNER_SET } from './theory'
import { createIntervalsUi, type IntervalsUiOptions } from './ui'

// Question count for a standard session. Small enough that a single run is
// sub-3-minutes, large enough that the accuracy signal is meaningful. The
// hub recommends ~one run per practice sitting; long tails come from repeats.
const QUESTION_COUNT = 10

export const intervalsDescriptor: ExerciseDescriptor = {
  id: 'intervals',
  // `title` / `blurb` are getters so the hub re-reads them after a locale
  // flip — the descriptor object itself is constructed once at module load.
  get title() {
    return t('learn.exercise.intervals.title')
  },
  category: 'ear-training',
  difficulty: 'beginner',
  get blurb() {
    return t('learn.exercise.intervals.blurb')
  },
  factory: (ctx) => new IntervalsExercise(ctx),
}

class IntervalsExercise implements Exercise {
  readonly descriptor = intervalsDescriptor
  private engine: IntervalsEngine
  private ui: ReturnType<typeof createIntervalsUi>
  private readonly uiOpts: IntervalsUiOptions
  private harness: ReturnType<typeof createExerciseHarness>
  private onKeyDown = (e: KeyboardEvent): void => this.handleKeyDown(e)

  constructor(private ctx: ExerciseContext) {
    this.engine = new IntervalsEngine({
      services: ctx.services,
      questionCount: QUESTION_COUNT,
      set: BEGINNER_SET,
    })
    this.ui = createIntervalsUi()
    this.uiOpts = {
      engine: this.engine,
      answerSet: BEGINNER_SET,
      onCloseExercise: () => this.requestClose(),
      onAnswered: (correct) => this.onAnswered(correct),
      onFinished: () => this.requestFinish(),
    }
    this.harness = createExerciseHarness({
      hud: this.ui as Huddable,
      hudOpts: this.uiOpts,
      onKeyDown: this.onKeyDown,
    })
  }

  mount(host: HTMLElement): void {
    this.ctx.services.renderer.clearMidi()
    this.ctx.services.synth.primeLiveInput()
    this.harness.mountHud(host)
  }

  start(): void {
    this.engine.start()
    this.harness.attachKeys()
  }

  stop(): void {
    this.harness.detachKeys()
  }

  unmount(): void {
    this.harness.unmountHud()
  }

  result(): ExerciseResult | null {
    return standardResult({
      exerciseId: this.descriptor.id,
      hits: this.engine.state.hits,
      misses: this.engine.state.misses,
      difficultyWeight: 0.9,
      completed: this.engine.state.phase === 'done',
    })
  }

  // ── Local helpers ─────────────────────────────────────────────────────

  private onAnswered(correct: boolean): void {
    if (correct) {
      // Reuse the shared celebration swell so ear training feels coherent
      // with play-along — same visual reward vocabulary across exercises.
      const viewport = this.ctx.services.renderer.currentViewport
      if (viewport) {
        this.ctx.overlay.celebrationSwell(
          viewport.config.canvasWidth / 2,
          viewport.nowLineY,
          0x7ee7b8,
        )
      }
      this.ctx.log.hit(0)
    } else {
      this.ctx.log.miss(0)
    }
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if (isKeyboardShortcutIgnored(e)) return

    if (e.code === 'Space') {
      e.preventDefault()
      this.engine.playCurrent()
      return
    }
    if (e.code === 'Enter' && this.engine.state.phase === 'feedback') {
      e.preventDefault()
      this.engine.next()
      return
    }
    // Number keys 1..N pick the nth answer from the current set. Keeps the
    // quiz entirely keyboard-driven so power users don't have to reach for
    // the mouse between questions.
    if (this.engine.state.phase !== 'question') return
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
