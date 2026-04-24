import type { AppServices } from '../../../core/services'
import { Signal } from '../../../store/state'
import { makeQuestions, type Question } from './theory'

// Runtime state for the Intervals quiz. DOM-free so it can be reasoned about
// independently — the UI subscribes to signals, not the engine's internals.
//
// Lifecycle:
//   `start()` generates the question plan, publishes question 0.
//   `playCurrent()` schedules the two interval notes via SynthEngine.
//   `answer(id)` checks against the current question, advances, and either
//     auto-plays the next or — on the last question — flips to 'done'.
//
// The engine does not drive the clock. Ear training is event-paced, not
// time-paced — the user decides when to hear a question again or answer.

export interface IntervalsEngineOptions {
  services: AppServices
  // Number of questions per session. Defaults match the hub UX brief.
  questionCount?: number
  // Which interval ids are in the pool for this run. Defaults to the
  // beginner four (M3 / P4 / P5 / octave) — the exercise caller can widen
  // this in the future without touching the engine.
  set?: readonly string[]
  // Seam for determinism in tests. Production code defaults to `Math.random`.
  rand?: () => number
  // Scheduler seam — injected in tests so the engine doesn't depend on a
  // real AudioContext.
  scheduleInterval?: (rootPitch: number, semitones: number) => void
}

export type IntervalsPhase = 'ready' | 'question' | 'feedback' | 'done'
export interface Feedback {
  correct: boolean
  // The user's pick (always set) and the right answer (always set) — the UI
  // reveals both after a miss and pulses the chosen button on a hit.
  picked: string
  answer: string
}

export class IntervalsEngine {
  readonly phase = new Signal<IntervalsPhase>('ready')
  // 0-based question index. UI displays `index + 1` to the user so the first
  // question reads "1 of 10".
  readonly index = new Signal<number>(0)
  readonly questions = new Signal<readonly Question[]>([])
  readonly hits = new Signal<number>(0)
  readonly misses = new Signal<number>(0)
  // Current streak of consecutive first-try hits. Resets on miss. Surfaces
  // "3 in a row" micro-celebrations.
  readonly streak = new Signal<number>(0)
  readonly feedback = new Signal<Feedback | null>(null)

  private opts: {
    services: AppServices
    questionCount: number
    set: readonly string[]
    rand: () => number
    scheduleInterval?: (rootPitch: number, semitones: number) => void
  }
  // Guards against double-scoring when a user hammers two choice buttons
  // before the 'feedback' phase paints. Flipped on first answer, cleared on
  // next().
  private answered = false

  constructor(opts: IntervalsEngineOptions) {
    this.opts = {
      services: opts.services,
      questionCount: opts.questionCount ?? 10,
      set: opts.set ?? [],
      rand: opts.rand ?? Math.random,
      ...(opts.scheduleInterval ? { scheduleInterval: opts.scheduleInterval } : {}),
    }
  }

  start(): void {
    const questions = makeQuestions(this.opts.questionCount, this.opts.set, this.opts.rand)
    this.questions.set(questions)
    this.index.set(0)
    this.hits.set(0)
    this.misses.set(0)
    this.streak.set(0)
    this.feedback.set(null)
    this.answered = false
    if (questions.length === 0) {
      this.phase.set('done')
      return
    }
    this.phase.set('question')
  }

  // Stream the current question to the audio layer. Called by the UI on
  // mount and on "play again" — the engine itself never auto-replays.
  playCurrent(): void {
    const q = this.currentQuestion
    if (!q) return
    const schedule = this.opts.scheduleInterval ?? this.defaultSchedule
    schedule(q.rootPitch, q.semitones)
  }

  get currentQuestion(): Question | null {
    const q = this.questions.value[this.index.value]
    return q ?? null
  }

  answer(intervalId: string): Feedback | null {
    if (this.phase.value !== 'question' || this.answered) return null
    const q = this.currentQuestion
    if (!q) return null
    this.answered = true
    const correct = intervalId === q.intervalId
    if (correct) {
      this.hits.set(this.hits.value + 1)
      this.streak.set(this.streak.value + 1)
    } else {
      this.misses.set(this.misses.value + 1)
      this.streak.set(0)
    }
    const fb: Feedback = { correct, picked: intervalId, answer: q.intervalId }
    this.feedback.set(fb)
    this.phase.set('feedback')
    return fb
  }

  // Advance to the next question, or flip to 'done' after the last one.
  next(): void {
    if (this.phase.value !== 'feedback') return
    const nextIdx = this.index.value + 1
    this.answered = false
    this.feedback.set(null)
    if (nextIdx >= this.questions.value.length) {
      this.phase.set('done')
      return
    }
    this.index.set(nextIdx)
    this.phase.set('question')
  }

  get accuracy(): number {
    const total = this.hits.value + this.misses.value
    return total > 0 ? this.hits.value / total : 0
  }

  // Schedule two notes sequentially on the live synth: root at ctxNow, then
  // the upper pitch after the root has had time to sound. Using
  // `scheduleNoteOn` (not `liveNoteOn`) keeps the programmatic playback out
  // of the user-input paths — the keyboard UI doesn't highlight notes the
  // user didn't press, which is important for ear training.
  private defaultSchedule = (rootPitch: number, semitones: number): void => {
    const synth = this.opts.services.synth
    const ctxNow = synth.audioContextTime
    const NOTE = 0.72 // seconds each note sustains
    const GAP = 0.08 // gap between root release and upper attack
    const VEL = 0.85
    const topPitch = rootPitch + semitones
    synth.scheduleNoteOn(rootPitch, VEL, ctxNow + 0.02)
    synth.scheduleNoteOff(rootPitch, ctxNow + 0.02 + NOTE)
    synth.scheduleNoteOn(topPitch, VEL, ctxNow + 0.02 + NOTE + GAP)
    synth.scheduleNoteOff(topPitch, ctxNow + 0.02 + NOTE + GAP + NOTE)
  }
}
