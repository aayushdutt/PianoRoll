// Play-along exercise — Exercise integration class.
// Composes PracticeEngine (wait-mode), LoopRegion helpers (loop set/clear +
// wrap + ramp), and a shared LearnOverlay (target zone + loop band) against
// the Exercise interface consumed by the learn runner. Reads the MIDI from
// LearnState (loaded before launch); the hub gates the start-card when none
// is loaded.

import { getContext } from 'tone'
import type { BusNoteEvent } from '../../../core/input/InputBus'
import { t } from '../../../i18n'
import { watch } from '../../../store/watch'
import type { Exercise, ExerciseDescriptor } from '../../core/Exercise'
import type { ExerciseContext } from '../../core/ExerciseContext'
import { createExerciseHarness } from '../../core/exerciseHarness'
import { isKeyboardShortcutIgnored } from '../../core/keyboard'
import type { ExerciseResult } from '../../core/Result'
import { standardResult } from '../../core/resultHelpers'
import { DEFAULT_SPEED_PRESETS, PlayAlongEngine } from './engine'
import { createPlayAlongHud, type PlayAlongHudOptions } from './hud'

// Aggressive Tone scheduler headroom while Play-Along is active — 5 ms,
// roughly an order of magnitude below Tone's 100 ms default. Pairs with
// `ENGAGE_LEAD_SEC = 0.01` in `PracticeEngine.ts` (5 ms of safety margin)
// to keep the visible "wait engaged" gap to ~one frame. Snapshot + restore
// around the session so Play / Live keep the default headroom — they don't
// need the tight pairing and the default is more forgiving on weaker
// machines under CPU pressure.
const PLAY_ALONG_LOOK_AHEAD_SEC = 0.005

export const playAlongDescriptor: ExerciseDescriptor = {
  id: 'play-along',
  // `title` / `blurb` are getters so the hub re-reads them after a locale
  // flip — the descriptor object itself is constructed once at module load.
  get title() {
    return t('learn.exercise.playAlong.title')
  },
  category: 'play-along',
  difficulty: 'beginner',
  get blurb() {
    return t('learn.exercise.playAlong.blurb')
  },
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
  private hud: ReturnType<typeof createPlayAlongHud>
  private readonly hudOpts: PlayAlongHudOptions
  private harness: ReturnType<typeof createExerciseHarness>
  private prevLookAhead: number | null = null
  private unsubs: Array<() => void> = []

  constructor(private ctx: ExerciseContext) {
    this.engine = new PlayAlongEngine({
      services: ctx.services,
      learnState: ctx.learnState,
      onCleanPass: () => this.onCleanPass(),
    })
    this.hud = createPlayAlongHud()
    this.hudOpts = {
      engine: this.engine,
      onMarkLoop: () => this.markLoop(),
      onClearLoop: () => this.clearLoop(),
    }
    this.harness = createExerciseHarness({
      hud: this.hud,
      hudOpts: this.hudOpts,
      onKeyDown: this.onKeyDown,
    })
  }

  mount(host: HTMLElement): void {
    this.harness.mountHud(host)
    const midi = this.ctx.learnState.state.loadedMidi
    if (midi) {
      this.ctx.services.renderer.loadMidi(midi)
    }
    this.ctx.overlay.pulseTargetZone(this.ctx.services.renderer.currentTheme.nowLine)
  }

  start(): void {
    try {
      const ctx = getContext()
      this.prevLookAhead = ctx.lookAhead
      ctx.lookAhead = PLAY_ALONG_LOOK_AHEAD_SEC
    } catch {
      this.prevLookAhead = null
    }
    const midi = this.ctx.learnState.state.loadedMidi
    this.engine.attach(midi)
    this.engine.setWaitEnabled(true)
    this.ctx.overlay.drawLoopBand(null)
    this.unsubs.push(
      watch(
        () => this.engine.state.loopRegion,
        (region) => {
          if (!region) {
            this.ctx.overlay.drawLoopBand(null)
          } else {
            this.ctx.overlay.drawLoopBand({
              startTime: region.start,
              endTime: region.end,
              color: 0xf3c36c,
            })
          }
        },
      ),
      this.engine.practice.status.subscribe((status) => {
        if (!status.waiting) {
          this.ctx.services.renderer.setPracticeHints(null, null)
          return
        }
        this.ctx.services.renderer.setPracticeHints(status.pending, status.accepted)
      }),
    )
    this.engine.play()
    this.harness.attachKeys()
  }

  stop(): void {
    this.harness.detachKeys()
    for (const off of this.unsubs) off()
    this.unsubs = []
    this.ctx.services.renderer.setPracticeHints(null, null)
    this.engine.detach()
    if (this.prevLookAhead !== null) {
      try {
        getContext().lookAhead = this.prevLookAhead
      } catch {
        // Best effort.
      }
      this.prevLookAhead = null
    }
  }

  unmount(): void {
    this.harness.unmountHud()
    this.ctx.overlay.drawLoopBand(null)
    this.ctx.services.renderer.setPracticeHints(null, null)
  }

  onNoteOn(evt: BusNoteEvent): void {
    const kind = this.engine.onNoteOn(evt)
    if (kind === 'advanced') {
      this.ctx.log.hit(evt.pitch)
    } else if (kind === 'rejected') {
      this.ctx.log.error()
    }
    if (this.engine.practice.isWaiting === false) {
      // A press that advanced past the wait or landed without one is "good":
      // pulse the target zone in the accent color.
      this.ctx.overlay.pulseTargetZone(0xfbd38d)
    }
  }

  onNoteOff(evt: BusNoteEvent): void {
    // Routed so the engine can maintain its `pressedPitches` set for the
    // legato held-tick bonus. No score side-effect on its own.
    this.engine.onNoteOff(evt)
  }

  result(): ExerciseResult | null {
    return standardResult({
      exerciseId: this.descriptor.id,
      hits: this.engine.state.perfect + this.engine.state.good,
      misses: this.engine.state.errors,
      difficultyWeight: 1,
      completed: true,
    })
  }

  // ── Local helpers ─────────────────────────────────────────────────────

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.shiftKey || isKeyboardShortcutIgnored(e)) return
    if (e.code === 'KeyL') {
      e.preventDefault()
      this.markLoop()
    } else if (e.code === 'BracketLeft') {
      e.preventDefault()
      this.stepSpeed(-1)
    } else if (e.code === 'BracketRight') {
      e.preventDefault()
      this.stepSpeed(1)
    }
  }

  // Mark-style loop: idle → mark A → mark B (loops) → clear. The HUD button
  // and the `L` shortcut both route here so the two stay in sync.
  private markLoop(): void {
    if (!this.ctx.learnState.state.loadedMidi) return
    this.engine.markLoopPoint(this.ctx.services.clock.currentTime)
  }

  private clearLoop(): void {
    this.engine.clearLoop()
  }

  private stepSpeed(delta: number): void {
    const idx = (DEFAULT_SPEED_PRESETS as readonly number[]).indexOf(this.engine.state.speedPct)
    const next = idx >= 0 ? DEFAULT_SPEED_PRESETS[idx + delta] : undefined
    if (next !== undefined) this.engine.setSpeedPreset(next)
  }

  private onCleanPass(): void {
    // Subtle swell at the now-line — no sound, just a breath.
    const viewport = this.ctx.services.renderer.currentViewport
    if (viewport) {
      this.ctx.overlay.celebrationSwell(
        viewport.config.canvasWidth / 2,
        viewport.nowLineY,
        0xfbd38d,
      )
    }
  }
}
