import type { MasterClock } from '../core/clock/MasterClock'
import type { VisualizationMode } from '../guitar/types'
import { createEventSignal, type EventSignal } from '../store/eventSignal'
import type { RenderLayer } from './RenderLayer'
import type { Theme } from './theme'
import type {
  LiveVoiceSource,
  SurfaceHit,
  VisualizationFrameSource,
  VisualizationHitId,
  VisualizationSurface,
} from './VisualizationSurface'

/** Constructs (and `init()`s) the guitar surface on first use. Lazy so a
 * piano-only session never pays for a second Pixi/WebGL context. */
export type GuitarSurfaceFactory = () => Promise<VisualizationSurface>

/** Pins one exact surface/canvas for the duration of an MP4 export. Acquire
 * before touching `resize`/`renderManualFrame`/etc. and drive those calls
 * through `lease.surface` directly (not through the router) so a visualization
 * switch requested mid-export can never change what's being captured — it's
 * deferred instead and applied once `release()` runs. */
export interface CaptureLease {
  readonly surface: VisualizationSurface
  release(currentTime: number): Promise<void>
}

interface CachedState {
  clock: MasterClock | null
  midi: VisualizationFrameSource | null
  liveStore: LiveVoiceSource | null
  loopStore: LiveVoiceSource | null
  liveNotesVisible: boolean
  theme: Theme | null
  practicePending: ReadonlySet<VisualizationHitId> | null
  practiceAccepted: ReadonlySet<VisualizationHitId> | null
  practiceTrackIds: readonly string[] | null
  resize: { width: number; height: number; resolution?: number } | null
  trackVisibility: Map<string, boolean>
}

function emptyCache(): CachedState {
  return {
    clock: null,
    midi: null,
    liveStore: null,
    loopStore: null,
    liveNotesVisible: true,
    theme: null,
    practicePending: null,
    practiceAccepted: null,
    practiceTrackIds: null,
    resize: null,
    trackVisibility: new Map(),
  }
}

/**
 * Routes `AppServices.renderer` calls to whichever concrete surface (piano or
 * guitar) is currently selected. `App` owns the piano surface (always
 * eagerly `init()`ed) and hands this router a lazy factory for the guitar
 * one — its Pixi/WebGL context is only paid for on first switch.
 *
 * Design points (see the G6 architecture review this class was rewritten
 * against):
 *
 * - **Cache + replay.** Every mount-time call (`loadMidi`, `setLiveNoteStore`,
 *   `setLoopNoteStore`, `setTheme`, `setLiveNotesVisible`, `setPracticeHints`,
 *   `setPracticeTrackFocus`, `attachClock`, `resize`) is cached here and
 *   applied to whichever surfaces currently exist. When guitar is lazily
 *   constructed, the full cache replays onto it *before* it's promoted to
 *   active — so a first-ever switch is never missing MIDI/theme/live-note
 *   state, and its geometry already matches the last known resize instead of
 *   whatever its own constructor defaulted to.
 * - **Stable identity signals.** `activeKeys`/`surfaceHits` are signals this
 *   router owns and re-publishes from whichever surface is active — a
 *   consumer that subscribes once (e.g. the Pi bridge) keeps tracking the
 *   right surface across a switch instead of staying bound to whichever was
 *   active at subscribe time.
 * - **Piano-only render layers.** A `RenderLayer` (e.g. Learn's overlay)
 *   mounts a Pixi `Container` into exactly one stage. Rather than faking a
 *   piano-shaped `Viewport` for guitar, layers are tracked here but only ever
 *   mounted while piano is active — unmounted before piano goes inactive,
 *   remounted when piano becomes active again. They simply don't render
 *   while guitar is on screen.
 * - **Capture lease.** `acquireCaptureLease()` pins the currently active
 *   surface; any `setMode` requested while a lease is held is deferred until
 *   `release()` so an MP4 export can never have its canvas swapped mid-flight.
 * - **Async + latest-wins.** `setMode` is async because activating guitar for
 *   the first time awaits its `init()`. If a newer `setMode` call lands before
 *   an in-flight one resolves, the stale resolution is discarded — the most
 *   recently requested mode always wins. Failure to construct the guitar
 *   surface rejects the returned promise so the caller (`App`) can roll back
 *   whatever triggered the switch (e.g. the persisted preference).
 * - **Centralized `canvas-hidden`.** This router is the only thing that
 *   touches `document.body.classList('canvas-hidden')` — neither concrete
 *   surface should.
 */
export class SurfaceRouter implements VisualizationSurface {
  private active: VisualizationSurface
  private mode: VisualizationMode = 'piano'
  private desiredVisible = true
  private readonly layers: RenderLayer[] = []
  private readonly cached: CachedState = emptyCache()

  private guitar: VisualizationSurface | null = null
  private guitarInit: Promise<VisualizationSurface> | null = null
  private requestToken = 0

  private leaseHolder: VisualizationSurface | null = null
  private leaseBarrierToken = 0
  private lastLeaseReleaseTime = 0
  private pendingSwitch: { mode: VisualizationMode } | null = null
  private pendingSwitchWaiters: Array<{
    resolve: () => void
    reject: (reason: unknown) => void
  }> = []

  private readonly _activeKeys = createEventSignal<ReadonlyMap<VisualizationHitId, number>>(
    new Map(),
  )
  private activeKeysUnsub: (() => void) | null = null
  private readonly _surfaceHits = createEventSignal<SurfaceHit | null>(null)
  private surfaceHitsUnsub: (() => void) | null = null

  constructor(
    private readonly piano: VisualizationSurface,
    private readonly guitarFactory: GuitarSurfaceFactory,
    private readonly beforeModeChange?: (from: VisualizationMode, to: VisualizationMode) => void,
  ) {
    this.active = piano
    this.rebindActiveSignals(piano)
  }

  get currentMode(): VisualizationMode {
    return this.mode
  }

  // ── Mode switching ──────────────────────────────────────────────────────

  /** Async: activating guitar for the first time awaits its `init()`. Defers
   * (queues) instead of applying immediately while a capture lease is held. */
  async setMode(mode: VisualizationMode, currentTime: number): Promise<void> {
    const token = ++this.requestToken
    if (this.leaseHolder) {
      return this.deferSwitch(mode)
    }
    await this.applyMode(mode, currentTime, token)
  }

  private async applyMode(
    mode: VisualizationMode,
    currentTime: number,
    token: number,
  ): Promise<void> {
    if (mode === this.mode) return

    let next: VisualizationSurface
    if (mode === 'guitar') {
      // Propagates a construction failure to the caller — App decides how to
      // roll back (e.g. reverting the persisted preference) rather than this
      // router silently pretending the switch worked.
      next = await this.ensureGuitar()
      // A stale request must never overwrite a newer deferred request.
      if (token !== this.requestToken) return
      if (token <= this.leaseBarrierToken) {
        if (this.leaseHolder) return this.deferSwitch(mode)
        currentTime = this.lastLeaseReleaseTime
      }
      // Latest-wins: a newer setMode() may have landed (and possibly already
      // resolved to piano) while we awaited guitar's init. A stale resolution
      // must not clobber it.
    } else {
      next = this.piano
    }

    const prev = this.active
    if (prev === next) {
      this.mode = mode
      return
    }

    this.beforeModeChange?.(this.mode, mode)

    if (prev === this.piano) {
      for (const layer of this.layers) prev.removeLayer(layer)
    }
    prev.pauseAutoRender()
    prev.setVisible(false)

    this.active = next
    this.mode = mode
    this.rebindActiveSignals(next)

    if (next === this.piano) {
      for (const layer of this.layers) next.addLayer(layer)
    }
    next.resumeAutoRender()
    next.setVisible(this.desiredVisible)
    next.renderStaticFrame(currentTime)
    document.body.classList.toggle('canvas-hidden', !this.desiredVisible)
  }

  private deferSwitch(mode: VisualizationMode): Promise<void> {
    this.pendingSwitch = { mode }
    return new Promise<void>((resolve, reject) => {
      this.pendingSwitchWaiters.push({ resolve, reject })
    })
  }

  private ensureGuitar(): Promise<VisualizationSurface> {
    if (this.guitar) return Promise.resolve(this.guitar)
    if (!this.guitarInit) {
      this.guitarInit = this.guitarFactory()
        .then((surface) => {
          this.applyCachedStateTo(surface)
          // A freshly-constructed surface defaults to visible/ticking (Pixi
          // stage.visible + a running ticker) — hide and pause it up front so
          // it can never be the *second* visible/pointer-active surface if
          // this particular construction goes on to lose a latest-wins race
          // in `applyMode` and is never promoted. Promotion (if it wins)
          // un-hides and resumes it right after.
          surface.setVisible(false)
          surface.pauseAutoRender()
          this.guitar = surface
          return surface
        })
        .catch((err) => {
          // Allow a later switch attempt to retry construction instead of
          // permanently caching the failure.
          this.guitarInit = null
          throw err
        })
    }
    return this.guitarInit
  }

  private applyCachedStateTo(surface: VisualizationSurface): void {
    const c = this.cached
    if (c.clock) surface.attachClock(c.clock)
    if (c.midi) surface.loadMidi(c.midi)
    if (c.liveStore) surface.setLiveNoteStore(c.liveStore)
    surface.setLoopNoteStore(c.loopStore)
    surface.setLiveNotesVisible(c.liveNotesVisible)
    if (c.theme) surface.setTheme(c.theme)
    surface.setPracticeHints(c.practicePending, c.practiceAccepted)
    surface.setPracticeTrackFocus(c.practiceTrackIds)
    for (const [trackId, visible] of c.trackVisibility) surface.setTrackVisible(trackId, visible)
    // Replays the last resize this router was told about so a surface built
    // long after boot (guitar, on first switch) starts with correct geometry
    // instead of whatever its own constructor happened to default to.
    if (c.resize) surface.resize(c.resize.width, c.resize.height, c.resize.resolution)
    // Layers are intentionally NOT replayed here — piano-only, see class doc.
  }

  private rebindActiveSignals(surface: VisualizationSurface): void {
    this.activeKeysUnsub?.()
    this._activeKeys.set(surface.activeKeys.value)
    this.activeKeysUnsub = surface.activeKeys.subscribe((v) => this._activeKeys.set(v))

    this.surfaceHitsUnsub?.()
    this._surfaceHits.set(null)
    this.surfaceHitsUnsub = surface.surfaceHits
      ? surface.surfaceHits.subscribe((hit) => this._surfaceHits.set(hit))
      : null
  }

  // ── Capture lease (MP4 export) ──────────────────────────────────────────

  acquireCaptureLease(): CaptureLease {
    if (this.leaseHolder) throw new Error('visualization capture lease already active')
    this.leaseHolder = this.active
    this.leaseBarrierToken = this.requestToken
    let releasePromise: Promise<void> | null = null
    return {
      surface: this.leaseHolder,
      release: (currentTime: number) => {
        if (releasePromise) return releasePromise
        releasePromise = (async () => {
          this.lastLeaseReleaseTime = currentTime
          this.leaseHolder = null
          const pending = this.pendingSwitch
          this.pendingSwitch = null
          const waiters = this.pendingSwitchWaiters
          this.pendingSwitchWaiters = []
          if (pending) {
            try {
              await this.setMode(pending.mode, currentTime)
              for (const waiter of waiters) waiter.resolve()
            } catch (err) {
              for (const waiter of waiters) waiter.reject(err)
              throw err
            }
          } else {
            for (const waiter of waiters) waiter.resolve()
          }
        })()
        return releasePromise
      },
    }
  }

  // ── Broadcast: cached + applied to every surface that currently exists ──

  async init(): Promise<void> {
    // No-op: `App` initializes the piano surface directly; guitar is
    // constructed lazily via `guitarFactory` on first switch.
  }

  attachClock(clock: MasterClock): void {
    this.cached.clock = clock
    this.piano.attachClock(clock)
    this.guitar?.attachClock(clock)
  }

  loadMidi(source: VisualizationFrameSource): void {
    this.cached.trackVisibility.clear()
    this.cached.midi = source
    this.piano.loadMidi(source)
    this.guitar?.loadMidi(source)
  }

  clearMidi(): void {
    this.cached.trackVisibility.clear()
    this.cached.midi = null
    this.piano.clearMidi()
    this.guitar?.clearMidi()
  }

  setTrackVisible(trackId: string, visible: boolean): void {
    this.cached.trackVisibility.set(trackId, visible)
    this.piano.setTrackVisible(trackId, visible)
    this.guitar?.setTrackVisible(trackId, visible)
  }

  setLiveNoteStore(store: LiveVoiceSource): void {
    this.cached.liveStore = store
    this.piano.setLiveNoteStore(store)
    this.guitar?.setLiveNoteStore(store)
  }

  setLoopNoteStore(store: LiveVoiceSource | null): void {
    this.cached.loopStore = store
    this.piano.setLoopNoteStore(store)
    this.guitar?.setLoopNoteStore(store)
  }

  setLiveNotesVisible(visible: boolean): void {
    this.cached.liveNotesVisible = visible
    this.piano.setLiveNotesVisible(visible)
    this.guitar?.setLiveNotesVisible(visible)
  }

  setTheme(theme: Theme): void {
    this.cached.theme = theme
    this.piano.setTheme(theme)
    this.guitar?.setTheme(theme)
  }

  setPracticeHints(
    pending: ReadonlySet<VisualizationHitId> | null,
    accepted: ReadonlySet<VisualizationHitId> | null,
  ): void {
    this.cached.practicePending = pending
    this.cached.practiceAccepted = accepted
    this.piano.setPracticeHints(pending, accepted)
    this.guitar?.setPracticeHints(pending, accepted)
  }

  setPracticeTrackFocus(trackIds: Iterable<string> | null): void {
    // `Iterable` may be a one-shot generator — snapshot so a later replay
    // (lazy guitar init) or the second surface doesn't get an exhausted one.
    const ids = trackIds ? Array.from(trackIds) : null
    this.cached.practiceTrackIds = ids
    this.piano.setPracticeTrackFocus(ids)
    this.guitar?.setPracticeTrackFocus(ids)
  }

  // ── Piano-only render layers ─────────────────────────────────────────────

  addLayer(layer: RenderLayer): void {
    if (this.layers.includes(layer)) return
    this.layers.push(layer)
    if (this.mode === 'piano') this.piano.addLayer(layer)
  }

  removeLayer(layer: RenderLayer): void {
    const idx = this.layers.indexOf(layer)
    if (idx < 0) return
    this.layers.splice(idx, 1)
    if (this.mode === 'piano') this.piano.removeLayer(layer)
  }

  destroy(): void {
    this.activeKeysUnsub?.()
    this.surfaceHitsUnsub?.()
    this.piano.destroy()
    this.guitar?.destroy()
  }

  // ── Stable identity signals (own subscription, see rebindActiveSignals) ──

  get activeKeys(): VisualizationSurface['activeKeys'] {
    return this._activeKeys
  }

  // Unlike the concrete surfaces (where this is optional — only interactive
  // ones implement it), the router always provides it: piano-only sessions
  // just never see it fire.
  get surfaceHits(): EventSignal<SurfaceHit | null> {
    return this._surfaceHits
  }

  // ── Active-surface-only: canvas/frame identity ───────────────────────────

  get canvas(): HTMLCanvasElement {
    return this.active.canvas
  }

  get canvasSize(): { width: number; height: number; resolution: number } {
    return this.active.canvasSize
  }

  get currentTheme(): Theme {
    return this.active.currentTheme
  }

  get currentViewport(): VisualizationSurface['currentViewport'] {
    return this.active.currentViewport
  }

  // Cached + broadcast to every surface that currently exists (like
  // loadMidi/setTheme/etc.), unlike the active-surface-only ops above — a
  // lazily-constructed guitar replays it from the cache in
  // `applyCachedStateTo` so its very first frame is already sized correctly
  // instead of momentarily using its own construction-time default.
  resize(width: number, height: number, resolution?: number): void {
    this.cached.resize = { width, height, ...(resolution !== undefined ? { resolution } : {}) }
    this.piano.resize(width, height, resolution)
    this.guitar?.resize(width, height, resolution)
  }

  renderStaticFrame(currentTime: number): void {
    this.active.renderStaticFrame(currentTime)
  }

  renderManualFrame(time: number, dt: number): void {
    this.active.renderManualFrame(time, dt)
  }

  pauseAutoRender(): void {
    this.active.pauseAutoRender()
  }

  resumeAutoRender(): void {
    this.active.resumeAutoRender()
  }

  setVisible(visible: boolean): void {
    this.desiredVisible = visible
    this.active.setVisible(visible)
    document.body.classList.toggle('canvas-hidden', !visible)
  }
}
