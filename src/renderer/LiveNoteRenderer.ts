import { Container, Graphics } from 'pixi.js'
import { GlowFilter } from 'pixi-filters'
import type { LiveNote } from '../midi/LiveNoteStore'
import type { Theme } from './theme'
import type { Viewport } from './viewport'

// Renders live MIDI note trails. Held notes grow upward from the strike line;
// once released, the captured trail keeps translating upward with time until it
// leaves the roll.
//
// Y-axis math (y increases downward in canvas space):
//   held:     y = nowLineY - height
//   released: y = nowLineY - height - releasedAge * pixelsPerSecond
//
// Live notes extend upward from the strike line so they visually agree with
// imported notes arriving from above.

export class LiveNoteRenderer {
  readonly container: Container

  private baseGraphics: Graphics
  private glowContainer: Container
  private glowGraphics:  Graphics
  private glowFilter:    GlowFilter

  constructor(private theme: Theme) {
    this.container = new Container()
    this.container.label = 'live-notes'

    this.baseGraphics = new Graphics()
    this.baseGraphics.label = 'live-notes-base'

    this.glowContainer = new Container()
    this.glowContainer.label = 'live-notes-glow'

    this.glowFilter = new GlowFilter({
      distance:     theme.noteGlowDistance,
      outerStrength: theme.noteGlowStrength,
      innerStrength: 0,
      color:         0xffffff,
      quality:       0.3,
    })
    this.glowContainer.filters = [this.glowFilter]

    this.glowGraphics = new Graphics()
    this.glowContainer.addChild(this.glowGraphics)

    this.container.addChild(this.baseGraphics)
    this.container.addChild(this.glowContainer)
  }

  draw(
    notes: readonly LiveNote[],
    currentTime: number,
    viewport: Viewport,
  ): void {
    this.baseGraphics.clear()
    this.glowGraphics.clear()

    if (notes.length === 0) {
      this.glowContainer.visible = false
      return
    }

    // Live notes use the now-line colour so they feel "born from" the line.
    const color = this.theme.nowLine
    const { pixelsPerSecond } = viewport.config
    const nowY = viewport.nowLineY
    let hasHeldNotes = false

    for (const note of notes) {
      const x = viewport.pitchToX(note.pitch)
      const w = Math.max(viewport.pitchWidth(note.pitch) - 1, 2)
      const endTime = note.endTime ?? currentTime
      const noteDuration = Math.max(endTime - note.startTime, 0)
      const releasedSec = note.endTime === null ? 0 : Math.max(currentTime - note.endTime, 0)
      const height = Math.max(noteDuration * pixelsPerSecond, 3)
      const y = nowY - height - releasedSec * pixelsPerSecond
      if (y + height <= 0) continue
      // Clamp corner radius so PixiJS never receives radius > half the height
      const radius = Math.min(this.theme.noteRadius, height / 2, w / 2)
      const alpha = 0.55 + note.velocity * 0.45

      // Base layer — slightly transparent
      this.baseGraphics.roundRect(x, y, w, height, radius)
      this.baseGraphics.fill({ color, alpha: alpha * 0.75 })

      if (note.endTime === null) {
        hasHeldNotes = true
        this.glowGraphics.roundRect(x, y, w, height, radius)
        this.glowGraphics.fill({ color, alpha })
      }
    }

    this.glowFilter.color = color
    this.glowContainer.visible = hasHeldNotes
  }

  updateTheme(theme: Theme): void {
    this.theme = theme
    this.glowFilter.distance     = theme.noteGlowDistance
    this.glowFilter.outerStrength = theme.noteGlowStrength
  }
}
