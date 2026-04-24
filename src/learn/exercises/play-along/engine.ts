import type { BusNoteEvent } from '../../../core/input/InputBus'
import type { AppServices } from '../../../core/services'
import { Signal } from '../../../store/state'
import type { LearnState } from '../../core/LearnState'
import { type LoopRegion, makeRegionFromBars, ramp, wrapIfAtEnd } from '../../engines/LoopRegion'
import { PracticeEngine } from '../../engines/PracticeEngine'

// Runtime state for the Play-Along exercise. Composes wait-mode (PracticeEngine)
// with a loop-region + tempo-ramp layer on top. Kept separate from the UI so
// the state machine can be reasoned about (and tested) without touching DOM.
//
// Lifecycle: `attach(midi)` loads the piece, `setEnabled(true)` turns wait
// mode on, and the engine drives the clock from that point forward.
// `detach()` releases everything back to the host (App continues playback
// as-is when the exercise unmounts).

export type HandFilter = 'left' | 'right' | 'both'
export const DEFAULT_SPEED_PRESETS = [60, 80, 100] as const

export interface EngineOptions {
  services: AppServices
  // Learn's own transport state. The engine drives `status` here (not
  // `services.store.status`) so Play's transport isn't disturbed while an
  // exercise is running.
  learnState: LearnState
  // Called when the user completes a clean pass of the loop region. The
  // exercise passes this to the ramp controller and fires celebration UI.
  onCleanPass?: () => void
}

export class PlayAlongEngine {
  readonly practice: PracticeEngine
  readonly loopRegion = new Signal<LoopRegion | null>(null)
  readonly speedPct = new Signal<number>(100)
  readonly hand = new Signal<HandFilter>('both')
  readonly tempoRampEnabled = new Signal<boolean>(false)
  // Consecutive clean passes at the current preset — reset on a miss. Drives
  // the ramp() picker when tempo-ramp is enabled.
  readonly cleanPasses = new Signal<number>(0)
  // Human-visible counters for the HUD; also the source the Result pulls
  // from on exit.
  readonly hits = new Signal<number>(0)
  readonly misses = new Signal<number>(0)
  // Transport mirrors for the HUD. `userWantsToPlay` is the source of truth
  // for the play/pause icon — it stays true across wait-mode pauses so the
  // button doesn't flicker between play and pause glyphs every chord. The
  // lower-level `isPlaying` (clock actually advancing) is still exposed in
  // case a future UI wants to show a finer-grained "waiting…" state.
  readonly userWantsToPlay = new Signal<boolean>(false)
  readonly isPlaying = new Signal<boolean>(false)
  readonly currentTime = new Signal<number>(0)
  readonly duration = new Signal<number>(0)

  private unsubs: Array<() => void> = []
  private active = false
  // Cached MIDI so `setHand` can re-run `applyHand` without reaching into
  // `PracticeEngine`'s internals. Cleared on `detach` to avoid leaking a
  // reference after the exercise unmounts.
  private currentMidi: import('../../../core/midi/types').MidiFile | null = null

  constructor(private opts: EngineOptions) {
    this.practice = new PracticeEngine(opts.services.clock, {
      onWaitStart: () => {
        // Wait-mode is a transport-level pause: halt the clock AND flip
        // `learnState.status` so `LearnController`'s status listener
        // releases the synth. Without the status flip, the synth keeps
        // scheduling notes past a paused clock and drifts out of sync.
        this.opts.services.clock.pause()
        this.opts.learnState.pausePlayback()
      },
      onWaitEnd: (resumeAt) => {
        // Always seek so internal state + scheduler align, but only resume
        // transport if the user actually wants playback. This path fires in
        // two cases: (a) the user completed a chord — userWantsToPlay is
        // true, we resume; (b) the user disabled wait mode while we were
        // holding the clock — they may also have hit pause, and restarting
        // playback without their intent would surprise them.
        this.opts.services.clock.seek(resumeAt)
        if (this.userWantsToPlay.value) {
          this.opts.services.clock.play()
          this.opts.learnState.startPlaying()
        }
      },
    })
  }

  attach(midi: import('../../../core/midi/types').MidiFile | null): void {
    this.active = true
    this.currentMidi = midi
    const { services, learnState } = this.opts

    // Start from a known-still transport: pause clock + flip status so the
    // synth listener releases audio, then seek. Doing this BEFORE
    // `practice.loadMidi` means `practice.recomputeNextStep` computes against
    // the seeded time rather than a stale clock. On first entry this is what
    // makes wait-mode engage at the first chord instead of skipping past it.
    services.clock.pause()
    learnState.pausePlayback()

    const seed = learnState.currentTime.value
    const initial = midi && seed <= midi.duration ? seed : 0
    services.clock.seek(initial)
    learnState.setCurrentTime(initial)

    // Now build practice steps + apply filters against the correct time.
    this.practice.loadMidi(midi)
    this.applyHand(midi)
    this.applySpeed()
    this.duration.set(midi?.duration ?? 0)
    this.currentTime.set(initial)

    // Subscribe to the clock so loop-wrap + currentTime + isPlaying mirror
    // stay live. Kept internal so the exercise doesn't have to re-subscribe.
    this.unsubs.push(
      services.clock.subscribe((t) => this.onTick(t)),
      learnState.status.subscribe((s) => {
        this.isPlaying.set(s === 'playing')
      }),
    )
  }

  detach(): void {
    this.active = false
    this.currentMidi = null
    this.userWantsToPlay.set(false)
    for (const off of this.unsubs) off()
    this.unsubs = []
    // Stop the transport so leaving Play-Along doesn't leave scheduled MIDI
    // playing in the background.
    this.opts.services.clock.pause()
    this.opts.learnState.pausePlayback()
    this.practice.setEnabled(false)
    this.practice.dispose()
    // Restore the clock speed we potentially scaled down.
    this.opts.services.clock.speed = 1
    this.opts.services.synth.setSpeed(1)
  }

  // ── Transport controls exposed to the HUD ─────────────────────────────

  play(): void {
    if (!this.active) return
    this.userWantsToPlay.set(true)
    const { services, learnState } = this.opts
    // Reset any stale wait state from a prior session of this same exercise
    // (pause → play cycle). Without this, `practice.waiting=true` survives
    // the pause and the first clock tick after play early-returns on the
    // `if (waiting) return` guard — clock runs past every chord without
    // engaging wait again. `notifySeek` releases internal wait state and
    // recomputes `nextStepIdx` at the current clock position.
    this.practice.notifySeek(services.clock.currentTime)
    // Status BEFORE clock. `clock.play()` fires its first tick synchronously;
    // that tick can engage wait-mode (which pauses the clock and flips
    // status back to paused). Doing `startPlaying` *first* means synth.play
    // is already in flight when that flip hits — the SynthEngine generation
    // guard then aborts synth.play cleanly. Reversing this order leaves
    // synth.play firing after the wait engages, playing audio while the
    // clock sits frozen.
    learnState.startPlaying()
    services.clock.play()
  }

  pause(): void {
    this.userWantsToPlay.set(false)
    this.opts.services.clock.pause()
    this.opts.learnState.pausePlayback()
  }

  togglePlay(): void {
    if (this.userWantsToPlay.value) this.pause()
    else this.play()
  }

  // Seek to an absolute time. Wraps synth + practice re-arm so downstream
  // consumers see a consistent "we're now at T" transition instead of
  // having to chase each component separately.
  seek(time: number): void {
    const clamped = Math.max(0, Math.min(this.duration.value || time, time))
    const wasPlaying = this.userWantsToPlay.value
    const { services, learnState } = this.opts
    // Always pause first — synth.seek repositions the schedule cleanly from
    // a paused state and avoids a flurry of "notes played twice" glitches.
    services.clock.pause()
    learnState.pausePlayback()
    services.clock.seek(clamped)
    services.synth.seek(clamped)
    learnState.setCurrentTime(clamped)
    this.practice.notifySeek(clamped)
    this.currentTime.set(clamped)
    if (wasPlaying) {
      services.clock.play()
      learnState.startPlaying()
    }
  }

  // Input coming from the shared InputBus. Feeds the practice engine which
  // handles its own "is this the right pitch?" gate.
  onNoteOn(evt: BusNoteEvent): void {
    if (!this.active) return
    const result = this.practice.notePressed(evt.pitch)
    if (result === 'advanced') {
      // Only the final chord-completing press bumps hits — partial-correct
      // presses are 'accepted' and stay silent. Otherwise a 3-note chord
      // would tick hits 3× while a wrong note would tick misses 1×, and the
      // score would look generous even for a sloppy performance.
      this.hits.set(this.hits.value + 1)
    } else if (result === 'rejected' && this.practice.isWaiting) {
      // Waiting + pitch rejected = wrong press while waiting. Counts as a
      // miss against the step but doesn't block the user from trying again.
      this.misses.set(this.misses.value + 1)
      // A miss breaks the current clean-pass streak.
      this.cleanPasses.set(0)
    }
  }

  setWaitEnabled(enabled: boolean): void {
    this.practice.setEnabled(enabled)
  }

  setSpeedPreset(pct: number): void {
    this.speedPct.set(pct)
    this.applySpeed()
  }

  setHand(filter: HandFilter): void {
    this.hand.set(filter)
    this.applyHand(this.currentMidi)
  }

  setTempoRamp(enabled: boolean): void {
    this.tempoRampEnabled.set(enabled)
    if (enabled) this.applyRampedSpeed()
  }

  // Set or clear the loop region. Exercise HUD calls this on `L` press or
  // explicit clear. `null` disables looping.
  setLoopFromBars(
    bars: number | null,
    playhead: number,
    pieceDuration: number,
    bpm: number,
  ): LoopRegion | null {
    const region = bars === null ? null : makeRegionFromBars(playhead, bars, bpm, pieceDuration)
    this.loopRegion.set(region)
    return region
  }

  clearLoop(): void {
    this.loopRegion.set(null)
  }

  // ── Internal ───────────────────────────────────────────────────────────

  private applySpeed(): void {
    const base = this.speedPct.value / 100
    this.opts.services.clock.speed = base
    this.opts.services.synth.setSpeed(base)
  }

  // With tempo ramp enabled, cleanPasses bumps the preset index; we mirror
  // that into the `speedPct` signal so the HUD re-renders consistently.
  private applyRampedSpeed(): void {
    const next = ramp(this.cleanPasses.value, [...DEFAULT_SPEED_PRESETS])
    if (next !== this.speedPct.value) {
      this.speedPct.set(next)
      this.applySpeed()
    }
  }

  // Hand split helper. Uses MIDI C4 (60) as the divider when the hand filter
  // is 'left' or 'right' — matches the pitch-split default from the plan.
  // For MIDIs with clean left/right track separation, a future pass will
  // read the per-track metadata; pitch-split is the conservative default.
  private applyHand(midi: import('../../../core/midi/types').MidiFile | null): void {
    if (!midi) return
    const filter = this.hand.value
    if (filter === 'both') {
      this.practice.setVisibleTracks(null)
      return
    }
    // We don't mute tracks wholesale (the full roll still plays); instead we
    // ask the practice engine to only wait on notes that fall in the chosen
    // hand. The rest keep playing from the MIDI but don't gate the clock.
    // Done via `setVisibleTracks` passing a filtered track list — the
    // engine's `rebuildSteps` then only builds wait-points from those tracks.
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
    // Mirror currentTime so the HUD scrubber tracks playback without
    // subscribing to the low-level clock directly.
    this.currentTime.set(time)
    // Auto-stop at the end of the piece. Without this the clock just keeps
    // advancing forever, the scrubber pins to 100%, and the exercise looks
    // hung.
    const dur = this.duration.value
    if (dur > 0 && time >= dur && this.isPlaying.value) {
      this.pause()
      this.opts.services.clock.seek(dur)
      return
    }
    const region = this.loopRegion.value
    if (!region) return
    const wrapTo = wrapIfAtEnd(time, region)
    if (wrapTo !== null) {
      this.opts.services.clock.seek(wrapTo)
      this.opts.services.synth.seek(wrapTo)
      // Reaching end of loop with no mid-pass miss = clean pass. Bump the
      // counter + celebrate; ramp-speed picks it up if enabled.
      this.cleanPasses.set(this.cleanPasses.value + 1)
      this.opts.onCleanPass?.()
      if (this.tempoRampEnabled.value) this.applyRampedSpeed()
    }
  }
}

function averagePitch(notes: { pitch: number }[]): number {
  if (notes.length === 0) return 60
  let sum = 0
  for (const n of notes) sum += n.pitch
  return sum / notes.length
}
