import { Container, Graphics } from 'pixi.js'
import { GlowFilter } from 'pixi-filters'
import {
  chordDegreeColorIndex,
  chordRootFromPitches,
  colorForIndex,
  pitchClassOf,
  tonicPcFromKeyFifths,
} from '../core/music/chordColoring'
import type { LiveNote, LiveNoteStore } from '../midi/LiveNoteStore'
import { liveNoteColor, type Theme } from './theme'
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

  // Chord-degree coloring. Live input has no notated measures, so instead each
  // note's color is *fixed at onset*: the first frame we draw a note we snapshot
  // the chord it was struck within and cache the resulting color, so it never
  // flickers as later notes are added or released.
  private chordColoring = false
  private keyFifths = 0
  private colorCache = new WeakMap<LiveNote, { fill: number; edge: number }>()
  // Reused scratch buffer for the held-pitch set so the render loop stays
  // allocation-free while chord coloring is active.
  private activeScratch: number[] = []

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
    const color = liveNoteColor(this.theme)
    const { pixelsPerSecond } = viewport.config
    const nowY = viewport.nowLineY

    // Chord context for coloring = the notes the player is holding right now.
    const activeNotes = this.activeScratch
    if (this.chordColoring) {
      activeNotes.length = 0
      for (const pitch of primary.heldNotes.keys()) activeNotes.push(pitch)
    }

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
          activeNotes,
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
          activeNotes,
        )
    }

    for (const note of primary.releasedNotes)
      this.drawOne(note, currentTime, pixelsPerSecond, nowY, viewport, color, false, 1, activeNotes)
    for (const note of primary.heldNotes.values())
      this.drawOne(note, currentTime, pixelsPerSecond, nowY, viewport, color, true, 1, activeNotes)

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
    activeNotes: readonly number[],
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

    let noteColor = color
    let edgeColor: number | null = null
    if (this.chordColoring) {
      const colors = this.colorsForNote(note, activeNotes)
      noteColor = colors.fill
      edgeColor = colors.edge
    }

    this.baseGraphics.roundRect(x, y, w, height, radius)
    this.baseGraphics.fill({ color: noteColor, alpha: alpha * 0.75 })
    if (edgeColor !== null && height > 3) {
      this.baseGraphics.stroke({ color: edgeColor, width: 3, alpha: alpha * 0.9 })
    }

    if (drawGlow) {
      this.glowGraphics.roundRect(x, y, w, height, radius)
      this.glowGraphics.fill({ color: noteColor, alpha })
    }
  }

  updateTheme(theme: Theme): void {
    this.theme = theme
    this.glowFilter.distance = theme.noteGlowDistance
    this.glowFilter.outerStrength = theme.noteGlowStrength
  }

  setChordColoring(enabled: boolean): void {
    this.chordColoring = enabled
    // Recolor from scratch so toggling on mid-session re-snapshots each note.
    this.colorCache = new WeakMap<LiveNote, { fill: number; edge: number }>()
  }

  setKeySignature(keyFifths: number): void {
    this.keyFifths = keyFifths
    // Cached colors are key-dependent — drop them so the new key takes effect.
    this.colorCache = new WeakMap<LiveNote, { fill: number; edge: number }>()
  }

  // Resolve (and cache) a note's fixed fill + edge colors. On first sight the
  // chord is sampled from the notes held at that instant; the colors — the
  // note's own chord-degree color and the chord root's color — are then frozen.
  private colorsForNote(
    note: LiveNote,
    heldPitches: readonly number[],
  ): { fill: number; edge: number } {
    const cached = this.colorCache.get(note)
    if (cached !== undefined) return cached
    const root = chordRootFromPitches(heldPitches)
    const tonicPC = tonicPcFromKeyFifths(this.keyFifths)
    const colors = {
      fill: colorForIndex(chordDegreeColorIndex(pitchClassOf(note.pitch), root, tonicPC)),
      edge: colorForIndex(chordDegreeColorIndex(root, root, tonicPC)),
    }
    this.colorCache.set(note, colors)
    return colors
  }

  clear(): void {
    this.baseGraphics.clear()
    this.glowGraphics.clear()
    this.glowContainer.visible = false
  }
}
