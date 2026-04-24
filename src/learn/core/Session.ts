import type { WeakSpot } from './Result'
import { accuracy } from './scoring'

// Per-exercise run state. The runner creates one of these at `start`,
// exercises call `hit` / `miss` during play, and the runner converts it into
// an ExerciseResult on exit. Kept deliberately tiny — per-pitch breakdowns
// and timing histograms are exercise-specific and live on each exercise's
// own internal state.
export class Session {
  private hits = 0
  private missesByPitch = new Map<number, number>()
  private startMs = 0
  private endMs = 0
  // Wall-clock ms the timer spent paused (e.g. wait-mode holding the clock).
  // Subtracted from the duration so a player who answered the door mid-drill
  // doesn't get credited for 10 min of "practice".
  private pausedAccumMs = 0
  private pausedSinceMs: number | null = null

  constructor(private now: () => number = () => Date.now()) {}

  start(): void {
    this.hits = 0
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

  hit(): void {
    this.hits++
  }

  miss(pitch: number, _expected?: number): void {
    this.missesByPitch.set(pitch, (this.missesByPitch.get(pitch) ?? 0) + 1)
  }

  end(): void {
    if (this.endMs !== 0) return
    if (this.pausedSinceMs !== null) this.resume()
    this.endMs = this.now()
  }

  // Snapshot read — safe to call before `end`. Useful for HUD counters.
  get hitCount(): number {
    return this.hits
  }
  get missCount(): number {
    let total = 0
    for (const n of this.missesByPitch.values()) total += n
    return total
  }
  get attempts(): number {
    return this.hitCount + this.missCount
  }
  get accuracy(): number {
    return accuracy(this.hitCount, this.attempts)
  }
  // Seconds. If `end` hasn't been called, reports up-to-now elapsed.
  get duration_s(): number {
    const end = this.endMs || this.now()
    let paused = this.pausedAccumMs
    if (this.pausedSinceMs !== null) paused += this.now() - this.pausedSinceMs
    return Math.max(0, (end - this.startMs - paused) / 1000)
  }

  // Collapse per-pitch misses into the heatmap-shaped WeakSpot array used
  // by the Result and downstream heatmap updater.
  weakSpots(): WeakSpot[] {
    const out: WeakSpot[] = []
    for (const [pitch, count] of this.missesByPitch) {
      out.push({ pitch, count })
    }
    return out
  }
}
