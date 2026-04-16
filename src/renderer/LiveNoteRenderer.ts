import { Container, Graphics } from 'pixi.js'
import { GlowFilter } from 'pixi-filters'
import type { LiveNote } from '../midi/LiveNoteStore'
import type { Theme } from './theme'
import type { Viewport } from './viewport'

// Renders notes that are actively being played on a MIDI keyboard.
//
// Y-axis math (y increases downward in canvas space):
//   noteY  = viewport.nowLineY                           ← top edge pinned at the line
//   height = heldDuration * pixelsPerSecond              ← grows downward into the past zone
//
// The note body trails below the now-line, growing longer as the key is held.
// From the player's perspective the tail scrolls upward — the Synthesia feel.

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
    activeNotes: ReadonlyMap<number, LiveNote>,
    currentTime: number,
    viewport: Viewport,
  ): void {
    this.baseGraphics.clear()
    this.glowGraphics.clear()

    if (activeNotes.size === 0) {
      this.glowContainer.visible = false
      return
    }

    // Live notes use the now-line colour so they feel "born from" the line.
    const color = this.theme.nowLine
    const { pixelsPerSecond } = viewport.config
    const nowY = viewport.nowLineY

    for (const [, note] of activeNotes) {
      const x            = viewport.pitchToX(note.pitch)
      const w            = Math.max(viewport.pitchWidth(note.pitch) - 1, 2)
      const heldSec      = Math.max(currentTime - note.startTime, 0)
      const height       = Math.max(heldSec * pixelsPerSecond, 3)
      // Clamp corner radius so PixiJS never receives radius > half the height
      const radius       = Math.min(this.theme.noteRadius, height / 2, w / 2)
      const alpha        = 0.55 + note.velocity * 0.45

      // Base layer — slightly transparent
      this.baseGraphics.roundRect(x, nowY, w, height, radius)
      this.baseGraphics.fill({ color, alpha: alpha * 0.75 })

      // Glow layer — all live notes are "active" by definition
      this.glowGraphics.roundRect(x, nowY, w, height, radius)
      this.glowGraphics.fill({ color, alpha })
    }

    this.glowFilter.color = color
    this.glowContainer.visible = true
  }

  updateTheme(theme: Theme): void {
    this.theme = theme
    this.glowFilter.distance     = theme.noteGlowDistance
    this.glowFilter.outerStrength = theme.noteGlowStrength
  }
}
