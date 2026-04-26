import type { MasterClock } from '../../core/clock/MasterClock'
import type { MidiFile } from '../../core/midi/types'
import { createEventSignal } from '../../store/eventSignal'

// Minimum gap between two consecutive note-onsets to consider them a *new*
// step. Notes within this window collapse into a single chord step, which is
// how a human reads "play these together" off a score.
const STEP_GROUPING_SEC = 0.04

// Tiny seek-past offset used when the engine releases the clock — keeps the
// scheduler from re-triggering the chord the user just played.
const RESUME_NUDGE_SEC = 0.006

// The clock must move at least this far past the last cleared step before we
// re-arm waiting. Without it, a moment of float-precision drift on the very
// next tick would re-engage on the same step.
const REARM_BUFFER_SEC = 0.003

// Engage wait-mode slightly BEFORE the scheduled step time. Tone's scheduler
// pre-schedules note-ons into the WebAudio graph up to `lookAhead` seconds
// ahead; pausing the clock at exactly `step.time` doesn't recall already-
// queued events, so the player would hear the "answer" before pressing a key.
// The lead must stay > lookAhead.
//
// 10 ms pairs with `getContext().lookAhead = 0.005` set inside
// `PlayAlongExercise.start()` — 5 ms of safety margin. The aggressive pair
// keeps the perceived "wait engaged" gap to a single frame at 60 Hz, matching
// what Synthesia-class apps feel like. The override is scoped to the
// Play-Along session lifecycle so Play / Live keep Tone's default headroom
// (which is more forgiving on weaker machines) — see
// `PlayAlongExercise.start/stop` in `play-along/index.ts`.
const ENGAGE_LEAD_SEC = 0.01

export interface PracticeStep {
  // Start time of the chord step (seconds).
  time: number
  // Pitches (MIDI numbers) the user must press to advance.
  pitches: ReadonlySet<number>
  // Furthest end time of any note in this step — handy for the HUD's "next
  // bar" affordance even though the engine itself doesn't consume it.
  latestEnd: number
}

export interface PracticeStatus {
  enabled: boolean
  // True only while the engine is actively holding the clock for a step.
  // The HUD uses this to surface a "play these notes" cue.
  waiting: boolean
  // Pitches the user still needs to press to clear the current step. Empty
  // when not waiting.
  pending: ReadonlySet<number>
  // Pitches already pressed and accepted for the current step. Lights up the
  // keyboard so the player sees their progress through a chord.
  accepted: ReadonlySet<number>
  // 0..1 how complete the current step is. Drives a subtle progress ring.
  progress: number
  // The step currently waited on (or null when not waiting).
  step: PracticeStep | null
}

const EMPTY_STATUS: PracticeStatus = Object.freeze({
  enabled: false,
  waiting: false,
  pending: new Set<number>(),
  accepted: new Set<number>(),
  progress: 0,
  step: null,
})

export interface PracticeCallbacks {
  // Called when the engine wants playback to halt. The host should mirror its
  // own paused state (status.set('paused')) and call `clock.pause()`.
  onWaitStart(step: PracticeStep): void
  // Called when the engine has cleared the current step. The host should
  // resume playback from `resumeTime` — slightly past the chord onset so the
  // scheduler doesn't re-trigger the chord the user just played.
  onWaitEnd(resumeTime: number): void
}

// Outcome of `notePressed`. `articulationMs` is wall-clock between the FIRST
// and LAST pending pitch on the cleared step — single-note steps are always
// 0 (perfect). `clearedStep` lets hosts drive the legato bonus without
// poking at engine private state.
//
// `'duplicate'` is split out from `'rejected'` because re-strikes of an
// already-accepted pitch (MIDI bounce, octave doubling) shouldn't bump an
// error counter — the user already played that note. Hosts treat
// `'duplicate'` as a no-op; `'rejected'` is a wrong-pitch press.
export type PressOutcome =
  | { kind: 'advanced'; articulationMs: number; clearedStep: PracticeStep }
  | { kind: 'accepted' }
  | { kind: 'duplicate' }
  | { kind: 'rejected' }

// Synthesia-style "wait mode". When enabled, playback halts at every chord
// onset and resumes only after the player presses the right pitches. The
// engine watches the clock + emits intent through `onWaitStart` / `onWaitEnd`;
// the host (App) owns the actual clock/appState orchestration so audio,
// visuals, and analytics stay coherent.
export class PracticeEngine {
  readonly status = createEventSignal<PracticeStatus>(EMPTY_STATUS)

  private midi: MidiFile | null = null
  private steps: PracticeStep[] = []
  private enabled = false
  // Index of the next step to wait on. -1 means "no pending step" (we're
  // either past the end or at the very start).
  private nextStepIdx = -1
  private accepted = new Set<number>()
  private pending = new Set<number>()
  private waiting = false
  // Time-cursor floor — the engine only re-arms waiting when the clock has
  // advanced past this. Set when releasing the wait so the very next tick
  // doesn't re-engage on the step we just satisfied.
  private earliestRearmTime = -Infinity
  // Wall-clock (ms) when the FIRST pending pitch of the current step landed.
  // Captured on the first `notePressed` of a step, read when the step clears
  // to compute articulationMs. Field is mutable so tests can swap in a
  // deterministic clock via reflection — there's no production caller that
  // needs to override.
  private chordStartMs: number | null = null
  private nowMs: () => number = () =>
    typeof performance !== 'undefined' ? performance.now() : Date.now()

  private visibleTrackIds: Set<string> | null = null

  private unsubClock: (() => void) | null = null

  constructor(
    private clock: MasterClock,
    private callbacks: PracticeCallbacks,
  ) {
    this.unsubClock = clock.subscribe((t) => this.onClockTick(t))
  }

  loadMidi(midi: MidiFile | null): void {
    this.midi = midi
    this.rebuildSteps()
    this.recomputeNextStep(this.clock.currentTime)
    this.releaseInternalState()
    this.publish()
  }

  setVisibleTracks(ids: Iterable<string> | null): void {
    this.visibleTrackIds = ids ? new Set(ids) : null
    this.rebuildSteps()
    this.recomputeNextStep(this.clock.currentTime)
    this.releaseInternalState()
    this.publish()
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return
    this.enabled = enabled
    if (!enabled) {
      // Drop wait state silently — disabling practice is the CALLER'S
      // transport decision (pause, detach, mode switch). Firing `onWaitEnd`
      // here would ask the caller to resume playback while they're actively
      // trying to stop; the caller already handles resume/seek explicitly
      // when they re-enable or resume elsewhere.
      this.releaseInternalState()
    } else {
      this.recomputeNextStep(this.clock.currentTime)
    }
    this.publish()
  }

  toggle(): boolean {
    this.setEnabled(!this.enabled)
    return this.enabled
  }

  get isEnabled(): boolean {
    return this.enabled
  }
  get isWaiting(): boolean {
    return this.waiting
  }

  // See `PressOutcome` for the four kinds and what they signal.
  notePressed(pitch: number): PressOutcome {
    if (!this.enabled || !this.waiting) return { kind: 'rejected' }
    if (this.accepted.has(pitch)) return { kind: 'duplicate' }
    if (!this.pending.has(pitch)) return { kind: 'rejected' }
    // Articulation timer starts on the FIRST accepted pitch of the step;
    // span from first to last is what we grade.
    if (this.accepted.size === 0) {
      this.chordStartMs = this.nowMs()
    }
    this.pending.delete(pitch)
    this.accepted.add(pitch)
    if (this.pending.size === 0) {
      const startedMs = this.chordStartMs ?? this.nowMs()
      const articulationMs = Math.max(0, this.nowMs() - startedMs)
      // Snapshot the step BEFORE `advancePastCurrentStep` moves the cursor.
      const clearedStep = this.steps[this.nextStepIdx] ?? null
      this.advancePastCurrentStep()
      this.publish()
      if (clearedStep) {
        return { kind: 'advanced', articulationMs, clearedStep }
      }
      // Should be unreachable (we were waiting, so a step existed) but the
      // type system can't see that — fall back to "rejected" so callers
      // never need to defend a nullish step on the advanced branch.
      return { kind: 'rejected' }
    }
    this.publish()
    return { kind: 'accepted' }
  }

  // App calls this whenever the user seeks (scrubber, skip-back/-fwd, etc.)
  // so we re-find the next step relative to the new position.
  notifySeek(time: number): void {
    this.recomputeNextStep(time)
    this.releaseInternalState()
    this.earliestRearmTime = -Infinity
    this.publish()
  }

  peekNextStep(): PracticeStep | null {
    if (this.nextStepIdx < 0) return null
    return this.steps[this.nextStepIdx] ?? null
  }

  private onClockTick(time: number): void {
    if (!this.enabled || !this.midi) return
    if (this.waiting) return
    if (this.nextStepIdx < 0) return
    if (time < this.earliestRearmTime) return

    const step = this.steps[this.nextStepIdx]
    if (!step) return

    if (time >= step.time - ENGAGE_LEAD_SEC) {
      this.engageWait(step)
    }
  }

  private engageWait(step: PracticeStep): void {
    this.waiting = true
    this.pending = new Set(step.pitches)
    this.accepted = new Set()
    this.publish()
    this.callbacks.onWaitStart(step)
  }

  private advancePastCurrentStep(): void {
    const step = this.steps[this.nextStepIdx]
    const resumeAt = step ? step.time + RESUME_NUDGE_SEC : this.clock.currentTime
    this.earliestRearmTime = resumeAt + REARM_BUFFER_SEC
    const nextIdx = this.nextStepIdx + 1
    this.nextStepIdx = nextIdx < this.steps.length ? nextIdx : -1
    this.waiting = false
    this.pending = new Set()
    this.accepted = new Set()
    this.chordStartMs = null
    this.callbacks.onWaitEnd(resumeAt)
  }

  private releaseInternalState(): void {
    this.waiting = false
    this.pending = new Set()
    this.accepted = new Set()
    this.chordStartMs = null
  }

  private recomputeNextStep(time: number): void {
    if (this.steps.length === 0) {
      this.nextStepIdx = -1
      return
    }
    for (let i = 0; i < this.steps.length; i++) {
      if (this.steps[i]!.time >= time) {
        this.nextStepIdx = i
        return
      }
    }
    this.nextStepIdx = -1
  }

  private rebuildSteps(): void {
    if (!this.midi) {
      this.steps = []
      return
    }

    interface Onset {
      time: number
      pitch: number
      end: number
    }
    const onsets: Onset[] = []
    for (const track of this.midi.tracks) {
      if (track.isDrum) continue
      if (this.visibleTrackIds && !this.visibleTrackIds.has(track.id)) continue
      for (const note of track.notes) {
        onsets.push({
          time: note.time,
          pitch: note.pitch,
          end: note.time + note.duration,
        })
      }
    }
    onsets.sort((a, b) => a.time - b.time)

    const steps: PracticeStep[] = []
    let i = 0
    while (i < onsets.length) {
      const head = onsets[i]!
      const groupEnd = head.time + STEP_GROUPING_SEC
      const pitches = new Set<number>([head.pitch])
      let latestEnd = head.end
      let j = i + 1
      while (j < onsets.length && onsets[j]!.time <= groupEnd) {
        pitches.add(onsets[j]!.pitch)
        if (onsets[j]!.end > latestEnd) latestEnd = onsets[j]!.end
        j++
      }
      steps.push({ time: head.time, pitches, latestEnd })
      i = j
    }

    this.steps = steps
  }

  private publish(): void {
    if (!this.enabled) {
      this.status.set(EMPTY_STATUS)
      return
    }

    const total = this.waiting ? this.pending.size + this.accepted.size : 0
    const progress = total > 0 ? this.accepted.size / total : 0
    const step =
      this.waiting && this.nextStepIdx >= 0 ? (this.steps[this.nextStepIdx] ?? null) : null
    this.status.set({
      enabled: true,
      waiting: this.waiting,
      pending: new Set(this.pending),
      accepted: new Set(this.accepted),
      progress,
      step,
    })
  }

  dispose(): void {
    this.unsubClock?.()
    this.unsubClock = null
  }
}
