// Beat/bar lines behind the roll. Walks the file's tempo + meter map
// (src/core/midi/tempoMap.ts) rather than extrapolating `60 / bpm` from zero,
// so lines stay glued to the notes across tempo and meter changes.
//
// Constraint: `draw` runs every frame. Per-frame state is held on the instance
// and the visitor is a bound field, so a draw allocates nothing.

import { Graphics } from 'pixi.js'
import { forEachBeatLine, type TempoMapSource } from '../core/midi/tempoMap'
import type { Theme } from './theme'
import type { Viewport } from './viewport'

export class BeatGrid {
  readonly graphics: Graphics

  // Draw-call scratch, refreshed at the top of every `draw`.
  private currentTime = 0
  private canvasWidth = 0
  private rollHeight = 0
  private viewport: Viewport | null = null
  private theme: Theme | null = null

  constructor() {
    this.graphics = new Graphics()
    this.graphics.label = 'beat-grid'
  }

  clear(): void {
    this.graphics.clear()
  }

  draw(currentTime: number, map: TempoMapSource, viewport: Viewport, theme: Theme): void {
    this.graphics.clear()

    this.currentTime = currentTime
    this.viewport = viewport
    this.theme = theme
    this.canvasWidth = viewport.config.canvasWidth
    this.rollHeight = viewport.rollHeight

    // Computed getters — these update automatically with zoom.
    const visStart = Math.max(0, currentTime - viewport.trailSeconds - 0.5)
    const visEnd = currentTime + viewport.lookaheadSeconds + 0.5

    forEachBeatLine(map, visStart, visEnd, this.drawLine)
  }

  private readonly drawLine = (time: number, isBar: boolean): void => {
    const viewport = this.viewport
    const theme = this.theme
    if (!viewport || !theme) return

    const y = Math.round(viewport.timeOffsetToY(time - this.currentTime))
    if (y < 0 || y > this.rollHeight) return

    this.graphics.rect(0, y, this.canvasWidth, 1)
    this.graphics.fill({ color: 0xffffff, alpha: isBar ? theme.barLineAlpha : theme.beatLineAlpha })
  }
}
