import { Container, Graphics } from 'pixi.js'
import type { RenderContext, RenderLayer } from '../../renderer/RenderLayer'

// Shared cinematic vocabulary for Learn-mode exercises. Every exercise that
// wants target zones, loop bands, upcoming-note glows, or celebration swells
// drives them through this one overlay instead of drawing its own — so the
// visual language stays consistent across the suite.
//
// Design-token values live here as constants. Tune in-place rather than
// exposing them to exercises; the whole point of the shared layer is that
// exercises don't get to pick their own feel.

const TARGET_ZONE_HEIGHT = 10
const TARGET_ZONE_BASE_ALPHA = 0.06
const TARGET_PULSE_DURATION_MS = 180
const LOOP_BAND_ALPHA = 0.15
const LOOP_BAND_EDGE_FADE_PX = 12
const CELEBRATION_DURATION_MS = 400

interface TargetPulse {
  color: number
  startMs: number
}

interface Celebration {
  x: number
  y: number
  color: number
  startMs: number
}

export interface LoopBandState {
  startTime: number
  endTime: number
  color: number
}

export class LearnOverlay implements RenderLayer {
  readonly id = 'learn-overlay'
  // Above notes (z≈2-3 in the built-in layer stack), below keyboard (z≈6).
  // Picked intentionally so loop bands and target zones don't occlude the
  // note sprites but also don't flash behind the keys.
  readonly zIndex = 5

  private container: Container | null = null
  private zoneGraphic: Graphics | null = null
  private loopGraphic: Graphics | null = null
  private celebrationGraphic: Graphics | null = null
  private upcomingGraphic: Graphics | null = null

  private pulse: TargetPulse | null = null
  private celebrations: Celebration[] = []
  private loop: LoopBandState | null = null
  private upcomingPitches: Set<number> = new Set()

  mount(stage: Container): void {
    if (this.container) return
    const root = new Container()
    root.label = 'learn-overlay'
    this.zoneGraphic = new Graphics()
    this.loopGraphic = new Graphics()
    this.upcomingGraphic = new Graphics()
    this.celebrationGraphic = new Graphics()
    // Draw order inside the overlay: loop band (bottom) → target zone →
    // upcoming highlights → celebration swells (top).
    root.addChild(this.loopGraphic)
    root.addChild(this.zoneGraphic)
    root.addChild(this.upcomingGraphic)
    root.addChild(this.celebrationGraphic)
    stage.addChild(root)
    this.container = root
  }

  unmount(): void {
    this.container?.destroy({ children: true })
    this.container = null
    this.zoneGraphic = null
    this.loopGraphic = null
    this.celebrationGraphic = null
    this.upcomingGraphic = null
    this.pulse = null
    this.celebrations = []
    this.loop = null
    this.upcomingPitches.clear()
  }

  // ── Imperative API for exercises ────────────────────────────────────────

  // Brief hit-acknowledgment pulse at the now-line. Color is the track tint
  // or accent — same as the note that just landed.
  pulseTargetZone(color: number, now: number = performance.now()): void {
    this.pulse = { color, startMs: now }
  }

  // Soft radial swell used on clean-loop-pass and piece-completion moments.
  // Keep these rare — the design principle is "breath, not fanfare".
  celebrationSwell(x: number, y: number, color: number, now: number = performance.now()): void {
    this.celebrations.push({ x, y, color, startMs: now })
    // Cap so a misbehaving caller can't grow the list unbounded. Older
    // celebrations fade out first anyway.
    if (this.celebrations.length > 6) this.celebrations.shift()
  }

  // Guidance hints drawn on top of the next ~8 upcoming notes. Pitches are
  // keyboard pitches; the overlay renders thin outlines and lets
  // `drawUpcoming` in `rebuild` do the geometry work. Empty set = off.
  highlightUpcoming(pitches: Iterable<number>): void {
    this.upcomingPitches = new Set(pitches)
  }

  // Amber translucent band over a time range. `null` clears. Epsilon-free
  // here — exercises compute the range; the overlay just renders it.
  drawLoopBand(band: LoopBandState | null): void {
    this.loop = band
  }

  // ── RenderLayer callbacks ───────────────────────────────────────────────

  update(ctx: RenderContext): void {
    this.drawTargetZone(ctx)
    this.drawLoop(ctx)
    this.drawUpcoming(ctx)
    this.drawCelebrations(ctx)
  }

  rebuild(ctx: RenderContext): void {
    // Everything here is viewport-derived, so a full redraw on static change
    // is both the simplest and cheapest approach.
    this.drawTargetZone(ctx)
    this.drawLoop(ctx)
    this.drawUpcoming(ctx)
    this.drawCelebrations(ctx)
  }

  // ── Internal rendering ──────────────────────────────────────────────────

  private drawTargetZone(ctx: RenderContext): void {
    const g = this.zoneGraphic
    if (!g) return
    g.clear()
    const w = ctx.viewport.config.canvasWidth
    const y = ctx.viewport.nowLineY - TARGET_ZONE_HEIGHT / 2
    g.rect(0, y, w, TARGET_ZONE_HEIGHT)
    g.fill({ color: 0xffffff, alpha: TARGET_ZONE_BASE_ALPHA })

    // Hit pulse — quick fade-out overlay in the track color.
    if (this.pulse) {
      const age = performance.now() - this.pulse.startMs
      if (age >= TARGET_PULSE_DURATION_MS) {
        this.pulse = null
      } else {
        const k = 1 - age / TARGET_PULSE_DURATION_MS
        g.rect(0, y, w, TARGET_ZONE_HEIGHT)
        g.fill({ color: this.pulse.color, alpha: 0.1 * k })
      }
    }
  }

  private drawLoop(ctx: RenderContext): void {
    const g = this.loopGraphic
    if (!g) return
    g.clear()
    if (!this.loop) return
    // Convert the time range to pixels and draw the band across the full
    // canvas width (behind the notes, above the background). Edge fades are
    // drawn as thin stripes at each end to soften the cut — exact alpha
    // numbers are tuned to read as "taped off" rather than "overlaid".
    const { startTime, endTime, color } = this.loop
    const time = ctx.time
    const startY = ctx.viewport.timeOffsetToY(startTime - time)
    const endY = ctx.viewport.timeOffsetToY(endTime - time)
    const top = Math.min(startY, endY)
    const bottom = Math.max(startY, endY)
    const height = bottom - top
    if (height <= 0) return
    const w = ctx.viewport.config.canvasWidth
    g.rect(0, top, w, height)
    g.fill({ color, alpha: LOOP_BAND_ALPHA })
    // Soft edges.
    const fade = Math.min(LOOP_BAND_EDGE_FADE_PX, height / 2)
    g.rect(0, top, w, fade)
    g.fill({ color, alpha: LOOP_BAND_ALPHA * 0.5 })
    g.rect(0, bottom - fade, w, fade)
    g.fill({ color, alpha: LOOP_BAND_ALPHA * 0.5 })
  }

  private drawUpcoming(ctx: RenderContext): void {
    const g = this.upcomingGraphic
    if (!g) return
    g.clear()
    if (this.upcomingPitches.size === 0) return
    // Thin stroke around each key at the now-line — the effect reads as a
    // "next up" outline on the keyboard. Exercises that already render
    // their own upcoming-note sprites can skip this path.
    const y = ctx.viewport.nowLineY - TARGET_ZONE_HEIGHT
    for (const pitch of this.upcomingPitches) {
      const x = ctx.viewport.pitchToX(pitch)
      const width = ctx.viewport.pitchWidth(pitch)
      if (width <= 0) continue
      g.rect(x + 0.5, y + 0.5, width - 1, TARGET_ZONE_HEIGHT * 2 - 1)
      g.stroke({ color: ctx.theme.nowLine, alpha: 0.25, width: 1 })
    }
  }

  private drawCelebrations(ctx: RenderContext): void {
    const g = this.celebrationGraphic
    if (!g) return
    g.clear()
    if (this.celebrations.length === 0) return
    const now = performance.now()
    const next: Celebration[] = []
    void ctx // viewport not needed — celebrations use absolute coords
    for (const swell of this.celebrations) {
      const age = now - swell.startMs
      if (age >= CELEBRATION_DURATION_MS) continue
      const k = 1 - age / CELEBRATION_DURATION_MS
      const radius = 36 + (1 - k) * 60
      g.circle(swell.x, swell.y, radius)
      g.fill({ color: swell.color, alpha: 0.18 * k })
      next.push(swell)
    }
    this.celebrations = next
  }
}
