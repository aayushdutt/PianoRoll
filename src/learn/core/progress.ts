import { jsonPersisted } from '../../core/persistence'
import { Signal } from '../../store/state'
import { applyStreak, type CommitOutcome, commitResult, isoDay } from './progress-actions'
import {
  emptyProgress,
  type LearnProgressV1,
  type LearnSettings,
  migrateProgress,
} from './progress-schema'
import type { ExerciseResult } from './Result'

const STORAGE_KEY = 'midee.learn.v1'

// Stateful façade over the progress schema + pure action helpers. Everything
// the hub, exercises, and analytics funnel need to read/write lives behind
// this one object — exposed as a Signal so UI code subscribes once and gets
// consistent updates across every mutation.
//
// Action logic is kept in `progress-actions.ts` (pure, fully unit-tested).
// This class only handles persistence, change notification, and the "today"
// side-effect (needed for streak rollovers). Swap the clock via the `today`
// injection point in tests.
export class LearnProgressStore {
  readonly state: Signal<LearnProgressV1>
  private persisted = jsonPersisted<LearnProgressV1>(STORAGE_KEY, emptyProgress(), migrateProgress)

  // Injectable clock so tests can advance across day boundaries without
  // manipulating the real Date. Defaults to wall time.
  constructor(private today: () => string = () => isoDay(new Date())) {
    this.state = new Signal<LearnProgressV1>(this.persisted.load())
  }

  // Touches the streak for the current day without committing anything else.
  // Useful when the hub surfaces a "today's practice" indicator — opening the
  // app and playing for a bit already counts, even before an exercise ends.
  touchStreak(): { extended: boolean } {
    const prev = this.state.value
    const { next, extended } = applyStreak(prev.streak, this.today())
    if (!extended) return { extended: false }
    const merged: LearnProgressV1 = { ...prev, streak: next }
    this.writeAndPublish(merged)
    return { extended: true }
  }

  // Folds an exercise result into the store. Returns the commit outcome so
  // the caller can fire analytics (learn_streak_extended, xp_gained, etc.)
  // on the same tick that the UI updates.
  commit(result: ExerciseResult): CommitOutcome {
    const outcome = commitResult(this.state.value, result, this.today())
    this.writeAndPublish(outcome.next)
    return outcome
  }

  updateSettings(partial: Partial<LearnSettings>): void {
    const prev = this.state.value
    const merged: LearnProgressV1 = {
      ...prev,
      settings: { ...prev.settings, ...partial },
    }
    this.writeAndPublish(merged)
  }

  // Convenience read helpers. UI subscribes to `state` directly and derives
  // whatever it needs; these are for callsites that want a one-shot read
  // without a subscribe/unsubscribe dance.
  get streakDays(): number {
    return this.state.value.streak.days
  }
  get xp(): number {
    return this.state.value.xp.total
  }
  get settings(): LearnSettings {
    return this.state.value.settings
  }

  // Replace state entirely. Used by tests and any future "reset all progress"
  // affordance. No partial — we want the schema to pass through migrate on
  // the next load, so callers supply the whole shape.
  overwrite(next: LearnProgressV1): void {
    this.writeAndPublish(next)
  }

  private writeAndPublish(next: LearnProgressV1): void {
    this.persisted.save(next)
    this.state.set(next)
  }
}
