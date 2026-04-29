// PixiJS v8 RenderLayer for the sight-reading exercise.
// Draws staff, scrolling note heads, now-line, active-key ghosts, particle
// bursts, and miss vignette over the roll area (y: 0..rollH).
//
// Layout is recomputed in rebuild(); only dynamic elements (notes, particles,
// now-line) are redrawn every frame in update().

import { Container, Graphics, Text } from 'pixi.js'
import { GlowFilter } from 'pixi-filters'
import type { RenderContext, RenderLayer } from '../../../renderer/RenderLayer'
import type { Theme } from '../../../renderer/theme'
import type { SightReadingEngine } from './engine'
import { bassStaffStep, isAccidental, staffForNote, staffStep, yFromStep } from './music'
import type { ClefMode, StreamNote } from './types'

// ── Types ──────────────────────────────────────────────────────────────────

interface Burst {
  x: number
  y: number
  born: number // performance.now()
  color: number
}

export interface SightReadLayerConfig {
  clef: ClefMode
  keySignature: string
  showLabels: boolean
}

// ── Constants ──────────────────────────────────────────────────────────────

// Staff / note design tokens — these are intentional exercise aesthetics,
// not theme-derived, because the warm printed-music look is part of the exercise
// identity regardless of the ambient piano-roll theme.
const STAFF_COLOR = 0xdcd2be
const STAFF_ALPHA = 0.5
const CLEF_COLOR = 0xc8c0a8
const NOTE_APPROACHING = 0xf0e6d2
const NOTE_IN_WINDOW = 0xffc83c
const NOTE_HIT = 0x50c878
const NOTE_MISSED = 0xdc4646
const BURST_COLOR = 0x50c878
const BURST_DURATION_MS = 500
const VIGNETTE_DURATION_MS = 150
const DONE_ZONE_ALPHA = 0.3

// ── SightReadLayer ─────────────────────────────────────────────────────────

export class SightReadLayer implements RenderLayer {
  readonly id = 'sight-reading-staff'
  readonly zIndex = 5

  // Active keys set — updated by the exercise on noteOn/noteOff.
  activeKeys: Set<number> = new Set()

  // Called once when phase transitions to 'complete' or 'knockedOut'.
  onDone: ((reason: 'completed' | 'knockedOut') => void) | null = null

  private container: Container | null = null
  private bgG: Graphics | null = null
  private staticG: Graphics | null = null
  private dynamicG: Graphics | null = null
  // Now-line lives in its own glow container so the GlowFilter only runs over
  // the thin line rather than the full dynamic layer.
  private nowLineContainer: Container | null = null
  private nowLineG: Graphics | null = null
  private glowFilter: GlowFilter | null = null
  // Clef texts render above dynamicG so the done-zone overlay doesn't dim them.
  private clefContainer: Container | null = null
  private clefTexts: Text[] = []
  // Cached theme for use in update() without ctx.
  private cachedTheme: Theme | null = null

  // Layout (computed in rebuild, read in update)
  nowX = 0
  private staffTop = 0 // treble (or single) staff top
  private staffTop2 = 0 // bass staff top (only when clef === 'both')
  private lineSpacing = 16
  private rollH = 0
  private w = 0

  // Particle bursts (renderer-owned, not engine state)
  private bursts: Burst[] = []
  private lastMissTime = 0

  // Done-emission guard so onDone fires exactly once.
  private doneEmitted = false

  constructor(
    private engine: SightReadingEngine,
    private config: SightReadLayerConfig,
  ) {}

  /** Returns the staff Y coordinate for a given MIDI note (for external callers). */
  noteY(midi: number): number {
    return this._noteY(midi).y
  }

  /** Reset the done-emission guard so a restarted session can fire onDone again. */
  resetDone(): void {
    this.doneEmitted = false
  }

  /** Change clef and rebuild staff geometry immediately. */
  setClef(clef: ClefMode): void {
    if (this.config.clef === clef) return
    this.config.clef = clef
    if (this.w > 0 && this.rollH > 0) {
      this._recomputeLayout()
      this._drawStaticStaff()
      this._rebuildClefTexts()
    }
  }

  /** Current clef (used by exercise to build pitch pools on restart). */
  currentClef(): ClefMode {
    return this.config.clef
  }

  updateConfig(config: Partial<SightReadLayerConfig>): void {
    Object.assign(this.config, config)
  }

  /** Called by exercise on a successful hit — emits a particle burst. */
  emitBurst(x: number, y: number): void {
    this.bursts.push({ x, y, born: performance.now(), color: BURST_COLOR })
  }

  /** Called by exercise on a miss — triggers the edge vignette flash. */
  emitMiss(): void {
    this.lastMissTime = performance.now()
  }

  // ── RenderLayer ──────────────────────────────────────────────────────────

  mount(stage: Container): void {
    const root = new Container()
    root.label = 'sight-read-layer'

    this.bgG = new Graphics()
    this.staticG = new Graphics()
    this.dynamicG = new Graphics()

    // Now-line: isolated container so GlowFilter only processes the thin line.
    this.nowLineG = new Graphics()
    this.glowFilter = new GlowFilter({
      distance: 18,
      outerStrength: 1.2,
      innerStrength: 0,
      color: 0xffffff, // overwritten in rebuild() from theme
      quality: 0.25,
    })
    this.nowLineContainer = new Container()
    this.nowLineContainer.addChild(this.nowLineG)
    this.nowLineContainer.filters = [this.glowFilter]

    // Clef texts above the done-zone overlay.
    this.clefContainer = new Container()

    // Draw order: bg → static staff → dynamic notes/overlay → glow now-line → clef
    root.addChild(this.bgG)
    root.addChild(this.staticG)
    root.addChild(this.dynamicG)
    root.addChild(this.nowLineContainer)
    root.addChild(this.clefContainer)

    stage.addChild(root)
    this.container = root
  }

  unmount(): void {
    this.container?.destroy({ children: true })
    this.container = null
    this.bgG = null
    this.staticG = null
    this.dynamicG = null
    this.nowLineG = null
    this.nowLineContainer = null
    this.glowFilter = null
    this.clefContainer = null
    this.clefTexts = []
    this.bursts = []
    this.doneEmitted = false
    this.cachedTheme = null
  }

  rebuild(ctx: RenderContext): void {
    if (!this.container) return
    this.cachedTheme = ctx.theme
    // Sync glow filter with the current theme's now-line color.
    if (this.glowFilter) {
      this.glowFilter.color = ctx.theme.nowLineGlow
    }
    this._computeLayout(ctx)
    this._drawBackground(ctx.theme)
    this._drawStaticStaff()
    this._rebuildClefTexts()
  }

  update(ctx: RenderContext): void {
    // Advance engine
    this.engine.tick(ctx.dt)

    // Fire onDone once when phase transitions to a terminal state.
    if (!this.doneEmitted) {
      const phase = this.engine.state.phase
      if (phase === 'complete' || phase === 'knockedOut') {
        this.doneEmitted = true
        this.onDone?.(phase === 'complete' ? 'completed' : 'knockedOut')
      }
    }

    if (!this.dynamicG || !this.nowLineG) return
    const g = this.dynamicG
    g.clear()
    // Cache pxPerSec once per frame so it isn't recomputed for every note.
    const pxPerSec = this._pxPerSec()
    this._drawDoneZone(g)
    this._drawActiveKeyGhosts(g)
    this._drawNotes(g, ctx.dt, pxPerSec)
    this._drawBursts(g)
    this._drawMissVignette(g)
    this._drawNowLine(this.nowLineG)
  }

  // ── Layout ───────────────────────────────────────────────────────────────

  private _computeLayout(ctx: RenderContext): void {
    this.w = ctx.viewport.config.canvasWidth
    this.rollH = ctx.viewport.rollHeight
    this._recomputeLayout()
  }

  private _recomputeLayout(): void {
    const rollH = this.rollH
    this.lineSpacing = Math.min(22, Math.max(10, rollH * 0.036))
    const staffHeight = this.lineSpacing * 4

    if (this.config.clef === 'both') {
      const gap = this.lineSpacing * 3
      const totalH = staffHeight * 2 + gap
      this.staffTop = (rollH - totalH) / 2
      this.staffTop2 = this.staffTop + staffHeight + gap
    } else {
      this.staffTop = (rollH - staffHeight) / 2
      this.staffTop2 = this.staffTop
    }

    this.nowX = Math.max(70, this.w * 0.22)
  }

  // ── Static drawing (rebuild) ─────────────────────────────────────────────

  private _drawBackground(theme: Theme): void {
    const g = this.bgG
    if (!g) return
    g.clear()
    g.rect(0, 0, this.w, this.rollH).fill({ color: theme.background, alpha: 1 })
  }

  private _drawStaticStaff(): void {
    const g = this.staticG
    if (!g) return
    g.clear()
    const { w, lineSpacing, staffTop } = this
    // Staff lines span the full canvas width so the clef sits on the same lines.
    const lineLeft = 6
    const lineRight = w - 6

    this._drawFiveLines(g, staffTop, lineLeft, lineRight, lineSpacing)

    if (this.config.clef === 'both') {
      this._drawFiveLines(g, this.staffTop2, lineLeft, lineRight, lineSpacing)
    }
  }

  private _drawFiveLines(g: Graphics, top: number, fromX: number, toX: number, ls: number): void {
    for (let i = 0; i < 5; i++) {
      const y = top + i * ls
      g.moveTo(fromX, y)
        .lineTo(toX, y)
        .stroke({ color: STAFF_COLOR, alpha: STAFF_ALPHA, width: 1.5 })
    }
  }

  private _rebuildClefTexts(): void {
    const cc = this.clefContainer
    if (!cc) return

    for (const t of this.clefTexts) t.destroy()
    this.clefTexts = []

    const { lineSpacing, staffTop, config } = this

    // Clef sits at the very start of the staff lines (x≈12), same as traditional
    // engraving. Rendered above dynamicG so the done-zone overlay never dims it.
    const clefX = 12

    if (config.clef === 'treble' || config.clef === 'both') {
      const fontSize = lineSpacing * 6.5
      const t = new Text({
        text: '𝄞',
        style: { fontFamily: 'serif', fontSize, fill: CLEF_COLOR },
      })
      t.x = clefX
      // Place curl (≈70% down the glyph) on the G4 line (second from bottom = staffTop+3*ls).
      t.y = staffTop + lineSpacing * 3 - fontSize * 0.7
      cc.addChild(t)
      this.clefTexts.push(t)
    }

    if (config.clef === 'bass' || config.clef === 'both') {
      const bassTop = config.clef === 'both' ? this.staffTop2 : staffTop
      const fontSize = lineSpacing * 3.5
      const t = new Text({
        text: '𝄢',
        style: { fontFamily: 'serif', fontSize, fill: CLEF_COLOR },
      })
      t.x = clefX
      // Bass clef: dots align with F line (4th from bottom = bassTop+1*ls in our coord).
      t.y = bassTop + lineSpacing * 0.05
      cc.addChild(t)
      this.clefTexts.push(t)
    }
  }

  // ── Dynamic drawing (update) ─────────────────────────────────────────────

  private _pxPerSec(): number {
    const available = this.w - this.nowX - 16
    return available / this.engine.lookAheadSec
  }

  private _noteY(midi: number): { y: number; step: number; staffTopForNote: number } {
    const { config, staffTop, staffTop2, lineSpacing } = this
    if (config.clef === 'both') {
      const which = staffForNote(midi)
      if (which === 'treble') {
        const step = staffStep(midi)
        return { y: yFromStep(step, staffTop, lineSpacing), step, staffTopForNote: staffTop }
      }
      const step = bassStaffStep(midi)
      return { y: yFromStep(step, staffTop2, lineSpacing), step, staffTopForNote: staffTop2 }
    }
    if (config.clef === 'bass') {
      const step = bassStaffStep(midi)
      return { y: yFromStep(step, staffTop, lineSpacing), step, staffTopForNote: staffTop }
    }
    const step = staffStep(midi)
    return { y: yFromStep(step, staffTop, lineSpacing), step, staffTopForNote: staffTop }
  }

  private _drawNowLine(g: Graphics): void {
    const { nowX, staffTop, staffTop2, lineSpacing, config } = this
    const staffHeight = lineSpacing * 4
    const streak = this.engine.state.streak
    const theme = this.cachedTheme

    const lineTop = staffTop - lineSpacing * 2
    const lineBottom =
      config.clef === 'both'
        ? staffTop2 + staffHeight + lineSpacing * 2
        : staffTop + staffHeight + lineSpacing * 2

    // Scale GlowFilter intensity with streak — the filter does the spreading.
    if (this.glowFilter) {
      this.glowFilter.outerStrength = streak >= 20 ? 3 : streak >= 10 ? 2 : 1.2
    }

    g.clear()
    g.moveTo(nowX, lineTop)
      .lineTo(nowX, lineBottom)
      .stroke({
        color: theme?.nowLine ?? 0xffc83c,
        width: 2,
        alpha: theme ? theme.nowLineAlpha * 5 : 0.9, // nowLineAlpha is very low by default; boost for the line itself
      })

    // High-streak shimmer on staff lines.
    if (streak >= 20 && this.staticG) {
      this.staticG.alpha = 0.75 + Math.sin(this.engine.time * Math.PI * 8) * 0.25
    } else if (this.staticG) {
      this.staticG.alpha = 1
    }
  }

  private _drawDoneZone(g: Graphics): void {
    // Dim the played area to the left of the now-line.
    g.rect(0, 0, this.nowX, this.rollH).fill({ color: 0x000000, alpha: DONE_ZONE_ALPHA })
  }

  private _drawActiveKeyGhosts(g: Graphics): void {
    const { nowX, lineSpacing } = this
    const noteR = lineSpacing * 0.44
    for (const midi of this.activeKeys) {
      const { y } = this._noteY(midi)
      g.circle(nowX, y, noteR).fill({ color: NOTE_IN_WINDOW, alpha: 0.2 })
    }
  }

  private _drawNotes(g: Graphics, dt: number, pxPerSec: number): void {
    const { nowX, w, lineSpacing } = this
    const noteR = lineSpacing * 0.44
    const aheadPx = w - nowX - 16

    for (const note of this.engine.notes) {
      const x = nowX + (note.time - this.engine.time) * pxPerSec
      if (x < -60 || x > w + 60) continue

      const { y, step, staffTopForNote } = this._noteY(note.midi)

      // Auto-emit burst on the first frame after a hit.
      if (note.state === 'hit' && note.hitTime !== undefined) {
        const age = this.engine.time - note.hitTime
        if (age < dt + 0.001) {
          this.emitBurst(x, y)
        }
      }

      // Auto-emit miss vignette on the first frame after a miss.
      if (note.state === 'missed' && note.missTime !== undefined) {
        const age = this.engine.time - note.missTime
        if (age < dt + 0.001) {
          this.emitMiss()
        }
      }

      this._drawNote(g, note, x, y, step, staffTopForNote, noteR, aheadPx)
    }
  }

  private _drawNote(
    g: Graphics,
    note: StreamNote,
    x: number,
    y: number,
    step: number,
    staffTopForNote: number,
    noteR: number,
    aheadPx: number,
  ): void {
    const { lineSpacing } = this

    switch (note.state) {
      case 'approaching': {
        const distFraction = Math.max(0, (x - this.nowX) / aheadPx)
        const alpha = 0.3 + (1 - distFraction) * 0.7

        this._drawLedgerLines(
          g,
          x,
          step,
          staffTopForNote,
          lineSpacing,
          noteR + 5,
          NOTE_APPROACHING,
          alpha,
        )

        // Accidental sign — drawn geometrically (no Text in update()).
        if (isAccidental(note.midi)) {
          this._drawSharp(g, x, y, NOTE_APPROACHING, alpha)
        }

        g.circle(x, y, noteR).fill({ color: NOTE_APPROACHING, alpha })

        // Stem: up if step < 4, down otherwise
        const up = step < 4
        const stemX = up ? x + noteR * 0.88 : x - noteR * 0.88
        const stemLen = lineSpacing * 3.2
        const stemEndY = y + (up ? -stemLen : stemLen)
        g.moveTo(stemX, y)
          .lineTo(stemX, stemEndY)
          .stroke({ color: NOTE_APPROACHING, width: 1.2, alpha })

        break
      }

      case 'in-window': {
        // Pulse scale
        const pulse = 1 + Math.sin(this.engine.time * 8 * Math.PI) * 0.04
        const r = noteR * pulse

        this._drawLedgerLines(
          g,
          x,
          step,
          staffTopForNote,
          lineSpacing,
          noteR + 5,
          NOTE_IN_WINDOW,
          1,
        )
        if (isAccidental(note.midi)) {
          this._drawSharp(g, x, y, NOTE_IN_WINDOW, 1)
        }
        g.circle(x, y, r).fill({ color: NOTE_IN_WINDOW, alpha: 1 })

        // Glow
        g.circle(x, y, r * 2.2).fill({ color: NOTE_IN_WINDOW, alpha: 0.18 })
        break
      }

      case 'hit': {
        if (note.hitTime === undefined) break
        const t = this.engine.time - note.hitTime
        if (t > 0.5) break // cull guard (engine already culls at 0.5)

        // Pop animation: scale up then back
        const pop = t < 0.06 ? 1 + t * 6.5 : 1.4 - (t - 0.06) * 3.5
        const scale = Math.max(0.01, pop)
        const alpha = Math.max(0, 1 - t / 0.3)
        if (alpha <= 0.01) break

        g.circle(x, y, noteR * scale).fill({ color: NOTE_HIT, alpha })
        break
      }

      case 'missed': {
        if (note.missTime === undefined) break
        const t = this.engine.time - note.missTime
        const alpha = Math.max(0, 1 - t / 0.25)
        if (alpha <= 0.01) break

        const scale = Math.max(0.01, 1 - t * 2.5)

        this._drawLedgerLines(
          g,
          x,
          step,
          staffTopForNote,
          lineSpacing,
          noteR + 5,
          NOTE_MISSED,
          alpha,
        )
        g.circle(x, y, noteR * scale).fill({
          color: NOTE_MISSED,
          alpha,
        })

        // × cross
        const cr = noteR * 0.6
        g.moveTo(x - cr, y - cr)
          .lineTo(x + cr, y + cr)
          .stroke({ color: NOTE_MISSED, width: 1.5, alpha })
        g.moveTo(x + cr, y - cr)
          .lineTo(x - cr, y + cr)
          .stroke({ color: NOTE_MISSED, width: 1.5, alpha })
        break
      }
    }
  }

  private _drawSharp(
    g: Graphics,
    noteX: number,
    noteY: number,
    color: number,
    alpha: number,
  ): void {
    const ls = this.lineSpacing
    const h = ls * 0.9 // vertical line height
    const w = ls * 0.45 // horizontal bar half-width
    const ax = noteX - ls * 1.15 // center of the # glyph

    // Two vertical lines
    g.moveTo(ax - w * 0.4, noteY - h / 2)
      .lineTo(ax - w * 0.4, noteY + h / 2)
      .stroke({ color, width: 1, alpha })
    g.moveTo(ax + w * 0.4, noteY - h / 2)
      .lineTo(ax + w * 0.4, noteY + h / 2)
      .stroke({ color, width: 1, alpha })
    // Two horizontal bars (slightly tilted upward left-to-right)
    const tilt = h * 0.06
    g.moveTo(ax - w, noteY - h * 0.18 + tilt)
      .lineTo(ax + w, noteY - h * 0.18 - tilt)
      .stroke({ color, width: 1.2, alpha })
    g.moveTo(ax - w, noteY + h * 0.18 + tilt)
      .lineTo(ax + w, noteY + h * 0.18 - tilt)
      .stroke({ color, width: 1.2, alpha })
  }

  private _drawLedgerLines(
    g: Graphics,
    x: number,
    step: number,
    staffTopForNote: number,
    ls: number,
    halfWidth: number,
    color: number,
    alpha: number,
  ): void {
    const draw = (s: number) => {
      const ly = yFromStep(s, staffTopForNote, ls)
      g.moveTo(x - halfWidth, ly)
        .lineTo(x + halfWidth, ly)
        .stroke({ color, width: 1, alpha })
    }

    // Below the staff (step <= -2)
    if (step <= -2) {
      const end = step % 2 === 0 ? step : step + 1
      for (let s = -2; s >= end; s -= 2) draw(s)
    }
    // Above the staff (step >= 10, staff lines are 0,2,4,6,8 — top is 8)
    if (step >= 10) {
      const end = step % 2 === 0 ? step : step - 1
      for (let s = 10; s <= end; s += 2) draw(s)
    }
  }

  private _drawBursts(g: Graphics): void {
    const now = performance.now()
    const ls = this.lineSpacing
    const alive: Burst[] = []

    for (const burst of this.bursts) {
      const age = (now - burst.born) / BURST_DURATION_MS
      if (age >= 1) continue
      alive.push(burst)
      const radius = age * ls * 4
      const particleR = ls * 0.3 * (1 - age)
      const alpha = (1 - age) * 0.85

      for (let i = 0; i < 8; i++) {
        const angle = (i / 8) * Math.PI * 2
        const px = burst.x + Math.cos(angle) * radius
        const py = burst.y + Math.sin(angle) * radius
        g.circle(px, py, particleR).fill({ color: burst.color, alpha })
      }
    }

    this.bursts = alive
  }

  private _drawMissVignette(g: Graphics): void {
    if (this.lastMissTime === 0) return
    const missAge = (performance.now() - this.lastMissTime) / VIGNETTE_DURATION_MS
    if (missAge >= 1) return

    const alpha = 0.2 * (1 - missAge)
    const { w, rollH } = this
    g.rect(0, 0, w, 8).fill({ color: NOTE_MISSED, alpha })
    g.rect(0, rollH - 8, w, 8).fill({ color: NOTE_MISSED, alpha })
    g.rect(0, 0, 8, rollH).fill({ color: NOTE_MISSED, alpha })
    g.rect(w - 8, 0, 8, rollH).fill({ color: NOTE_MISSED, alpha })
  }
}
