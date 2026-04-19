import { Container, Graphics } from 'pixi.js'
import { GlowFilter } from 'pixi-filters'
import type { MidiTrack } from '../core/midi/types'
import { getTrackColor, type Theme } from './theme'
import type { Viewport } from './viewport'

// One Graphics object per track — same-color draws are batched together.
// A separate glow container holds only the notes currently being struck,
// so the expensive GlowFilter only runs over a small subset each frame.

export class NoteRenderer {
  readonly container: Container

  private trackGraphics = new Map<string, Graphics>()
  private glowContainer: Container
  private glowGraphics: Graphics
  private glowFilter: GlowFilter

  constructor(private theme: Theme) {
    this.container = new Container()
    this.container.label = 'notes'

    this.glowContainer = new Container()
    this.glowContainer.label = 'note-glow'

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
    this.container.addChild(this.glowContainer)
  }

  // Call once when tracks are loaded — sets up one Graphics per track
  setTracks(tracks: MidiTrack[]): void {
    // Remove stale graphics
    const incomingIds = new Set(tracks.map((t) => t.id))
    for (const [id, g] of this.trackGraphics) {
      if (!incomingIds.has(id)) {
        this.container.removeChild(g)
        g.destroy()
        this.trackGraphics.delete(id)
      }
    }

    for (const track of tracks) {
      if (!this.trackGraphics.has(track.id)) {
        const g = new Graphics()
        g.label = `notes-${track.id}`
        // Insert before the glow container so glow renders on top.
        this.container.addChildAt(g, this.container.children.indexOf(this.glowContainer))
        this.trackGraphics.set(track.id, g)
      }
    }
  }

  // Called every frame from the main render loop.
  // Draws base notes and active-note glow in a single pass; accumulates the
  // glow-filter tint inline so no intermediate array is allocated per frame.
  draw(
    tracks: MidiTrack[],
    currentTime: number,
    viewport: Viewport,
    visibleTrackIds: Set<string>,
  ): void {
    const { noteRadius } = this.theme
    const nowLineY = viewport.nowLineY
    this.glowGraphics.clear()

    let activeCount = 0
    let sumR = 0,
      sumG = 0,
      sumB = 0

    for (const track of tracks) {
      const g = this.trackGraphics.get(track.id)
      if (!g) continue

      g.clear()

      if (!visibleTrackIds.has(track.id)) continue

      const noteColor = getTrackColor(track, this.theme)
      const colorR = (noteColor >> 16) & 0xff
      const colorG = (noteColor >> 8) & 0xff
      const colorB = noteColor & 0xff

      for (const note of track.notes) {
        if (!viewport.isTimeVisible(note.time, note.duration, currentTime)) continue

        const x = viewport.pitchToX(note.pitch)
        const w = Math.max(viewport.pitchWidth(note.pitch) - 1, 2)
        const timeDelta = note.time - currentTime
        const noteBottom = Math.min(viewport.timeOffsetToY(timeDelta), nowLineY)
        const noteTop = viewport.timeOffsetToY(timeDelta + note.duration)
        if (noteTop >= nowLineY) continue
        const h = Math.max(noteBottom - noteTop, 3)
        const y = noteTop

        // Velocity → alpha (0.5 minimum so faint notes are still visible)
        const alpha = 0.5 + note.velocity * 0.5

        g.roundRect(x, y, w, h, noteRadius)
        g.fill({ color: noteColor, alpha })

        if (note.time <= currentTime && note.time + note.duration >= currentTime) {
          this.glowGraphics.roundRect(x, y, w, h, noteRadius)
          this.glowGraphics.fill({ color: noteColor, alpha: 0.9 })
          sumR += colorR
          sumG += colorG
          sumB += colorB
          activeCount++
        }
      }
    }

    if (activeCount > 0) {
      const avgColor =
        (Math.round(sumR / activeCount) << 16) |
        (Math.round(sumG / activeCount) << 8) |
        Math.round(sumB / activeCount)
      this.glowFilter.color = avgColor
      this.glowContainer.visible = true
    } else {
      this.glowContainer.visible = false
    }
  }

  updateTheme(theme: Theme): void {
    this.theme = theme
    this.glowFilter.distance = theme.noteGlowDistance
    this.glowFilter.outerStrength = theme.noteGlowStrength
  }

  clear(): void {
    this.trackGraphics.forEach((g) => {
      g.clear()
    })
    this.glowGraphics.clear()
    this.glowContainer.visible = false
  }
}
