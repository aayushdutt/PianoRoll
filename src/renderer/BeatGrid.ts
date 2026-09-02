// Beat/bar lines behind the roll, from the file's tempo + meter map
// (src/core/midi/tempoMap.ts) so lines stay glued to the notes across tempo
// and meter changes.
//
// Constraint: `draw` runs every frame. The map is walked ONCE per file into
// flat arrays (a 30-minute piece is a few thousand entries); each frame is a
// binary search plus a handful of rects, and allocates nothing.

import { Graphics } from 'pixi.js'
import { forEachBeatLine, type TempoMapSource } from '../core/midi/tempoMap'
import type { Theme } from './theme'
import type { Viewport } from './viewport'

// How far past the visible window the cache is built. The walk restarts from
// 0 on each extension, so keep extensions rare.
const CACHE_MARGIN_SECONDS = 300

export class BeatGrid {
  readonly graphics: Graphics

  private cachedMap: TempoMapSource | null = null
  private cachedEnd = -1
  private times: number[] = []
  private isBar: boolean[] = []

  constructor() {
    this.graphics = new Graphics()
    this.graphics.label = 'beat-grid'
  }

  clear(): void {
    this.graphics.clear()
  }

  draw(currentTime: number, map: TempoMapSource, viewport: Viewport, theme: Theme): void {
    const g = this.graphics
    g.clear()

    // Computed getters — these update automatically with zoom.
    const visStart = Math.max(0, currentTime - viewport.trailSeconds - 0.5)
    const visEnd = currentTime + viewport.lookaheadSeconds + 0.5
    if (map !== this.cachedMap || visEnd > this.cachedEnd) this.rebuild(map, visEnd)

    const canvasWidth = viewport.config.canvasWidth
    const rollHeight = viewport.rollHeight
    const times = this.times

    // First cached line at or after visStart.
    let lo = 0
    let hi = times.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (times[mid]! < visStart) lo = mid + 1
      else hi = mid
    }

    for (let i = lo; i < times.length && times[i]! <= visEnd; i++) {
      const y = Math.round(viewport.timeOffsetToY(times[i]! - currentTime))
      if (y < 0 || y > rollHeight) continue
      g.rect(0, y, canvasWidth, 1)
      g.fill({ color: 0xffffff, alpha: this.isBar[i] ? theme.barLineAlpha : theme.beatLineAlpha })
    }
  }

  private rebuild(map: TempoMapSource, needEnd: number): void {
    this.cachedMap = map
    this.cachedEnd = needEnd + CACHE_MARGIN_SECONDS
    this.times.length = 0
    this.isBar.length = 0
    forEachBeatLine(map, 0, this.cachedEnd, (time, bar) => {
      this.times.push(time)
      this.isBar.push(bar)
    })
  }
}
