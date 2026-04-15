import { Graphics } from 'pixi.js'
import type { Theme } from './theme'
import type { Viewport } from './viewport'

export class BeatGrid {
  readonly graphics: Graphics

  constructor() {
    this.graphics = new Graphics()
    this.graphics.label = 'beat-grid'
  }

  draw(
    currentTime: number,
    bpm: number,
    timeSigNumerator: number,
    viewport: Viewport,
    theme: Theme,
  ): void {
    const g = this.graphics
    g.clear()

    const beatDuration = 60 / bpm
    const canvasWidth = viewport.config.canvasWidth
    const rollHeight = viewport.rollHeight

    // Use computed getters — these update automatically with zoom
    const visStart = currentTime - viewport.trailSeconds - 0.5
    const visEnd = currentTime + viewport.lookaheadSeconds + 0.5

    const firstBeat = Math.floor(visStart / beatDuration)
    const lastBeat = Math.ceil(visEnd / beatDuration)

    for (let i = firstBeat; i <= lastBeat; i++) {
      const beatTime = i * beatDuration
      const y = Math.round(viewport.timeOffsetToY(beatTime - currentTime))

      if (y < 0 || y > rollHeight) continue

      const isBar = i % timeSigNumerator === 0
      const alpha = isBar ? theme.barLineAlpha : theme.beatLineAlpha

      g.rect(0, y, canvasWidth, 1)
      g.fill({ color: 0xffffff, alpha })
    }
  }
}
