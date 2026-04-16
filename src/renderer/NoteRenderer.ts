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
    const incomingIds = new Set(tracks.map(t => t.id))
    for (const [id, g] of this.trackGraphics) {
      if (!incomingIds.has(id)) {
        this.container.removeChild(g)
        g.destroy()
        this.trackGraphics.delete(id)
      }
    }

    // Add new ones (insert below glow layer)
    for (const track of tracks) {
      if (!this.trackGraphics.has(track.id)) {
        const g = new Graphics()
        g.label = `notes-${track.id}`
        // Insert before glow container so glow renders on top
        this.container.addChildAt(g, this.container.children.indexOf(this.glowContainer))
        this.trackGraphics.set(track.id, g)
      }
    }
  }

  // Called every frame from the main render loop
  draw(
    tracks: MidiTrack[],
    currentTime: number,
    viewport: Viewport,
    visibleTrackIds: Set<string>,
  ): void {
    const { noteRadius } = this.theme
    const activeNotes: Array<{ x: number; y: number; w: number; h: number; color: number }> = []

    for (const track of tracks) {
      const g = this.trackGraphics.get(track.id)
      if (!g) continue

      g.clear()

      if (!visibleTrackIds.has(track.id)) continue

      const noteColor = getTrackColor(track, this.theme)

      for (const note of track.notes) {
        if (!viewport.isTimeVisible(note.time, note.duration, currentTime)) continue

        const x = viewport.pitchToX(note.pitch)
        const w = Math.max(viewport.pitchWidth(note.pitch) - 1, 2)
        const timeDelta = note.time - currentTime
        const noteBottom = viewport.timeOffsetToY(timeDelta)
        const noteTop = viewport.timeOffsetToY(timeDelta + note.duration)
        const h = Math.max(noteBottom - noteTop, 3)
        const y = noteTop

        // Velocity → alpha (0.5 minimum so faint notes are still visible)
        const alpha = 0.5 + note.velocity * 0.5

        g.roundRect(x, y, w, h, noteRadius)
        g.fill({ color: noteColor, alpha })

        // Collect notes that are actively playing for the glow pass
        const isActive = note.time <= currentTime && note.time + note.duration >= currentTime
        if (isActive) {
          activeNotes.push({ x, y, w, h, color: noteColor })
        }
      }
    }

    // Draw the glow layer — only active notes
    this.glowGraphics.clear()
    for (const n of activeNotes) {
      this.glowGraphics.roundRect(n.x, n.y, n.w, n.h, noteRadius)
      this.glowGraphics.fill({ color: n.color, alpha: 0.9 })
    }

    // Update glow color to blend all active track colors (simple average)
    if (activeNotes.length > 0) {
      const avgColor = averageColors(activeNotes.map(n => n.color))
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
}

function averageColors(colors: number[]): number {
  if (colors.length === 0) return 0xffffff
  let r = 0, g = 0, b = 0
  for (const c of colors) {
    r += (c >> 16) & 0xff
    g += (c >> 8) & 0xff
    b += c & 0xff
  }
  const n = colors.length
  return ((Math.round(r / n) << 16) | (Math.round(g / n) << 8) | Math.round(b / n))
}
