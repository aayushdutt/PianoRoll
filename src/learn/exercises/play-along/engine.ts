import { batch } from 'solid-js'
import { createStore, type SetStoreFunction } from 'solid-js/store'
import type { BusNoteEvent } from '../../../core/input/InputBus'
import type { AppServices } from '../../../core/services'
import { watch } from '../../../store/watch'
import type { LearnState } from '../../core/LearnState'
import { classifyArticulation } from '../../core/scoring'
import { type LoopRegion, makeRegionFromBars, ramp, wrapIfAtEnd } from '../../engines/LoopRegion'
import { PracticeEngine } from '../../engines/PracticeEngine'

// Composes wait-mode (PracticeEngine) with loop-region + tempo-ramp + a
// graded score model. UI reads off `engine.state.*`; nothing here touches
// the DOM. Lifecycle: `attach(midi)` then `setEnabled(true)`; `detach()` to
// release.

export type HandFilter = 'left' | 'right' | 'both'
export const DEFAULT_SPEED_PRESETS = [60, 80, 100] as const

// Held-bonus eligibility extends this far past a chord's latest scheduled
// note-end. Past it, "still holding" stops earning ticks — the song moved
// on and the user is just leaving fingers down.
const HELD_GRACE_SEC = 0.05

export interface EngineOptions {
  services: AppServices
  // Learn's own transport state, separate from `services.store` so Play's
  // transport isn't disturbed while an exercise runs.
  learnState: LearnState
  onCleanPass?: () => void
}

export interface PlayAlongState {
  // Active loop region (start, end). Null = loop off.
  loopRegion: LoopRegion | null
  // Half-set state for the mark-style UX: A has been placed at this time but
  // B has not. The HUD renders this as a single tick on the scrubber so the
  // user can see their pending mark before completing the pair.
  loopMark: number | null
  speedPct: number
  hand: HandFilter
  tempoRampEnabled: boolean
  cleanPasses: number

  // Score buckets. Wait-mode never punishes below `good` — articulation
  // beyond `PERFECT_ARTICULATION_MS` still clears the chord, just unflashy.
  perfect: number
  good: number
  errors: number
  heldTicks: number
  streak: number

  // `userWantsToPlay` is the source of truth for the play/pause icon —
  // stays true across wait-mode pauses so the button doesn't flicker.
  // `isPlaying` reflects the actual clock state (false during a wait).
  userWantsToPlay: boolean
  isPlaying: boolean
  currentTime: number
  duration: number
}

export class PlayAlongEngine {
  readonly practice: PracticeEngine
  readonly state: PlayAlongState
  readonly setState: SetStoreFunction<PlayAlongState>
  // Exposed so the HUD can subscribe to `services.clock` directly for its
  // 60 Hz imperative scrubber updates — avoids routing the tick through
  // a Solid store, which would re-fire every effect reading `currentTime`.
  readonly services: EngineOptions['services']

  private unsubs: Array<() => void> = []
  private active = false
  // Cached so `setHand` can re-apply filters without touching PracticeEngine
  // internals.
  private currentMidi: import('../../../core/midi/types').MidiFile | null = null

  // Pitches currently held across all input sources, maintained by
  // `onNoteOn`/`onNoteOff`. Intersection with `heldEligible` drives the
  // legato bonus.
  private pressedPitches = new Set<number>()
  // pitch → song-time expiry. Populated on chord clear, pruned per tick.
  private heldEligible = new Map<number, number>()

  constructor(private opts: EngineOptions) {
    this.services = opts.services
    const [state, setState] = createStore<PlayAlongState>({
      loopRegion: null,
      loopMark: null,
      speedPct: 100,
      hand: 'both',
      tempoRampEnabled: false,
      cleanPasses: 0,
      perfect: 0,
      good: 0,
      errors: 0,
      heldTicks: 0,
      streak: 0,
      userWantsToPlay: false,
      isPlaying: false,
      currentTime: 0,
      duration: 0,
    })
    this.state = state
    this.setState = setState

    this.practice = new PracticeEngine(opts.services.clock, {
      onWaitStart: () => {
        // Wait-mode is a transport-level pause: halt the clock AND flip
        // `learnState.status` so `LearnController`'s status listener
        // releases the synth. Without the status flip, the synth keeps
        // scheduling notes past a paused clock and drifts out of sync.
        this.opts.services.clock.pause()
        this.opts.learnState.setState('status', 'paused')
      },
      onWaitEnd: (resumeAt: number) => {
        // Always seek so internal state + scheduler align, but only resume
        // transport if the user actually wants playback.
        this.opts.services.clock.seek(resumeAt)
        if (this.state.userWantsToPlay) {
          this.opts.services.clock.play()
          this.opts.learnState.setState('status', 'playing')
        }
      },
    })
  }

  attach(midi: import('../../../core/midi/types').MidiFile | null): void {
    this.active = true
    this.currentMidi = midi
    const { services, learnState } = this.opts

    // Start from a known-still transport: pause clock + flip status so the
    // synth listener releases audio, then seek.
    services.clock.pause()
    learnState.setState('status', 'paused')

    // One-shot seek seed from the live clock (we do not mirror playhead time
    // into `learnState` / engine store at 60 Hz — HUD uses `clock.subscribe`).
    const seed = services.clock.currentTime
    const initial = midi && seed <= midi.duration ? seed : 0
    services.clock.seek(initial)

    // Now build practice steps + apply filters against the correct time.
    this.practice.loadMidi(midi)
    this.applyHand(midi)
    this.applySpeed()
    batch(() => {
      this.setState({ duration: midi?.duration ?? 0, currentTime: initial })
    })

    // Clock tick drives loop-wrap at region boundaries + the held-tick
    // legato accumulator. (`onTick` does not write `currentTime` into the
    // store — see docs/done/SOLID_MIGRATION_PLAN.md §2.) Status watch keeps
    // `isPlaying` aligned with Learn's transport.
    this.unsubs.push(
      services.clock.subscribe((t) => this.onTick(t)),
      watch(
        () => learnState.state.status,
        (s) => this.setState('isPlaying', s === 'playing'),
      ),
    )
  }

  detach(): void {
    this.active = false
    this.currentMidi = null
    this.pressedPitches.clear()
    this.heldEligible.clear()
    this.setState('userWantsToPlay', false)
    for (const off of this.unsubs) off()
    this.unsubs = []
    this.opts.services.clock.pause()
    this.opts.learnState.setState('status', 'paused')
    this.practice.setEnabled(false)
    this.practice.dispose()
    this.opts.services.clock.speed = 1
    this.opts.services.synth.setSpeed(1)
  }

  // ── Transport controls exposed to the HUD ────────────────────────────

  play(): void {
    if (!this.active) return
    this.setState('userWantsToPlay', true)
    const { services, learnState } = this.opts
    this.practice.notifySeek(services.clock.currentTime)
    // Status BEFORE clock: clock.play()'s synchronous first tick may engage
    // wait-mode, which flips status back to paused. Set playing first so
    // synth.play is already in flight; SynthEngine's generation guard
    // aborts cleanly on the flip.
    learnState.setState('status', 'playing')
    services.clock.play()
  }

  pause(): void {
    this.setState('userWantsToPlay', false)
    this.opts.services.clock.pause()
    this.opts.learnState.setState('status', 'paused')
  }

  togglePlay(): void {
    if (this.state.userWantsToPlay) this.pause()
    else this.play()
  }

  seek(time: number): void {
    const clamped = Math.max(0, Math.min(this.state.duration || time, time))
    // Gate resume on the *actual* clock state, not `userWantsToPlay`. In
    // wait-mode the clock is paused while the user holds intent-to-play; if
    // we resumed on intent, every scrub during a wait would briefly fire
    // `clock.play()` → `synth.play()` and bleed audio until PracticeEngine
    // re-engaged the wait at the next chord. Tying it to clock.playing keeps
    // wait-paused scrubs silent — the user presses Play to resume.
    const wasPlaying = this.opts.services.clock.playing
    const { services, learnState } = this.opts
    services.clock.pause()
    learnState.setState('status', 'paused')
    services.clock.seek(clamped)
    services.synth.seek(clamped)
    learnState.setState('currentTime', clamped)
    this.practice.notifySeek(clamped)
    this.setState('currentTime', clamped)
    // A jump invalidates "currently held" semantics — clear the legato
    // window so the user doesn't accumulate ticks for notes that no
    // longer correspond to the new playhead.
    this.heldEligible.clear()
    if (wasPlaying) {
      services.clock.play()
      learnState.setState('status', 'playing')
    }
  }

  onNoteOn(evt: BusNoteEvent): void {
    if (!this.active) return
    this.pressedPitches.add(evt.pitch)
    const outcome = this.practice.notePressed(evt.pitch)
    if (outcome.kind === 'advanced') {
      const verdict = classifyArticulation(outcome.articulationMs)
      const expireAt = outcome.clearedStep.latestEnd + HELD_GRACE_SEC
      for (const pitch of outcome.clearedStep.pitches) {
        this.heldEligible.set(pitch, expireAt)
      }
      batch(() => {
        if (verdict === 'perfect') {
          this.setState('perfect', this.state.perfect + 1)
        } else {
          this.setState('good', this.state.good + 1)
        }
        this.setState('streak', this.state.streak + 1)
      })
    } else if (outcome.kind === 'rejected' && this.practice.isWaiting) {
      batch(() => {
        this.setState({
          errors: this.state.errors + 1,
          streak: 0,
          cleanPasses: 0,
        })
      })
    }
    // `'duplicate'` and `'accepted'` are no-ops by design: a re-strike of
    // an already-cleared pitch isn't an error, and partial-chord progress
    // surfaces via PracticeEngine's `pending`/`accepted` signal — not the
    // score.
  }

  onNoteOff(evt: BusNoteEvent): void {
    if (!this.active) return
    this.pressedPitches.delete(evt.pitch)
  }

  setWaitEnabled(enabled: boolean): void {
    this.practice.setEnabled(enabled)
  }

  setSpeedPreset(pct: number): void {
    this.setState('speedPct', pct)
    this.applySpeed()
  }

  setHand(filter: HandFilter): void {
    this.setState('hand', filter)
    this.applyHand(this.currentMidi)
  }

  setTempoRamp(enabled: boolean): void {
    this.setState('tempoRampEnabled', enabled)
    if (enabled) this.applyRampedSpeed()
  }

  setLoopFromBars(
    bars: number | null,
    playhead: number,
    pieceDuration: number,
    bpm: number,
  ): LoopRegion | null {
    const region = bars === null ? null : makeRegionFromBars(playhead, bars, bpm, pieceDuration)
    batch(() => {
      this.setState('loopRegion', region)
      this.setState('loopMark', null)
    })
    return region
  }

  // Mark-style loop UX: three-state cycle driven by repeated calls.
  //   1st call: place A at `time` (sets `loopMark`, no active region yet).
  //   2nd call: place B at `time` and activate the region (clears `loopMark`,
  //             sets `loopRegion` to the ordered [min,max] of A and B).
  //   3rd call: clear both (loop off, returns to idle).
  // Returns the resulting state for callers that want to react synchronously.
  markLoopPoint(time: number): { region: LoopRegion | null; mark: number | null } {
    const dur = this.state.duration
    const t = Math.max(0, dur > 0 ? Math.min(dur, time) : time)
    if (this.state.loopRegion) {
      // Active → clear.
      batch(() => {
        this.setState('loopRegion', null)
        this.setState('loopMark', null)
      })
      return { region: null, mark: null }
    }
    if (this.state.loopMark === null) {
      // Idle → place A.
      this.setState('loopMark', t)
      return { region: null, mark: t }
    }
    // Half-set → place B and activate. A degenerate same-spot click (within
    // 50 ms — a double-click on the same playhead) clears instead of building
    // a zero-length region the wrap helper would refuse anyway.
    const a = this.state.loopMark
    if (Math.abs(t - a) < 0.05) {
      this.setState('loopMark', null)
      return { region: null, mark: null }
    }
    const region: LoopRegion = { start: Math.min(a, t), end: Math.max(a, t) }
    batch(() => {
      this.setState('loopRegion', region)
      this.setState('loopMark', null)
    })
    return { region, mark: null }
  }

  clearLoop(): void {
    batch(() => {
      this.setState('loopRegion', null)
      this.setState('loopMark', null)
    })
  }

  // ── Internal ──────────────────────────────────────────────────────────

  private applySpeed(): void {
    const base = this.state.speedPct / 100
    this.opts.services.clock.speed = base
    this.opts.services.synth.setSpeed(base)
  }

  private applyRampedSpeed(): void {
    const next = ramp(this.state.cleanPasses, [...DEFAULT_SPEED_PRESETS])
    if (next !== this.state.speedPct) {
      this.setState('speedPct', next)
      this.applySpeed()
    }
  }

  private applyHand(midi: import('../../../core/midi/types').MidiFile | null): void {
    if (!midi) return
    // Clear stale held-eligible entries — switching hands invalidates the
    // current chord's held window because `setVisibleTracks` rebuilds the
    // step list against the new filter.
    this.heldEligible.clear()
    const filter = this.state.hand
    if (filter === 'both') {
      this.practice.setVisibleTracks(null)
      return
    }
    const visible = midi.tracks
      .filter((track) => {
        if (track.isDrum) return false
        const avg = averagePitch(track.notes)
        return filter === 'left' ? avg < 60 : avg >= 60
      })
      .map((t) => t.id)
    this.practice.setVisibleTracks(visible)
  }

  private onTick(time: number): void {
    // Deliberately NOT writing `currentTime` to the store here — at 60 Hz
    // it would re-fire every `createEffect` reading it. The HUD subscribes
    // to `services.clock` directly for the scrubber. (Seek() still writes
    // once to reposition.) See docs/done/SOLID_MIGRATION_PLAN.md §2 rule 4.
    this.tickHeldBonus(time)
    const dur = this.state.duration
    if (dur > 0 && time >= dur && this.state.isPlaying) {
      this.pause()
      this.opts.services.clock.seek(dur)
      return
    }
    const region = this.state.loopRegion
    if (!region) return
    const wrapTo = wrapIfAtEnd(time, region)
    if (wrapTo !== null) {
      this.opts.services.clock.seek(wrapTo)
      this.opts.services.synth.seek(wrapTo)
      // A wrap is a seek — practice has to recompute `nextStepIdx` against
      // the new playhead and reset `earliestRearmTime`, otherwise wait-mode
      // never re-engages on the chords inside the loop (it still thinks
      // it's past them). Same reason scrub calls `notifySeek`.
      this.practice.notifySeek(wrapTo)
      // The held-eligibility window was anchored to chords from the previous
      // pass — invalidate it so the legato bonus doesn't accumulate ticks for
      // notes that no longer correspond to the new playhead.
      this.heldEligible.clear()
      this.setState('cleanPasses', this.state.cleanPasses + 1)
      this.opts.onCleanPass?.()
      if (this.state.tempoRampEnabled) this.applyRampedSpeed()
    }
  }

  // Prune expired entries and accumulate one tick of legato bonus per
  // still-held cleared pitch. Map size is bounded by chord size (~1–6), so
  // the per-tick iteration is negligible.
  private tickHeldBonus(time: number): void {
    if (this.heldEligible.size === 0) return
    let held = 0
    for (const [pitch, expireAt] of this.heldEligible) {
      if (expireAt <= time) {
        this.heldEligible.delete(pitch)
        continue
      }
      if (this.pressedPitches.has(pitch)) held++
    }
    if (held > 0) {
      this.setState('heldTicks', this.state.heldTicks + held)
    }
  }
}

function averagePitch(notes: { pitch: number }[]): number {
  if (notes.length === 0) return 60
  let sum = 0
  for (const n of notes) sum += n.pitch
  return sum / notes.length
}
