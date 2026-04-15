import { Application, Graphics, Ticker } from 'pixi.js'
import type { MidiFile } from '../core/midi/types'
import type { MasterClock } from '../core/clock/MasterClock'
import { NoteRenderer } from './NoteRenderer'
import { KeyboardRenderer } from './KeyboardRenderer'
import { ParticleSystem } from './ParticleSystem'
import { BeatGrid } from './BeatGrid'
import { Viewport } from './viewport'
import { darkTheme, getTrackColor, type Theme } from './theme'

const KEYBOARD_HEIGHT = 120
const DEFAULT_PIXELS_PER_SECOND = 200

export class PianoRollRenderer {
  private app!: Application
  private viewport!: Viewport
  private noteRenderer!: NoteRenderer
  private keyboardRenderer!: KeyboardRenderer
  private particles!: ParticleSystem
  private beatGrid!: BeatGrid
  private nowLineGraphics!: Graphics
  private backgroundGraphics!: Graphics

  private midi: MidiFile | null = null
  private visibleTrackIds = new Set<string>()
  private theme: Theme = darkTheme
  private pixelsPerSecond = DEFAULT_PIXELS_PER_SECOND

  private prevActivePitches = new Set<string>()
  private exportMode = false

  async init(canvas: HTMLCanvasElement): Promise<void> {
    this.app = new Application()

    await this.app.init({
      canvas,
      width: window.innerWidth,
      height: window.innerHeight,
      backgroundColor: darkTheme.background,
      antialias: true,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
    })

    // ViewportConfig no longer contains lookaheadSeconds/trailSeconds —
    // those are now computed from rollHeight and pixelsPerSecond
    this.viewport = new Viewport({
      canvasWidth: this.app.screen.width,
      canvasHeight: this.app.screen.height,
      keyboardHeight: KEYBOARD_HEIGHT,
      pixelsPerSecond: this.pixelsPerSecond,
    })

    this.buildScene()
    this.handleResize()

    window.addEventListener('resize', this.handleResize)
  }

  private buildScene(): void {
    const stage = this.app.stage

    // Layer order (bottom → top):
    // 1. background  2. beat-grid  3. notes  4. now-line  5. keyboard  6. particles

    this.backgroundGraphics = new Graphics()
    this.backgroundGraphics.label = 'background'
    stage.addChild(this.backgroundGraphics)

    this.beatGrid = new BeatGrid()
    stage.addChild(this.beatGrid.graphics)

    this.noteRenderer = new NoteRenderer(this.theme)
    stage.addChild(this.noteRenderer.container)

    this.nowLineGraphics = new Graphics()
    this.nowLineGraphics.label = 'now-line'
    stage.addChild(this.nowLineGraphics)

    this.keyboardRenderer = new KeyboardRenderer(this.app, this.theme)
    stage.addChild(this.keyboardRenderer.container)

    this.particles = new ParticleSystem()
    stage.addChild(this.particles.container)

    this.drawBackground()
    this.keyboardRenderer.build(this.viewport, this.viewport.rollHeight)
  }

  private drawBackground(): void {
    const { canvasWidth, canvasHeight } = this.viewport.config
    const rollHeight = this.viewport.rollHeight
    const g = this.backgroundGraphics
    g.clear()

    g.rect(0, 0, canvasWidth, canvasHeight)
    g.fill({ color: this.theme.background })

    // Subtle vertical lines at C notes
    for (let pitch = 24; pitch <= 108; pitch += 12) {
      const x = this.viewport.pitchToX(pitch)
      g.rect(x, 0, 1, rollHeight)
      g.fill({ color: 0xffffff, alpha: 0.025 })
    }

    // Separator line between roll and keyboard
    g.rect(0, rollHeight, canvasWidth, 1)
    g.fill({ color: this.theme.keyBorder })
  }

  private drawNowLine(): void {
    const g = this.nowLineGraphics
    g.clear()
    const y = this.viewport.nowLineY
    const w = this.viewport.config.canvasWidth
    const glow = this.theme.nowLineGlow

    // Layered soft glow above the now-line
    g.rect(0, y - 14, w, 14); g.fill({ color: glow, alpha: 0.010 })
    g.rect(0, y - 8,  w, 8);  g.fill({ color: glow, alpha: 0.022 })
    g.rect(0, y - 4,  w, 4);  g.fill({ color: glow, alpha: 0.040 })
    g.rect(0, y - 2,  w, 2);  g.fill({ color: glow, alpha: 0.065 })

    g.rect(0, y, w, 1.5)
    g.fill({ color: this.theme.nowLine, alpha: this.theme.nowLineAlpha })
  }

  loadMidi(midi: MidiFile): void {
    this.midi = midi
    this.visibleTrackIds = new Set(midi.tracks.map(t => t.id))
    this.noteRenderer.setTracks(midi.tracks)
    this.particles.clear()
    this.prevActivePitches.clear()
  }

  setTrackVisible(trackId: string, visible: boolean): void {
    if (visible) this.visibleTrackIds.add(trackId)
    else this.visibleTrackIds.delete(trackId)
  }

  setZoom(pixelsPerSecond: number): void {
    this.pixelsPerSecond = pixelsPerSecond
    this.viewport.update({ pixelsPerSecond })
    this.drawBackground()
    this.keyboardRenderer.build(this.viewport, this.viewport.rollHeight)
  }

  setTheme(theme: Theme): void {
    this.theme = theme
    this.app.renderer.background.color = theme.background
    this.noteRenderer.updateTheme(theme)
    this.keyboardRenderer.updateTheme(theme)
    // No lookahead/trail to pass — those are computed by Viewport
    this.drawBackground()
    this.keyboardRenderer.build(this.viewport, this.viewport.rollHeight)
  }

  attachClock(clock: MasterClock): void {
    this.app.ticker.add(this.onTick.bind(this, clock))
  }

  private onTick(clock: MasterClock, _ticker: Ticker): void {
    if (!this.midi || this.exportMode) return
    const dt = _ticker.deltaMS / 1000
    this.renderFrame(clock.currentTime, dt, clock.playing)
  }

  renderManualFrame(time: number, dt: number): void {
    if (!this.midi) return
    this.renderFrame(time, dt, false)
    this.app.renderer.render(this.app.stage)
  }

  private renderFrame(currentTime: number, dt: number, emitParticles: boolean): void {
    if (!this.midi) return

    const activePitches = new Set<string>()
    const activePitchNums = new Set<number>()

    for (const track of this.midi.tracks) {
      if (!this.visibleTrackIds.has(track.id)) continue
      for (const note of track.notes) {
        if (note.time <= currentTime && note.time + note.duration >= currentTime) {
          activePitches.add(`${track.id}:${note.pitch}`)
          activePitchNums.add(note.pitch)
        }
      }
    }

    // Particle burst at the moment of note-on — fires at the now-line Y
    if (emitParticles) {
      for (const track of this.midi.tracks) {
        if (!this.visibleTrackIds.has(track.id)) continue
        const particleColor = getTrackColor(track, this.theme)
        for (const note of track.notes) {
          const key = `${track.id}:${note.pitch}`
          if (activePitches.has(key) && !this.prevActivePitches.has(key)) {
            const cx = this.viewport.pitchToX(note.pitch) + this.viewport.pitchWidth(note.pitch) / 2
            this.particles.burst(cx, this.viewport.nowLineY, particleColor)
          }
        }
      }
    }
    this.prevActivePitches = activePitches

    this.beatGrid.draw(currentTime, this.midi.bpm, this.midi.timeSignature[0] ?? 4, this.viewport, this.theme)
    this.noteRenderer.draw(this.midi.tracks, currentTime, this.viewport, this.visibleTrackIds)
    this.keyboardRenderer.drawActiveKeys(activePitchNums, this.viewport)
    this.particles.update(dt)
    this.drawNowLine()
  }

  pauseAutoRender(): void {
    this.exportMode = true
    this.app.ticker.stop()
    this.particles.clear()
    this.prevActivePitches.clear()
  }

  resumeAutoRender(): void {
    this.exportMode = false
    this.app.ticker.start()
  }

  get canvas(): HTMLCanvasElement {
    return this.app.canvas as HTMLCanvasElement
  }

  private handleResize = (): void => {
    const w = window.innerWidth
    const h = window.innerHeight
    this.app.renderer.resize(w, h)
    this.viewport.update({ canvasWidth: w, canvasHeight: h })
    this.drawBackground()
    this.keyboardRenderer.build(this.viewport, this.viewport.rollHeight)
  }

  destroy(): void {
    window.removeEventListener('resize', this.handleResize)
    this.app.destroy()
  }
}
