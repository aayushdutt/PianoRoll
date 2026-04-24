import type { BusNoteEvent } from '../../../core/input/InputBus'
import type { Exercise, ExerciseDescriptor } from '../../core/Exercise'
import type { ExerciseContext } from '../../core/ExerciseContext'
import type { ExerciseResult } from '../../core/Result'
import { computeXp } from '../../core/scoring'
import { DEFAULT_LOOP_PRESETS } from '../../engines/LoopRegion'
import { DEFAULT_SPEED_PRESETS, PlayAlongEngine } from './engine'
import { PlayAlongHud } from './hud'

export const playAlongDescriptor: ExerciseDescriptor = {
  id: 'play-along',
  title: 'Play along',
  category: 'play-along',
  difficulty: 'beginner',
  blurb:
    'Drop a MIDI and play along. Wait-mode pauses at each chord until you hit the right notes.',
  factory: (ctx) => new PlayAlongExercise(ctx),
}

// Synthesia-class play-along. Composes PracticeEngine (wait mode), LoopRegion
// helpers (loop set/clear + wrap + ramp), and a shared LearnOverlay (target
// zone + loop band) behind a single Exercise surface. Reads the MIDI from
// the shared app store — it must be loaded before launch; the hub gates the
// card when it isn't.
class PlayAlongExercise implements Exercise {
  readonly descriptor = playAlongDescriptor
  private engine: PlayAlongEngine
  private hud: PlayAlongHud
  private loopPresetIdx = -1 // -1 = loop off
  // Signal subscriptions owned for the lifetime of a single mount → stop
  // cycle. Flushed on stop so a relaunch doesn't accumulate dangling refs
  // to a previous overlay / engine.
  private unsubs: Array<() => void> = []

  constructor(private ctx: ExerciseContext) {
    this.engine = new PlayAlongEngine({
      services: ctx.services,
      learnState: ctx.learnState,
      onCleanPass: () => this.onCleanPass(),
    })
    this.hud = new PlayAlongHud({
      engine: this.engine,
      onCloseExercise: () => this.ctx.onClose('abandoned'),
      onCycleLoop: () => this.cycleLoop(),
      onClearLoop: () => this.clearLoop(),
    })
  }

  mount(host: HTMLElement): void {
    this.hud.mount(host)
    const midi = this.ctx.learnState.loadedMidi.value
    if (midi) {
      // Re-render the loaded MIDI on the roll — LearnController's `enter`
      // cleared it, so Play-Along restores it on launch.
      this.ctx.services.renderer.loadMidi(midi)
    }
    // Paint the target zone right away so the visual language is established
    // before the first note arrives.
    this.ctx.overlay.pulseTargetZone(this.ctx.services.renderer.currentTheme.nowLine)
  }

  start(): void {
    const midi = this.ctx.learnState.loadedMidi.value
    this.engine.attach(midi)
    // Wait mode is default-on for Play-Along.
    this.engine.setWaitEnabled(true)
    // Auto-start the transport — the user landed here from a "start
    // practice" click, so they expect playback to begin. Wait-mode
    // will immediately halt at the first chord onset; without this the
    // clock stays frozen at t=0 and clicking a key does nothing visible
    // because no step has engaged yet.
    this.engine.play()
    // Fold the engine's loop region into the overlay band whenever it
    // changes. Kept here rather than inside the engine so the engine stays
    // DOM/PixiJS-free. Subscription is tracked so `stop` can tear it down —
    // without that, a relaunch leaks a subscriber pointing at a
    // torn-down overlay.
    this.ctx.overlay.drawLoopBand(null)
    this.unsubs.push(
      this.engine.loopRegion.subscribe((region) => {
        if (!region) {
          this.ctx.overlay.drawLoopBand(null)
        } else {
          this.ctx.overlay.drawLoopBand({
            startTime: region.start,
            endTime: region.end,
            color: 0xf3c36c, // amber
          })
        }
      }),
    )
    // Keyboard shortcuts. Kept local to the exercise — removed on stop so
    // they don't bleed into the hub or other modes.
    window.addEventListener('keydown', this.onKeyDown)
  }

  stop(): void {
    window.removeEventListener('keydown', this.onKeyDown)
    for (const off of this.unsubs) off()
    this.unsubs = []
    this.engine.detach()
  }

  unmount(): void {
    this.hud.unmount()
    this.ctx.overlay.drawLoopBand(null)
  }

  onNoteOn(evt: BusNoteEvent): void {
    this.engine.onNoteOn(evt)
    if (this.engine.practice.isWaiting === false) {
      // A press that advanced past the wait or landed without one is "good":
      // pulse the target zone in the accent color.
      this.ctx.overlay.pulseTargetZone(0xfbd38d)
    }
  }

  result(): ExerciseResult | null {
    const hits = this.engine.hits.value
    const misses = this.engine.misses.value
    const attempts = hits + misses
    // No meaningful session without attempts — runner will still count the
    // time against abandonment analytics but won't commit progress.
    if (attempts === 0) return null
    const accuracy = hits / attempts
    // Coarse per-pitch weak-spot summary isn't available from PracticeEngine
    // today (it tracks "pending pitches" not "which pitch missed"), so we
    // report zero weak spots for Play-Along; the Phase 2 exercises that do
    // per-note classification will populate this.
    return {
      exerciseId: this.descriptor.id,
      duration_s: 0, // runner computes real duration from Session
      accuracy,
      xp: computeXp({ accuracy, duration_s: 60, difficultyWeight: 1 }),
      weakSpots: [],
      completed: true,
    }
  }

  // ── Local helpers ─────────────────────────────────────────────────────

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return
    const target = e.target as HTMLElement | null
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
    if (e.code === 'KeyL') {
      e.preventDefault()
      this.cycleLoop()
    } else if (e.code === 'BracketLeft') {
      e.preventDefault()
      this.stepSpeed(-1)
    } else if (e.code === 'BracketRight') {
      e.preventDefault()
      this.stepSpeed(1)
    }
  }

  private cycleLoop(): void {
    const midi = this.ctx.learnState.loadedMidi.value
    if (!midi) return
    // Advance through presets; one past the end disables.
    this.loopPresetIdx = (this.loopPresetIdx + 1) % (DEFAULT_LOOP_PRESETS.length + 1)
    if (this.loopPresetIdx === DEFAULT_LOOP_PRESETS.length) {
      this.engine.clearLoop()
      return
    }
    const preset = DEFAULT_LOOP_PRESETS[this.loopPresetIdx]!
    this.engine.setLoopFromBars(
      preset.bars,
      this.ctx.services.clock.currentTime,
      midi.duration,
      midi.bpm,
    )
  }

  private clearLoop(): void {
    this.loopPresetIdx = -1
    this.engine.clearLoop()
  }

  private stepSpeed(delta: number): void {
    // Widen `DEFAULT_SPEED_PRESETS` from the `as const` tuple type to `number[]`
    // here — `indexOf` on a mutable-looking copy is the clean path even though
    // the values are readonly in the source.
    const presets: number[] = [...DEFAULT_SPEED_PRESETS]
    const idx = presets.indexOf(this.engine.speedPct.value)
    const next = presets[Math.max(0, Math.min(presets.length - 1, idx + delta))]
    if (next !== undefined) this.engine.setSpeedPreset(next)
  }

  private onCleanPass(): void {
    // Subtle swell at the now-line — no sound, just a breath.
    const viewport = this.ctx.services.renderer.currentViewport
    this.ctx.overlay.celebrationSwell(viewport.config.canvasWidth / 2, viewport.nowLineY, 0xfbd38d)
  }
}
