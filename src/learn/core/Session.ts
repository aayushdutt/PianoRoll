import type { WeakSpot } from './Result'
import { accuracy } from './scoring'

// Per-exercise run state. The runner creates one of these at `start`;
// exercises call `hit` / `miss` / `error` / `tickHeld`; the runner converts
// it into an ExerciseResult on exit. Verdict-aware counters serve graded
// exercises; ungraded exercises that just call `hit()` (no args) land in
// the `good` bucket and still get streak credit.
export class Session {
  private perfect = 0
  private good = 0
  private errors = 0
  private held = 0
  private currentStreak = 0
  private bestStreak = 0
  private missesByPitch = new Map<number, number>()
  private startMs = 0
  private endMs = 0
  // Subtracted from `duration_s` so a player who steps away mid-drill
  // doesn't get credited for 10 min of "practice".
  private pausedAccumMs = 0
  private pausedSinceMs: number | null = null

  constructor(private now: () => number = () => Date.now()) {}

  start(): void {
    this.perfect = 0
    this.good = 0
    this.errors = 0
    this.held = 0
    this.currentStreak = 0
    this.bestStreak = 0
    this.missesByPitch.clear()
    this.startMs = this.now()
    this.endMs = 0
    this.pausedAccumMs = 0
    this.pausedSinceMs = null
  }

  pause(): void {
    if (this.pausedSinceMs !== null) return
    this.pausedSinceMs = this.now()
  }

  resume(): void {
    if (this.pausedSinceMs === null) return
    this.pausedAccumMs += this.now() - this.pausedSinceMs
    this.pausedSinceMs = null
  }

  hit(verdict: 'perfect' | 'good' = 'good'): void {
    if (verdict === 'perfect') this.perfect++
    else this.good++
    this.currentStreak++
    if (this.currentStreak > this.bestStreak) this.bestStreak = this.currentStreak
  }

  // Wrong-pitch press. Distinguished from `miss(pitch)` (heatmap-shaped,
  // pitch-attributed) — `error` is just a counted press-event.
  error(): void {
    this.errors++
    this.currentStreak = 0
  }

  // Heatmap-shaped failure. `expected` is the pitch the user *meant* to
  // press if known (sight-read can tell, wait-mode usually can't).
  miss(pitch: number, _expected?: number): void {
    this.missesByPitch.set(pitch, (this.missesByPitch.get(pitch) ?? 0) + 1)
    this.currentStreak = 0
  }

  // Per-tick legato accumulator. `count` is the number of held active
  // notes this tick (1 per held pitch). Caller owns the held-pitch set.
  tickHeld(count: number): void {
    if (count > 0) this.held += count
  }

  end(): void {
    if (this.endMs !== 0) return
    if (this.pausedSinceMs !== null) this.resume()
    this.endMs = this.now()
  }

  // Snapshot reads — safe to call before `end`.
  get perfectCount(): number {
    return this.perfect
  }
  get goodCount(): number {
    return this.good
  }
  get hitCount(): number {
    return this.perfect + this.good
  }
  get errorCount(): number {
    return this.errors
  }
  get heldTicks(): number {
    return this.held
  }
  get streak(): number {
    return this.currentStreak
  }
  get bestStreakSeen(): number {
    return this.bestStreak
  }
  get missCount(): number {
    let total = 0
    for (const n of this.missesByPitch.values()) total += n
    return total
  }
  get attempts(): number {
    return this.hitCount + this.errorCount + this.missCount
  }
  get accuracy(): number {
    return accuracy(this.hitCount, this.attempts)
  }
  // Reports up-to-now elapsed if `end` hasn't been called.
  get duration_s(): number {
    const end = this.endMs || this.now()
    let paused = this.pausedAccumMs
    if (this.pausedSinceMs !== null) paused += this.now() - this.pausedSinceMs
    return Math.max(0, (end - this.startMs - paused) / 1000)
  }

  weakSpots(): WeakSpot[] {
    const out: WeakSpot[] = []
    for (const [pitch, count] of this.missesByPitch) {
      out.push({ pitch, count })
    }
    return out
  }
}
