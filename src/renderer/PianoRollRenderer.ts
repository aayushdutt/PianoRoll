import { Application, Graphics, type Ticker } from 'pixi.js'
import type { MasterClock } from '../core/clock/MasterClock'
import type { MidiFile } from '../core/midi/types'
import type { LiveNoteStore } from '../midi/LiveNoteStore'
import { BeatGrid } from './BeatGrid'
import { KeyboardRenderer } from './KeyboardRenderer'
import { LiveNoteRenderer } from './LiveNoteRenderer'
import { NoteRenderer } from './NoteRenderer'
import { ParticleSystem } from './ParticleSystem'
import type { RenderContext, RenderLayer } from './RenderLayer'
import { darkTheme, getTrackColor, type Theme } from './theme'
import { Viewport } from './viewport'

// Must match the `--keyboard-h` value in main.css :root and the reset value
// in KeyboardResizer.onDoubleClick — all three describe the same default,
// and drift between them shows up as a gap under the resize handle on first
// load (before any saved preference or user drag has synced the CSS var).
const DEFAULT_KEYBOARD_HEIGHT = 120
export const KEYBOARD_HEIGHT_MIN = 80
// Raised from 220 so portrait phones can host a substantial keyboard —
// a 220px cap on an 844px-tall iPhone only gives 26% of the screen to the
// keys. Desktop users rarely drag above ~200px, so this is purely headroom.
export const KEYBOARD_HEIGHT_MAX = 360

// Fresh-load keyboard size, viewport-aware. Portrait phones get ~20% of
// viewport so keys feel playable without dominating; landscape phones get
// a proportionally *smaller* keyboard (~24% capped at 110px) because the
// viewport is short and the HUD + top-strip + falling-notes area all
// compete for the same vertical space. Desktop keeps the 120px default.
function computeInitialKeyboardHeight(): number {
  if (typeof window === 'undefined' || !window.matchMedia) return DEFAULT_KEYBOARD_HEIGHT
  const isCoarse = window.matchMedia('(pointer: coarse)').matches
  if (!isCoarse) return DEFAULT_KEYBOARD_HEIGHT
  const vh = window.innerHeight || 800
  const isPortrait = window.matchMedia('(orientation: portrait)').matches
  if (isPortrait) {
    return Math.min(KEYBOARD_HEIGHT_MAX, Math.max(140, Math.round(vh * 0.2)))
  }
  // Landscape mobile: short viewport (~390px on iPhone). Keep the keyboard
  // small so the HUD + roll area still have room.
  return Math.min(120, Math.max(88, Math.round(vh * 0.24)))
}

// Same formula as KeyboardResizer.viewportBounds — duplicated here so the
// renderer can re-clamp on rotation without reaching into UI-layer code.
// Max is 45% of viewport height: on a 390px landscape phone that gives a
// 176px cap, rescuing rotation from portrait where the keyboard would
// otherwise dominate over half the screen.
function viewportKeyboardBounds(): { min: number; max: number } {
  const vh = typeof window !== 'undefined' ? window.innerHeight : 900
  const min = Math.max(KEYBOARD_HEIGHT_MIN, Math.round(vh * 0.18))
  const max = Math.min(KEYBOARD_HEIGHT_MAX, Math.round(vh * 0.45))
  if (min >= max) return { min: KEYBOARD_HEIGHT_MIN, max: KEYBOARD_HEIGHT_MAX }
  return { min, max }
}
const DEFAULT_PIXELS_PER_SECOND = 200

// Sustained emission cadence for held notes. Initial burst fires on note-on
// (full preset count); subsequent tiny puffs emit every `SUSTAIN_INTERVAL_SEC`
// while the key stays held. Puff density is per-style (see ParticleSystem).
const SUSTAIN_INITIAL_DELAY_SEC = 0.18
const SUSTAIN_INTERVAL_SEC = 0.14

export class PianoRollRenderer {
  private app!: Application
  private viewport!: Viewport
  private noteRenderer!: NoteRenderer
  private keyboardRenderer!: KeyboardRenderer
  private liveNoteRenderer!: LiveNoteRenderer
  private particles!: ParticleSystem
  private beatGrid!: BeatGrid
  private nowLineGraphics!: Graphics
  private backgroundGraphics!: Graphics

  private midi: MidiFile | null = null
  private liveNoteStore: LiveNoteStore | null = null
  private loopNoteStore: LiveNoteStore | null = null
  private visibleTrackIds = new Set<string>()
  private theme: Theme = darkTheme
  private pixelsPerSecond = DEFAULT_PIXELS_PER_SECOND
  private keyboardHeight = DEFAULT_KEYBOARD_HEIGHT

  // Two pooled Sets swapped each frame. Keys are packed `trackIndex * 128 + pitch`
  // so comparisons never allocate strings in the hot path.
  private prevActive = new Set<number>()
  private currActive = new Set<number>()
  // Map pitch → color so the keyboard overlay picks up each track's own hue
  // rather than a single accent. Last-write-wins when multiple tracks sound
  // the same pitch — acceptable; the rest of the visualization already does
  // the same.
  private activeKeyColors = new Map<number, number>()
  private exportMode = false

  // Next time (in seconds of clock-time) to emit a sustained trail-burst for
  // each active note. Held keys keep breathing out particles at this cadence;
  // entries get reaped when the note ends.
  private scheduledEmitNext = new Map<number, number>()
  private liveEmitNext = new Map<number, number>()

  // Practice-mode hints (pitches that should glow on the keyboard as "play
  // these to advance"). `pending` is what's still required, `accepted` is what
  // the user has already pressed for the current step.
  private practiceHintPending: ReadonlySet<number> | null = null
  private practiceHintAccepted: ReadonlySet<number> | null = null

  // External RenderLayers (Learn-mode overlays, future sheet-music cursor,
  // etc.) kept sorted by `zIndex` ascending so a single forward iteration
  // draws them in the right order.
  private externalLayers: RenderLayer[] = []
  // Whether to draw the upward-floating live-note sprites. True in Play/Live
  // where the user expects their keypresses to animate up the roll; false
  // in Learn where the scheduled MIDI is what matters and user presses
  // should only manifest as a keyboard-key highlight.
  private liveNotesVisible = true

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

    // Pick a viewport-appropriate initial keyboard height before building the
    // scene — otherwise the first paint uses the desktop 120px default even
    // on portrait phones, and a later resize would cause a flash.
    this.keyboardHeight = computeInitialKeyboardHeight()

    this.viewport = new Viewport({
      canvasWidth: this.app.screen.width,
      canvasHeight: this.app.screen.height,
      keyboardHeight: this.keyboardHeight,
      pixelsPerSecond: this.pixelsPerSecond,
    })

    // Keep the CSS --keyboard-h in lockstep with the JS-side height from the
    // very first paint — the resize handle + HUD positioning reads this var
    // and would otherwise drift until the first setKeyboardHeight() call.
    document.documentElement.style.setProperty('--keyboard-h', `${this.keyboardHeight}px`)

    this.buildScene()
    this.handleResize()

    window.addEventListener('resize', this.handleResize)
  }

  private buildScene(): void {
    const stage = this.app.stage

    // Layer order (bottom → top):
    // 1. background  2. beat-grid  3. notes  4. live-notes  5. now-line  6. keyboard  7. particles

    this.backgroundGraphics = new Graphics()
    this.backgroundGraphics.label = 'background'
    stage.addChild(this.backgroundGraphics)

    this.beatGrid = new BeatGrid()
    stage.addChild(this.beatGrid.graphics)

    this.noteRenderer = new NoteRenderer(this.theme)
    stage.addChild(this.noteRenderer.container)

    this.liveNoteRenderer = new LiveNoteRenderer(this.theme)
    stage.addChild(this.liveNoteRenderer.container)

    this.nowLineGraphics = new Graphics()
    this.nowLineGraphics.label = 'now-line'
    stage.addChild(this.nowLineGraphics)

    this.keyboardRenderer = new KeyboardRenderer(this.app, this.theme)
    stage.addChild(this.keyboardRenderer.container)

    this.particles = new ParticleSystem()
    stage.addChild(this.particles.container)

    this.rebuildStaticLayers()
  }

  // Redraw every layer whose contents don't change per frame: background, now-line,
  // keyboard texture. Follow with `renderStaticFrame()` if the current frame also
  // needs to be re-presented. External layers get rebuilt too so overlays that
  // cache viewport-derived geometry stay in sync.
  private rebuildStaticLayers(): void {
    this.drawBackground()
    this.drawNowLine()
    this.keyboardRenderer.build(this.viewport, this.viewport.rollHeight)
    this.rebuildExternalLayers()
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
    g.rect(0, y - 14, w, 14)
    g.fill({ color: glow, alpha: 0.01 })
    g.rect(0, y - 8, w, 8)
    g.fill({ color: glow, alpha: 0.022 })
    g.rect(0, y - 4, w, 4)
    g.fill({ color: glow, alpha: 0.04 })
    g.rect(0, y - 2, w, 2)
    g.fill({ color: glow, alpha: 0.065 })

    g.rect(0, y, w, 1.5)
    g.fill({ color: this.theme.nowLine, alpha: this.theme.nowLineAlpha })
  }

  loadMidi(midi: MidiFile): void {
    this.midi = midi
    this.visibleTrackIds = new Set(midi.tracks.map((t) => t.id))
    this.noteRenderer.setTracks(midi.tracks)
    this.particles.clear()
    this.prevActive.clear()
    this.currActive.clear()
    this.renderStaticFrame(0)
  }

  clearMidi(): void {
    this.midi = null
    this.visibleTrackIds.clear()
    this.noteRenderer.setTracks([])
    this.noteRenderer.clear()
    this.liveNoteRenderer.clear()
    this.particles.clear()
    this.prevActive.clear()
    this.currActive.clear()
    this.scheduledEmitNext.clear()
    this.liveEmitNext.clear()
    this.beatGrid.graphics.clear()
    this.renderStaticFrame(0)
  }

  setTrackVisible(trackId: string, visible: boolean): void {
    if (visible) this.visibleTrackIds.add(trackId)
    else this.visibleTrackIds.delete(trackId)
  }

  setZoom(pixelsPerSecond: number): void {
    this.pixelsPerSecond = pixelsPerSecond
    // Key layout and keyboard texture are width-dependent, not zoom-dependent —
    // no need to rebuild them when only pixelsPerSecond changes.
    this.viewport.update({ pixelsPerSecond })
  }

  // Narrows or widens the visible pitch range. Used during vertical/square
  // export so the keyboard zooms onto the piece's actual range instead of
  // squeezing all 88 keys into a 1080px-wide canvas.
  setPitchRange(min: number, max: number): void {
    this.viewport.update({ pitchMin: min, pitchMax: max })
    this.rebuildStaticLayers()
  }

  get pitchRange(): { min: number; max: number } {
    return {
      min: this.viewport.config.pitchMin ?? 21,
      max: this.viewport.config.pitchMax ?? 108,
    }
  }

  get currentPixelsPerSecond(): number {
    return this.pixelsPerSecond
  }

  setKeyboardHeight(px: number): void {
    const clamped = Math.max(KEYBOARD_HEIGHT_MIN, Math.min(KEYBOARD_HEIGHT_MAX, Math.round(px)))
    if (clamped === this.keyboardHeight) return
    this.keyboardHeight = clamped
    this.viewport.update({ keyboardHeight: clamped })
    document.documentElement.style.setProperty('--keyboard-h', `${clamped}px`)
    this.rebuildStaticLayers()
    this.renderStaticFrame(0)
  }

  get currentKeyboardHeight(): number {
    return this.keyboardHeight
  }

  setParticleStyle(style: import('./ParticleSystem').ParticleStyle): void {
    this.particles.setStyle(style)
  }

  setTheme(theme: Theme): void {
    this.theme = theme
    this.app.renderer.background.color = theme.background
    this.noteRenderer.updateTheme(theme)
    this.liveNoteRenderer.updateTheme(theme)
    this.keyboardRenderer.updateTheme(theme)
    // Particle motion is intentionally theme-independent — only the color
    // changes (via the caller's trackColors[0]). Behaviour stays consistent.
    this.rebuildStaticLayers()
    this.renderStaticFrame(0)
  }

  // Public reads of renderer internals for Learn-mode overlays that compute
  // their own geometry (celebration swell position, target-zone color).
  // Kept narrow — exercises shouldn't need more than these.
  get currentTheme(): Theme {
    return this.theme
  }
  get currentViewport(): Viewport {
    return this.viewport
  }

  attachClock(clock: MasterClock): void {
    this.app.ticker.add(this.onTick.bind(this, clock))
  }

  private onTick(clock: MasterClock, ticker: Ticker): void {
    if (this.exportMode) return
    const hasLive =
      (this.liveNoteStore?.hasRenderableNotes ?? false) ||
      (this.loopNoteStore?.hasRenderableNotes ?? false)
    // Skip the render pass only when there is genuinely nothing to draw.
    // An external layer registered via `addLayer` may want a per-frame
    // update (animated target zone, countdown bar, staff cursor) even when
    // no MIDI or live notes are active — gating that out would freeze learn
    // overlays on the hub screen.
    if (!this.midi && !hasLive && this.externalLayers.length === 0) return
    this.renderFrame(clock.currentTime, ticker.deltaMS / 1000, clock.playing)
  }

  // Drives rendering during video export. `emitParticles: true` so note-on
  // bursts appear in the captured output — the exporter steps time forward
  // monotonically from t=0, so prev/curr note tracking works just like live
  // playback.
  renderManualFrame(time: number, dt: number): void {
    if (!this.midi) return
    this.renderFrame(time, dt, true)
    this.app.renderer.render(this.app.stage)
  }

  renderStaticFrame(currentTime: number): void {
    this.renderFrame(currentTime, 0, false)
    this.app.renderer.render(this.app.stage)
  }

  private renderFrame(currentTime: number, dt: number, emitParticles: boolean): void {
    const curr = this.currActive
    const activeColors = this.activeKeyColors
    curr.clear()
    activeColors.clear()

    // ── Scheduled MIDI notes ──────────────────────────────────────────────
    // Single pass collects active pitches and emits note-on particle bursts.
    // `prev`/`curr` swap at the end — no per-frame Set or string allocations.
    if (this.midi) {
      const tracks = this.midi.tracks
      const prev = this.prevActive
      const nowLineY = this.viewport.nowLineY
      // Don't light up the keyboard for scheduled notes when the clock is
      // paused at the very start of the timeline — nothing has actually
      // sounded yet. The classic case this guards against: opening a session
      // recording in file mode where the user held a key at recording start
      // (note.time === 0). Without this gate the keyboard would show that
      // key as pressed before the user has touched play.
      // Once playback has started or the playhead has moved past 0, the
      // normal "sounds now" rule applies — pausing mid-piece still shows
      // sustained notes correctly.
      const beforeFirstPlay = !emitParticles && currentTime === 0

      for (let ti = 0; ti < tracks.length; ti++) {
        const track = tracks[ti]!
        if (!this.visibleTrackIds.has(track.id)) continue
        // Always compute the track color — we now use it for the keyboard
        // overlay too, not just particle bursts.
        const trackColor = getTrackColor(track, this.theme)
        const keyBase = ti * 128

        for (const note of track.notes) {
          if (note.time > currentTime || note.time + note.duration < currentTime) continue

          const key = keyBase + note.pitch
          curr.add(key)
          if (!beforeFirstPlay) activeColors.set(note.pitch, trackColor)

          if (!emitParticles) continue

          const w = this.viewport.pitchWidth(note.pitch)
          const cx = this.viewport.pitchToX(note.pitch) + w / 2

          if (!prev.has(key)) {
            // Note-on: full initial burst + schedule the first sustained puff.
            this.particles.burst(cx, nowLineY, trackColor, w)
            this.scheduledEmitNext.set(key, currentTime + SUSTAIN_INITIAL_DELAY_SEC)
          } else {
            // Held note: release a small puff each tick to keep the plume alive.
            const nextAt = this.scheduledEmitNext.get(key)
            if (nextAt !== undefined && currentTime >= nextAt) {
              this.particles.sustainBurst(cx, nowLineY, trackColor, w)
              this.scheduledEmitNext.set(key, currentTime + SUSTAIN_INTERVAL_SEC)
            }
          }
        }
      }

      // Reap entries for notes that ended since the last frame.
      for (const key of this.scheduledEmitNext.keys()) {
        if (!curr.has(key)) this.scheduledEmitNext.delete(key)
      }

      this.beatGrid.draw(
        currentTime,
        this.midi.bpm,
        this.midi.timeSignature[0] ?? 4,
        this.viewport,
        this.theme,
      )
      this.noteRenderer.draw(tracks, currentTime, this.viewport, this.visibleTrackIds)
    } else {
      this.noteRenderer.clear()
    }

    // Swap prev ↔ curr for next frame (prev's contents are now stale)
    const tmp = this.prevActive
    this.prevActive = this.currActive
    this.currActive = tmp

    // ── Live MIDI keyboard notes ──────────────────────────────────────────
    if (this.liveNoteStore) {
      const maxReleasedAge = this.viewport.nowLineY / this.viewport.config.pixelsPerSecond
      this.liveNoteStore.pruneInvisible(currentTime, maxReleasedAge)
      this.loopNoteStore?.pruneInvisible(currentTime, maxReleasedAge)

      const held = this.liveNoteStore.heldNotes
      const loopHeld = this.loopNoteStore?.heldNotes
      const liveColor = this.theme.trackColors[0] ?? this.theme.nowLine
      const nowLineY = this.viewport.nowLineY

      for (const [pitch] of held) {
        activeColors.set(pitch, liveColor)
        if (!emitParticles) continue

        const nextAt = this.liveEmitNext.get(pitch)
        if (nextAt === undefined) {
          // First frame we see this held note — note-on was already bursted
          // synchronously via burstParticleAt. Schedule the first sustain puff.
          this.liveEmitNext.set(pitch, currentTime + SUSTAIN_INITIAL_DELAY_SEC)
        } else if (currentTime >= nextAt) {
          const w = this.viewport.pitchWidth(pitch)
          const cx = this.viewport.pitchToX(pitch) + w / 2
          this.particles.sustainBurst(cx, nowLineY, liveColor, w)
          this.liveEmitNext.set(pitch, currentTime + SUSTAIN_INTERVAL_SEC)
        }
      }

      // Loop-held notes still light up the keyboard but don't emit particles —
      // keeps the "me vs my loop" visual distinction clear. Use the live color
      // unless a live note is also active on the same pitch (already set).
      if (loopHeld) {
        for (const [pitch] of loopHeld) {
          if (!activeColors.has(pitch)) activeColors.set(pitch, liveColor)
        }
      }

      // Reap released notes.
      for (const pitch of this.liveEmitNext.keys()) {
        if (!held.has(pitch)) this.liveEmitNext.delete(pitch)
      }

      if (this.liveNotesVisible) {
        this.liveNoteRenderer.draw(
          this.liveNoteStore,
          this.loopNoteStore,
          currentTime,
          this.viewport,
        )
      } else {
        // Keyboard highlight (above) still uses `held` — we only suppress
        // the floating-up sprites. Learn mode uses this so user input
        // registers on the keyboard without polluting the piano roll.
        this.liveNoteRenderer.clear()
      }
    } else {
      this.liveNoteRenderer.clear()
      if (this.liveEmitNext.size > 0) this.liveEmitNext.clear()
    }

    this.keyboardRenderer.drawActiveKeys(activeColors, this.viewport)
    this.particles.update(dt)

    if (this.externalLayers.length > 0) {
      const ctx: RenderContext = {
        viewport: this.viewport,
        theme: this.theme,
        time: currentTime,
        dt,
      }
      for (const layer of this.externalLayers) layer.update?.(ctx)
    }
  }

  // Register an additive visual layer on top of the built-in scene. Layers are
  // drawn in `zIndex` order; callers are expected to pick a z that matches the
  // intended stacking (see RenderLayer for the conventional zones). Registering
  // the same layer twice is a no-op.
  addLayer(layer: RenderLayer): void {
    if (this.externalLayers.includes(layer)) return
    layer.mount(this.app.stage)
    this.externalLayers.push(layer)
    this.externalLayers.sort((a, b) => a.zIndex - b.zIndex)
    layer.rebuild?.(this.makeLayerCtx(0))
    // Re-present so a layer added while the clock is paused paints immediately
    // instead of waiting for the next tick (which may never come in home mode).
    this.renderStaticFrame(0)
  }

  removeLayer(layer: RenderLayer): void {
    const i = this.externalLayers.indexOf(layer)
    if (i < 0) return
    this.externalLayers.splice(i, 1)
    layer.unmount()
    this.renderStaticFrame(0)
  }

  private makeLayerCtx(time: number): RenderContext {
    return { viewport: this.viewport, theme: this.theme, time, dt: 0 }
  }

  private rebuildExternalLayers(): void {
    if (this.externalLayers.length === 0) return
    const ctx = this.makeLayerCtx(0)
    for (const layer of this.externalLayers) layer.rebuild?.(ctx)
  }

  burstParticleAt(pitch: number): void {
    const w = this.viewport.pitchWidth(pitch)
    const cx = this.viewport.pitchToX(pitch) + w / 2
    const color = this.theme.trackColors[0] ?? this.theme.nowLine
    this.particles.burst(cx, this.viewport.nowLineY, color, w)
  }

  setLiveNoteStore(store: LiveNoteStore): void {
    this.liveNoteStore = store
  }

  // Suppress (or restore) the upward-floating live-note sprites without
  // touching the keyboard-highlight path. A mode that wants the keyboard
  // to highlight presses without streaking notes up the roll (e.g. a
  // practice surface) flips this off on enter and restores on exit.
  setLiveNotesVisible(visible: boolean): void {
    if (this.liveNotesVisible === visible) return
    this.liveNotesVisible = visible
    if (!visible) this.liveNoteRenderer.clear()
  }

  // Hide/show the entire stage. Skips per-frame draw work (stage.visible=false
  // short-circuits child rendering in Pixi) and hides the underlying canvas so
  // nothing leaks through DOM layers above. Layout is preserved.
  setVisible(visible: boolean): void {
    this.app.stage.visible = visible
    this.app.canvas.style.visibility = visible ? '' : 'hidden'
  }

  setLoopNoteStore(store: LiveNoteStore | null): void {
    this.loopNoteStore = store
  }

  // Pitch → track color map of every key currently lit on the on-screen
  // keyboard. Re-populated each frame in `renderFrame`, so callers (chord
  // overlay, MIDI exporter sidebars, etc.) can read it once per tick.
  get currentActivePitches(): ReadonlyMap<number, number> {
    return this.activeKeyColors
  }

  // Set of MIDI pitches a "play these next" hint should highlight on the
  // keyboard. The renderer overlays them with a soft pulse, distinct from the
  // press-state colour so the hint reads as guidance rather than playback.
  setPracticeHints(
    pending: ReadonlySet<number> | null,
    accepted: ReadonlySet<number> | null,
  ): void {
    this.practiceHintPending = pending && pending.size > 0 ? pending : null
    this.practiceHintAccepted = accepted && accepted.size > 0 ? accepted : null
    this.keyboardRenderer.setPracticeHints(
      this.practiceHintPending,
      this.practiceHintAccepted,
      this.theme,
    )
    if (!this.midi && !(this.liveNoteStore?.hasRenderableNotes ?? false)) {
      // No render loop is running — paint once so the hint appears immediately.
      this.renderStaticFrame(0)
    }
  }

  isTrackVisible(trackId: string): boolean {
    return this.visibleTrackIds.has(trackId)
  }

  pauseAutoRender(): void {
    this.exportMode = true
    this.app.ticker.stop()
    this.particles.clear()
    this.prevActive.clear()
    this.currActive.clear()
    this.liveNoteRenderer.clear()
  }

  resumeAutoRender(): void {
    this.exportMode = false
    this.app.ticker.start()
  }

  get canvas(): HTMLCanvasElement {
    return this.app.canvas as HTMLCanvasElement
  }

  // Convert a client-space (canvas) point into a MIDI pitch if it lands on a key.
  pitchAtClientPoint(clientX: number, clientY: number): number | null {
    const rect = this.app.canvas.getBoundingClientRect()
    return this.viewport.pitchAtPoint(clientX - rect.left, clientY - rect.top)
  }

  // Current backing-store size + render resolution. Used by the exporter to
  // snapshot state before swapping in a custom export resolution.
  get canvasSize(): { width: number; height: number; resolution: number } {
    return {
      width: this.app.canvas.width,
      height: this.app.canvas.height,
      resolution: this.app.renderer.resolution,
    }
  }

  // Public resize — lets the exporter target an exact pixel size independent
  // of the window. Pass `resolution = 1` when exporting so the canvas backing
  // store matches the requested output dimensions exactly.
  resize(width: number, height: number, resolution?: number): void {
    if (resolution !== undefined && resolution !== this.app.renderer.resolution) {
      this.app.renderer.resolution = resolution
    }
    this.app.renderer.resize(width, height)
    this.viewport.update({ canvasWidth: width, canvasHeight: height })
    this.rebuildStaticLayers()
    this.renderStaticFrame(0)
  }

  private handleResize = (): void => {
    // Ignore viewport events during export — the exporter owns canvas size
    // until it restores it in its own finally block.
    if (this.exportMode) return
    this.resize(window.innerWidth, window.innerHeight)
    // Re-clamp keyboard height so a portrait-sized keyboard doesn't
    // dominate after rotation into landscape.
    const { min, max } = viewportKeyboardBounds()
    const clamped = Math.min(max, Math.max(min, this.keyboardHeight))
    if (clamped !== this.keyboardHeight) this.setKeyboardHeight(clamped)
  }

  destroy(): void {
    window.removeEventListener('resize', this.handleResize)
    this.app.destroy()
  }
}
