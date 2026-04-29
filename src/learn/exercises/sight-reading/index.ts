// Sight-reading exercise — Exercise integration class.
// Wires the SightReadingEngine, SightReadLayer, and SightReadHud together
// and implements the Exercise interface consumed by the learn runner.

import { batch } from 'solid-js'
import type { BusNoteEvent } from '../../../core/input/InputBus'
import { t } from '../../../i18n'
import type { Exercise, ExerciseDescriptor } from '../../core/Exercise'
import type { ExerciseContext } from '../../core/ExerciseContext'
import type { ExerciseResult } from '../../core/Result'
import { accuracy, computeXp } from '../../core/scoring'
import { SightReadingEngine } from './engine'
import { generateNoteSource, TIER_CONFIGS } from './generator'
import { SightReadLayer } from './renderer'
import type { ClefMode, TierConfig, TierKey } from './types'
import { SightReadHud } from './ui'

export function poolForClef(clef: ClefMode, tier: TierConfig): number[] {
  if (clef === 'treble') return [...tier.pitchPool].sort((a, b) => a - b)

  if (clef === 'bass') {
    const bassNotes = tier.pitchPool.map((p) => (p >= 60 ? p - 12 : p))
    return [...new Set(bassNotes)].sort((a, b) => a - b)
  }

  const pool = new Set(tier.pitchPool)
  for (const p of tier.pitchPool) {
    if (p >= 60) pool.add(p - 12)
  }
  return [...pool].sort((a, b) => a - b)
}

export const sightReadingDescriptor: ExerciseDescriptor = {
  id: 'sight-reading',
  get title() {
    return t('learn.exercise.sightReading.title')
  },
  category: 'sight-reading',
  difficulty: 'beginner',
  get blurb() {
    return t('learn.exercise.sightReading.blurb')
  },
  factory: (ctx) => new SightReadingExercise(ctx, 'landmark'),
}

class SightReadingExercise implements Exercise {
  readonly descriptor = sightReadingDescriptor

  private engine: SightReadingEngine
  private staffLayer: SightReadLayer
  private hud: SightReadHud
  private tierKey: TierKey
  private onEscKey: ((e: KeyboardEvent) => void) | null = null

  constructor(
    private ctx: ExerciseContext,
    tierKey: TierKey,
  ) {
    this.tierKey = tierKey
    const tier = TIER_CONFIGS[tierKey]

    this.engine = new SightReadingEngine({
      bpm: tier.defaultBpm,
      bpmRamp: tierKey === 'arcade' ? 0.5 : 0,
      maxBpm: 160,
      lookAheadBeats: 4,
      practiceMode: tierKey !== 'arcade',
    })

    this.staffLayer = new SightReadLayer(this.engine, {
      clef: tier.clef,
      keySignature: tier.keySignature,
      showLabels: false,
    })

    this.hud = new SightReadHud()
  }

  mount(host: HTMLElement): void {
    const tier = TIER_CONFIGS[this.tierKey]

    // Hide the piano-roll note waterfall — the staff layer owns the canvas.
    this.ctx.services.renderer.clearMidi()

    // Register PixiJS layer.
    this.ctx.services.renderer.addLayer(this.staffLayer)

    // Wire the done callback — navigate back when the session ends.
    this.staffLayer.onDone = (reason) => {
      // Keep the HUD visible (end panel) — the user triggers close themselves.
      // We do NOT call onClose here; the end panel CTAs drive that.
      void reason // used by end panel display, not for navigation
    }

    // Mount the HUD.
    this.hud.mount(host, {
      engine: this.engine,
      tier,
      onPlayAgain: () => this._restart(),
      onPracticeWeak: (pitches) => this._restartWithFocus(pitches),
      onClose: () => this.ctx.onClose('abandoned'),
      onRestart: () => this._restart(),
      onClefChange: (clef) => {
        this.staffLayer.setClef(clef)
        this.staffLayer.resetDone()
        this.staffLayer.activeKeys.clear()
        const pool = poolForClef(clef, tier)
        batch(() => {
          this.engine.attach(
            generateNoteSource({ pitchPool: pool, sessionLength: tier.sessionLength }),
          )
          this.engine.start()
        })
      },
    })
  }

  start(): void {
    const tier = TIER_CONFIGS[this.tierKey]

    // Prime the synth for low-latency live playback.
    this.ctx.services.synth.primeLiveInput()

    // Attach note source and start engine.
    this.engine.attach(
      generateNoteSource({
        pitchPool: poolForClef(tier.clef, tier),
        sessionLength: tier.sessionLength,
      }),
    )
    this.engine.start()

    // Escape → pause/resume. [ / ] → tempo −5 / +5 while paused.
    this.onEscKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if (e.code === 'Escape') {
        e.preventDefault()
        if (this.engine.paused) this.engine.resume()
        else this.engine.pause()
      } else if (this.engine.paused) {
        if (e.code === 'BracketLeft') {
          e.preventDefault()
          this.engine.setBpm(this.engine.bpm - 5)
        } else if (e.code === 'BracketRight') {
          e.preventDefault()
          this.engine.setBpm(this.engine.bpm + 5)
        }
      }
    }
    window.addEventListener('keydown', this.onEscKey)
  }

  stop(): void {
    if (this.onEscKey) {
      window.removeEventListener('keydown', this.onEscKey)
      this.onEscKey = null
    }
    this.engine.stop()
  }

  unmount(): void {
    this.ctx.services.renderer.removeLayer(this.staffLayer)
    this.hud.unmount()
  }

  onNoteOn(evt: BusNoteEvent): void {
    const result = this.engine.noteOn(evt.pitch)

    if (result === 'hit') {
      this.ctx.services.synth.liveNoteOn(evt.pitch, 0.8)
      setTimeout(() => this.ctx.services.synth.liveNoteOff(evt.pitch), 400)
      this.ctx.log.hit(evt.pitch)
    } else if (result === 'wrong') {
      this.ctx.log.miss(evt.pitch)
    }

    // Update active keys for ghost display.
    this.staffLayer.activeKeys.add(evt.pitch)
  }

  onNoteOff(evt: BusNoteEvent): void {
    this.staffLayer.activeKeys.delete(evt.pitch)
  }

  result(): ExerciseResult | null {
    const { totalPlayed, perfect, good, missed, phase } = this.engine.state
    if (totalPlayed < 3) return null
    const acc = accuracy(perfect + good, perfect + good + missed)
    return {
      exerciseId: sightReadingDescriptor.id,
      duration_s: 0, // runner computes from Session
      accuracy: acc,
      xp: computeXp({ accuracy: acc, duration_s: 60, difficultyWeight: 1.0 }),
      weakSpots: this._computeWeakSpots(),
      completed: phase === 'complete',
    }
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private _computeWeakSpots() {
    const spots: Array<{ pitch: number; count: number }> = []
    for (const [pitch, { misses }] of this.engine.noteStats) {
      if (misses > 0) {
        spots.push({ pitch, count: misses })
      }
    }
    return spots.sort((a, b) => b.count - a.count).slice(0, 5)
  }

  private _restart(): void {
    const tier = TIER_CONFIGS[this.tierKey]
    const clef = this.staffLayer.currentClef()
    const pool = poolForClef(clef, tier)
    this.staffLayer.resetDone()
    this.staffLayer.activeKeys.clear()
    batch(() => {
      this.engine.attach(
        generateNoteSource({
          pitchPool: pool,
          sessionLength: tier.sessionLength,
        }),
      )
      this.engine.start()
    })
  }

  private _restartWithFocus(pitches: number[]): void {
    const tier = TIER_CONFIGS[this.tierKey]
    const clef = this.staffLayer.currentClef()
    const pool = poolForClef(clef, tier)
    this.staffLayer.resetDone()
    this.staffLayer.activeKeys.clear()
    batch(() => {
      this.engine.attach(
        generateNoteSource({
          pitchPool: pool,
          sessionLength: tier.sessionLength,
          weakNoteFocus: pitches,
        }),
      )
      this.engine.start()
    })
  }
}
