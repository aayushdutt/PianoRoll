import { Container, Graphics } from 'pixi.js'
import { GlowFilter } from 'pixi-filters'
import type { LiveNote, LiveNoteStore } from '../midi/LiveNoteStore'
import type { Theme } from './theme'
import type { Viewport } from './viewport'

// Renders live MIDI note trails. Held notes grow upward from the strike line;
// once released, the captured trail keeps translating upward with time until it
// leaves the roll.
//
// An optional secondary store renders ghost notes for loop playback — dimmer,
// no glow, drawn behind live notes so the user can tell "me vs. my loop" at a
// glance.
//
// Y-axis math (y increases downward in canvas space):
//   held:     y = nowLineY - height
//   released: y = nowLineY - height - releasedAge * pixelsPerSecond

const GHOST_ALPHA_SCALE = 0.45

export class LiveNoteRenderer {
  readonly container: Container

  private baseGraphics: Graphics
  private glowContainer: Container
  private glowGraphics: Graphics
  private glowFilter: GlowFilter

  constructor(private theme: Theme) {
    this.container = new Container()
    this.container.label = 'live-notes'

    this.baseGraphics = new Graphics()
    this.baseGraphics.label = 'live-notes-base'

    this.glowContainer = new Container()
    this.glowContainer.label = 'live-notes-glow'

    this.glowFilter = new GlowFilter({
      distance: theme.noteGlowDistance,
      outerStrength: theme.noteGlowStrength,
      innerStrength: 0,
      color: 0xffffff,
      quality: 0.3,
    })
    this.glowContainer.filters = [this.glowFilter]

    this.glowGraphics = new Graphics()
    this.glowContainer.addChild(this.glowGraphics)

    this.container.addChild(this.baseGraphics)
    this.container.addChild(this.glowContainer)
  }

  draw(
    primary: LiveNoteStore,
    loop: LiveNoteStore | null,
    currentTime: number,
    viewport: Viewport,
  ): void {
    this.baseGraphics.clear()
    this.glowGraphics.clear()

    const primaryEmpty = primary.releasedNotes.length === 0 && primary.heldNotes.size === 0
    const loopEmpty =
      loop === null || (loop.releasedNotes.length === 0 && loop.heldNotes.size === 0)
    if (primaryEmpty && loopEmpty) {
      this.glowContainer.visible = false
      return
    }

    // Live notes take the theme's primary track color so they visually tie
    // into the UI accent and any imported MIDI notes.
    const color = this.theme.trackColors[0] ?? this.theme.nowLine
    const { pixelsPerSecond } = viewport.config
    const nowY = viewport.nowLineY

    // Ghosts draw first so live notes layer on top.
    if (loop !== null) {
      for (const note of loop.releasedNotes)
        this.drawOne(
          note,
          currentTime,
          pixelsPerSecond,
          nowY,
          viewport,
          color,
          false,
          GHOST_ALPHA_SCALE,
        )
      for (const note of loop.heldNotes.values())
        this.drawOne(
          note,
          currentTime,
          pixelsPerSecond,
          nowY,
          viewport,
          color,
          false,
          GHOST_ALPHA_SCALE,
        )
    }

    for (const note of primary.releasedNotes)
      this.drawOne(note, currentTime, pixelsPerSecond, nowY, viewport, color, false, 1)
    for (const note of primary.heldNotes.values())
      this.drawOne(note, currentTime, pixelsPerSecond, nowY, viewport, color, true, 1)

    this.glowFilter.color = color
    this.glowContainer.visible = primary.heldNotes.size > 0
  }

  private drawOne(
    note: LiveNote,
    currentTime: number,
    pixelsPerSecond: number,
    nowY: number,
    viewport: Viewport,
    color: number,
    drawGlow: boolean,
    alphaScale: number,
  ): void {
    const x = viewport.pitchToX(note.pitch)
    const w = Math.max(viewport.pitchWidth(note.pitch) - 1, 2)
    const endTime = note.endTime ?? currentTime
    const noteDuration = Math.max(endTime - note.startTime, 0)
    const releasedSec = note.endTime === null ? 0 : Math.max(currentTime - note.endTime, 0)
    const height = Math.max(noteDuration * pixelsPerSecond, 3)
    const y = nowY - height - releasedSec * pixelsPerSecond
    if (y + height <= 0) return
    const radius = Math.min(this.theme.noteRadius, height / 2, w / 2)
    const alpha = (0.55 + note.velocity * 0.45) * alphaScale

    this.baseGraphics.roundRect(x, y, w, height, radius)
    this.baseGraphics.fill({ color, alpha: alpha * 0.75 })

    if (drawGlow) {
      this.glowGraphics.roundRect(x, y, w, height, radius)
      this.glowGraphics.fill({ color, alpha })
    }
  }

  updateTheme(theme: Theme): void {
    this.theme = theme
    this.glowFilter.distance = theme.noteGlowDistance
    this.glowFilter.outerStrength = theme.noteGlowStrength
  }

  clear(): void {
    this.baseGraphics.clear()
    this.glowGraphics.clear()
    this.glowContainer.visible = false
  }
}
