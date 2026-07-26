import { describe, expect, it, vi } from 'vitest'
import type { RenderLayer } from './RenderLayer'
import type { GuitarSurfaceFactory } from './SurfaceRouter'
import { SurfaceRouter } from './SurfaceRouter'
import type { SurfaceHit, VisualizationSurface } from './VisualizationSurface'

// Hand-built fake surfaces (no Pixi/WebGL) so these tests exercise the
// router's own broadcast/cache/lazy-construction/migration logic in
// isolation — the concrete surfaces (PianoRollRenderer, GuitarSurface) each
// have their own contract tests.
function fakeSurface(
  name: string,
  opts: { interactive?: boolean } = {},
): VisualizationSurface & {
  name: string
  emitActiveKeys: (v: ReadonlyMap<number, number>) => void
  emitHit: (hit: SurfaceHit | null) => void
} {
  let activeKeysValue: ReadonlyMap<number, number> = new Map()
  const activeKeysListeners = new Set<(v: ReadonlyMap<number, number>) => void>()
  const activeKeys = {
    get value() {
      return activeKeysValue
    },
    set: (v: ReadonlyMap<number, number>) => {
      activeKeysValue = v
      for (const fn of activeKeysListeners) fn(v)
    },
    subscribe: (fn: (v: ReadonlyMap<number, number>) => void) => {
      activeKeysListeners.add(fn)
      return () => activeKeysListeners.delete(fn)
    },
  }

  let hitsValue: SurfaceHit | null = null
  const hitsListeners = new Set<(v: SurfaceHit | null) => void>()
  const surfaceHits = {
    get value() {
      return hitsValue
    },
    set: (v: SurfaceHit | null) => {
      hitsValue = v
      for (const fn of hitsListeners) fn(v)
    },
    subscribe: (fn: (v: SurfaceHit | null) => void) => {
      hitsListeners.add(fn)
      return () => hitsListeners.delete(fn)
    },
  }

  return {
    name,
    activeKeys,
    ...(opts.interactive ? { surfaceHits } : {}),
    emitActiveKeys: activeKeys.set,
    emitHit: opts.interactive ? surfaceHits.set : () => undefined,
    init: vi.fn(async () => {}),
    attachClock: vi.fn(),
    destroy: vi.fn(),
    loadMidi: vi.fn(),
    clearMidi: vi.fn(),
    setTrackVisible: vi.fn(),
    setLiveNoteStore: vi.fn(),
    setLoopNoteStore: vi.fn(),
    setLiveNotesVisible: vi.fn(),
    resize: vi.fn(),
    canvasSize: { width: 800, height: 600, resolution: 1 },
    renderStaticFrame: vi.fn(),
    renderManualFrame: vi.fn(),
    pauseAutoRender: vi.fn(),
    resumeAutoRender: vi.fn(),
    setVisible: vi.fn(),
    setPracticeHints: vi.fn(),
    setPracticeTrackFocus: vi.fn(),
    addLayer: vi.fn(),
    removeLayer: vi.fn(),
    canvas: { name } as unknown as HTMLCanvasElement,
    setTheme: vi.fn(),
    currentTheme: { name: `${name}-theme` } as never,
    currentViewport: undefined,
  }
}

function fakeLayer(id: string): RenderLayer {
  return { id, zIndex: 5, mount: vi.fn(), unmount: vi.fn(), update: vi.fn(), rebuild: vi.fn() }
}

function fakeHit(overrides: Partial<SurfaceHit> = {}): SurfaceHit {
  return {
    type: 'note-on',
    pitch: 40,
    velocity: 0.8,
    sourceId: 'guitar',
    voiceId: 'guitar:1',
    ...overrides,
  }
}

// Deferred factory: lets a test control exactly when guitar construction
// resolves/rejects, to exercise latest-wins and retry-after-failure.
function deferredFactory(guitar: VisualizationSurface): {
  factory: GuitarSurfaceFactory
  resolve: () => void
  reject: (err: unknown) => void
  callCount: () => number
} {
  let calls = 0
  let resolveFn: (() => void) | null = null
  let rejectFn: ((err: unknown) => void) | null = null
  const factory: GuitarSurfaceFactory = () => {
    calls++
    return new Promise((res, rej) => {
      resolveFn = () => res(guitar)
      rejectFn = rej
    })
  }
  return {
    factory,
    resolve: () => resolveFn?.(),
    reject: (err: unknown) => rejectFn?.(err),
    callCount: () => calls,
  }
}

describe('SurfaceRouter', () => {
  it('starts on piano and stays there until setMode switches', () => {
    const piano = fakeSurface('piano')
    const guitarFactory = vi.fn(async () => fakeSurface('guitar'))
    const router = new SurfaceRouter(piano, guitarFactory)
    expect(router.currentMode).toBe('piano')
    expect(router.canvas).toBe(piano.canvas)
  })

  // ── Requirement 1: lazy guitar construction ─────────────────────────────
  describe('lazy guitar construction', () => {
    it('never calls the guitar factory for a piano-only session', async () => {
      const piano = fakeSurface('piano')
      const guitarFactory = vi.fn(async () => fakeSurface('guitar'))
      const router = new SurfaceRouter(piano, guitarFactory)

      router.loadMidi({ name: 'song' } as never)
      router.setTheme({ name: 'theme' } as never)
      router.resize(1024, 768)
      router.destroy()

      expect(guitarFactory).not.toHaveBeenCalled()
    })

    it('constructs guitar exactly once even across repeated switches', async () => {
      const piano = fakeSurface('piano')
      const guitar = fakeSurface('guitar')
      const guitarFactory = vi.fn(async () => guitar)
      const router = new SurfaceRouter(piano, guitarFactory)

      await router.setMode('guitar', 0)
      await router.setMode('piano', 0)
      await router.setMode('guitar', 0)

      expect(guitarFactory).toHaveBeenCalledTimes(1)
      expect(router.currentMode).toBe('guitar')
    })
  })

  // ── Requirement 2: stable activeKeys/surfaceHits signals ────────────────
  describe('stable activeKeys / surfaceHits signals', () => {
    it('activeKeys re-publishes from whichever surface is active, seeded immediately on switch', async () => {
      const piano = fakeSurface('piano')
      const guitar = fakeSurface('guitar')
      const router = new SurfaceRouter(piano, async () => guitar)

      const seen: Array<ReadonlyMap<number, number>> = []
      router.activeKeys.subscribe((v) => seen.push(v))

      piano.emitActiveKeys(new Map([[60, 1]]))
      expect(seen.at(-1)).toEqual(new Map([[60, 1]]))

      guitar.emitActiveKeys(new Map([[40, 2]]))
      // Guitar isn't active yet — its updates must not leak through.
      expect(seen.at(-1)).toEqual(new Map([[60, 1]]))

      guitar.activeKeys.set(new Map([[41, 3]]))
      await router.setMode('guitar', 0)
      // Rebind seeds the router's signal with the newly-active surface's
      // *current* value immediately, not just future changes.
      expect(router.activeKeys.value).toEqual(new Map([[41, 3]]))

      piano.emitActiveKeys(new Map([[62, 9]]))
      // Piano is inactive now — its updates must not leak through either.
      expect(router.activeKeys.value).toEqual(new Map([[41, 3]]))

      guitar.emitActiveKeys(new Map([[43, 4]]))
      expect(router.activeKeys.value).toEqual(new Map([[43, 4]]))
    })

    it('surfaceHits stays null while an interactive surface is inactive and starts firing once it becomes active', async () => {
      const piano = fakeSurface('piano') // non-interactive: no surfaceHits
      const guitar = fakeSurface('guitar', { interactive: true })
      const router = new SurfaceRouter(piano, async () => guitar)

      const seen: Array<SurfaceHit | null> = []
      router.surfaceHits.subscribe((v) => seen.push(v))

      await router.setMode('guitar', 0)
      const hit = fakeHit()
      guitar.emitHit(hit)
      expect(seen.at(-1)).toBe(hit)
    })

    it('rebinding on switch unsubscribes from the outgoing surface', async () => {
      const piano = fakeSurface('piano', { interactive: true })
      const guitar = fakeSurface('guitar', { interactive: true })
      const router = new SurfaceRouter(piano, async () => guitar)

      const seen: Array<SurfaceHit | null> = []
      router.surfaceHits.subscribe((v) => seen.push(v))

      await router.setMode('guitar', 0)
      seen.length = 0
      // Piano is no longer subscribed — a stray late event from it (e.g. an
      // in-flight gesture that resolves after the switch) must not surface.
      piano.emitHit(fakeHit({ sourceId: 'piano' }))
      expect(seen).toHaveLength(0)
    })

    it('destroy() unsubscribes from the active surface', () => {
      const piano = fakeSurface('piano', { interactive: true })
      const router = new SurfaceRouter(piano, async () => fakeSurface('guitar'))
      const seen: Array<SurfaceHit | null> = []
      router.surfaceHits.subscribe((v) => seen.push(v))

      router.destroy()
      piano.emitHit(fakeHit())
      expect(seen).toHaveLength(0)
    })
  })

  describe('broadcasts mount-time state to every surface that currently exists', () => {
    it('loadMidi / clearMidi reach piano immediately and guitar once constructed', async () => {
      const piano = fakeSurface('piano')
      const guitar = fakeSurface('guitar')
      const router = new SurfaceRouter(piano, async () => guitar)
      const midi = { name: 'song.mid' } as never

      router.loadMidi(midi)
      expect(piano.loadMidi).toHaveBeenCalledWith(midi)
      expect(guitar.loadMidi).not.toHaveBeenCalled()

      // First switch replays the full cache onto the newly-built surface.
      await router.setMode('guitar', 0)
      expect(guitar.loadMidi).toHaveBeenCalledWith(midi)

      router.clearMidi()
      expect(piano.clearMidi).toHaveBeenCalled()
      expect(guitar.clearMidi).toHaveBeenCalled()
    })

    it('setLiveNoteStore / setTheme / setPracticeHints / attachClock replay onto a lazily-built guitar', async () => {
      const piano = fakeSurface('piano')
      const guitar = fakeSurface('guitar')
      const router = new SurfaceRouter(piano, async () => guitar)
      const store = { id: 'live' } as never
      const theme = { name: 'Sunset' } as never
      const pending = new Set([60])
      const accepted = new Set([64])
      const clock = {} as never

      router.setLiveNoteStore(store)
      router.setTheme(theme)
      router.setPracticeHints(pending, accepted)
      router.setPracticeTrackFocus(['track-a'])
      router.attachClock(clock)

      await router.setMode('guitar', 0)

      expect(guitar.setLiveNoteStore).toHaveBeenCalledWith(store)
      expect(guitar.setTheme).toHaveBeenCalledWith(theme)
      expect(guitar.setPracticeHints).toHaveBeenCalledWith(pending, accepted)
      expect(guitar.setPracticeTrackFocus).toHaveBeenCalledWith(['track-a'])
      expect(guitar.attachClock).toHaveBeenCalledWith(clock)
    })

    it('destroy only tears down surfaces that were actually constructed', () => {
      const piano = fakeSurface('piano')
      const guitarFactory = vi.fn(async () => fakeSurface('guitar'))
      const router = new SurfaceRouter(piano, guitarFactory)

      router.destroy()
      expect(piano.destroy).toHaveBeenCalled()
      expect(guitarFactory).not.toHaveBeenCalled()
    })
  })

  // ── Requirement 5: resize caching + replay ──────────────────────────────
  describe('resize', () => {
    it('is cached and applied to every surface that currently exists', () => {
      const piano = fakeSurface('piano')
      const guitarFactory = vi.fn(async () => fakeSurface('guitar'))
      const router = new SurfaceRouter(piano, guitarFactory)

      router.resize(1024, 768, 2)
      expect(piano.resize).toHaveBeenCalledWith(1024, 768, 2)
    })

    it('replays the last resize onto a lazily-constructed guitar so its first-switch geometry is correct', async () => {
      const piano = fakeSurface('piano')
      const guitar = fakeSurface('guitar')
      const router = new SurfaceRouter(piano, async () => guitar)

      router.resize(1024, 768, 2)
      expect(guitar.resize).not.toHaveBeenCalled()

      await router.setMode('guitar', 0)
      expect(guitar.resize).toHaveBeenCalledWith(1024, 768, 2)
    })

    it('a later resize reaches both surfaces once guitar exists', async () => {
      const piano = fakeSurface('piano')
      const guitar = fakeSurface('guitar')
      const router = new SurfaceRouter(piano, async () => guitar)
      await router.setMode('guitar', 0)
      vi.clearAllMocks()

      router.resize(640, 480)
      expect(piano.resize).toHaveBeenCalledWith(640, 480, undefined)
      expect(guitar.resize).toHaveBeenCalledWith(640, 480, undefined)
    })
  })

  describe('setMode switching', () => {
    it('caches track visibility and replays it before a lazy guitar is promoted', async () => {
      const piano = fakeSurface('piano')
      const guitar = fakeSurface('guitar')
      const router = new SurfaceRouter(piano, async () => guitar)

      router.setTrackVisible('melody', false)
      expect(piano.setTrackVisible).toHaveBeenCalledWith('melody', false)
      expect(guitar.setTrackVisible).not.toHaveBeenCalled()
      await router.setMode('guitar', 0)
      expect(guitar.setTrackVisible).toHaveBeenCalledWith('melody', false)

      router.setTrackVisible('melody', true)
      expect(piano.setTrackVisible).toHaveBeenLastCalledWith('melody', true)
      expect(guitar.setTrackVisible).toHaveBeenLastCalledWith('melody', true)
    })

    it('clears cached track visibility for a new MIDI before lazy replay', async () => {
      const piano = fakeSurface('piano')
      const guitar = fakeSurface('guitar')
      const router = new SurfaceRouter(piano, async () => guitar)
      router.setTrackVisible('reused-id', false)
      router.loadMidi({ name: 'new.mid' } as never)
      await router.setMode('guitar', 0)
      expect(guitar.setTrackVisible).not.toHaveBeenCalledWith('reused-id', false)
    })

    it('pauses + hides the outgoing surface and wakes + shows the incoming one at the given time', async () => {
      const piano = fakeSurface('piano')
      const guitar = fakeSurface('guitar')
      const router = new SurfaceRouter(piano, async () => guitar)

      await router.setMode('guitar', 12.5)

      expect(piano.pauseAutoRender).toHaveBeenCalled()
      expect(piano.setVisible).toHaveBeenCalledWith(false)
      expect(guitar.resumeAutoRender).toHaveBeenCalled()
      expect(guitar.setVisible).toHaveBeenLastCalledWith(true)
      expect(guitar.renderStaticFrame).toHaveBeenCalledWith(12.5)
      expect(router.currentMode).toBe('guitar')
    })

    it('is a no-op when already on the requested mode', async () => {
      const piano = fakeSurface('piano')
      const router = new SurfaceRouter(piano, async () => fakeSurface('guitar'))
      await router.setMode('piano', 5)
      expect(piano.pauseAutoRender).not.toHaveBeenCalled()
      expect(piano.setVisible).not.toHaveBeenCalled()
    })

    it('carries the last requested visibility onto the newly active surface', async () => {
      const piano = fakeSurface('piano')
      const guitar = fakeSurface('guitar')
      const router = new SurfaceRouter(piano, async () => guitar)
      // Learn's hub view hides the surface while piano is active...
      router.setVisible(false)
      expect(piano.setVisible).toHaveBeenLastCalledWith(false)
      // ...switching to guitar must not flash it visible before the caller
      // re-shows it.
      await router.setMode('guitar', 0)
      expect(guitar.setVisible).toHaveBeenLastCalledWith(false)
    })
  })

  // ── Requirement 8: async first init — latest-wins + retryable ──────────
  describe('async setMode — latest-wins and retry-after-failure', () => {
    it('a stale guitar resolution that loses a latest-wins race never gets promoted, and is left hidden + paused', async () => {
      const piano = fakeSurface('piano')
      const guitar = fakeSurface('guitar')
      const { factory, resolve } = deferredFactory(guitar)
      const router = new SurfaceRouter(piano, factory)

      const first = router.setMode('guitar', 0)
      // A second call before the first resolves — piano was already active,
      // so this is an immediate no-op, but it bumps the latest-wins token.
      const second = router.setMode('piano', 0)
      resolve()
      await Promise.all([first, second])

      expect(router.currentMode).toBe('piano')
      expect(router.canvas).toBe(piano.canvas)
      // Guitar was fully constructed (and cache-replayed) but never promoted
      // — it must not be left visible/ticking as a second active surface.
      expect(guitar.setVisible).toHaveBeenCalledWith(false)
      expect(guitar.pauseAutoRender).toHaveBeenCalled()
      expect(guitar.resumeAutoRender).not.toHaveBeenCalled()
    })

    it('rejects the returned promise on construction failure and never marks guitar active', async () => {
      const piano = fakeSurface('piano')
      const { factory, reject } = deferredFactory(fakeSurface('guitar'))
      const router = new SurfaceRouter(piano, factory)

      const pending = router.setMode('guitar', 0)
      reject(new Error('WebGL unavailable'))
      await expect(pending).rejects.toThrow('WebGL unavailable')
      expect(router.currentMode).toBe('piano')
    })

    it('is retryable: a failed construction does not poison later attempts', async () => {
      const piano = fakeSurface('piano')
      const guitar = fakeSurface('guitar')
      let attempt = 0
      const guitarFactory: GuitarSurfaceFactory = vi.fn(async () => {
        attempt++
        if (attempt === 1) throw new Error('first attempt fails')
        return guitar
      })
      const router = new SurfaceRouter(piano, guitarFactory)

      await expect(router.setMode('guitar', 0)).rejects.toThrow('first attempt fails')
      expect(router.currentMode).toBe('piano')

      await router.setMode('guitar', 0)
      expect(router.currentMode).toBe('guitar')
      expect(guitarFactory).toHaveBeenCalledTimes(2)
    })
  })

  describe('layer migration (piano-only)', () => {
    it('mounts a registered layer on the incoming surface only while it is piano, and unmounts before piano goes inactive', async () => {
      const piano = fakeSurface('piano')
      const guitar = fakeSurface('guitar')
      const router = new SurfaceRouter(piano, async () => guitar)
      const layer = fakeLayer('learn-overlay')

      router.addLayer(layer)
      expect(piano.addLayer).toHaveBeenCalledWith(layer)
      expect(guitar.addLayer).not.toHaveBeenCalled()

      await router.setMode('guitar', 0)
      expect(piano.removeLayer).toHaveBeenCalledWith(layer)
      // Never mounted on guitar, even once it's the active surface — no
      // piano-shaped compatibility viewport is faked for it.
      expect(guitar.addLayer).not.toHaveBeenCalled()

      await router.setMode('piano', 0)
      expect(piano.addLayer).toHaveBeenCalledTimes(2)
    })

    it('addLayer is idempotent for the same layer instance', () => {
      const piano = fakeSurface('piano')
      const router = new SurfaceRouter(piano, async () => fakeSurface('guitar'))
      const layer = fakeLayer('learn-overlay')
      router.addLayer(layer)
      router.addLayer(layer)
      expect(piano.addLayer).toHaveBeenCalledTimes(1)
    })

    it('removeLayer stops it from remounting on a later return to piano', async () => {
      const piano = fakeSurface('piano')
      const guitar = fakeSurface('guitar')
      const router = new SurfaceRouter(piano, async () => guitar)
      const layer = fakeLayer('learn-overlay')
      router.addLayer(layer)
      router.removeLayer(layer)
      await router.setMode('guitar', 0)
      await router.setMode('piano', 0)
      expect(piano.addLayer).toHaveBeenCalledTimes(1) // only the initial addLayer() call
    })
  })

  // ── Requirement 4: capture lease ────────────────────────────────────────
  describe('capture lease', () => {
    it('rejects a nested lease and release is idempotent', async () => {
      const router = new SurfaceRouter(fakeSurface('piano'), async () => fakeSurface('guitar'))
      const lease = router.acquireCaptureLease()
      expect(() => router.acquireCaptureLease()).toThrow('already active')
      const firstRelease = lease.release(1)
      const secondRelease = lease.release(2)
      expect(secondRelease).toBe(firstRelease)
      await firstRelease
      expect(() => router.acquireCaptureLease()).not.toThrow()
    })

    it('does not promote a guitar whose factory resolves after piano was leased', async () => {
      const piano = fakeSurface('piano')
      const guitar = fakeSurface('guitar')
      const { factory, resolve } = deferredFactory(guitar)
      const router = new SurfaceRouter(piano, factory)
      const switching = router.setMode('guitar', 2)
      const lease = router.acquireCaptureLease()
      resolve()
      await Promise.resolve()
      expect(router.currentMode).toBe('piano')
      expect(lease.surface).toBe(piano)
      await lease.release(9)
      await switching
      expect(guitar.renderStaticFrame).toHaveBeenLastCalledWith(9)
    })

    it('uses restored release time when the lease is released before lazy init resolves', async () => {
      const piano = fakeSurface('piano')
      const guitar = fakeSurface('guitar')
      const { factory, resolve } = deferredFactory(guitar)
      const router = new SurfaceRouter(piano, factory)
      const switching = router.setMode('guitar', 99)
      const lease = router.acquireCaptureLease()
      await lease.release(7)
      resolve()
      await switching
      expect(guitar.renderStaticFrame).toHaveBeenLastCalledWith(7)
    })

    it('does not let a stale guitar init replace a newer deferred piano request', async () => {
      const piano = fakeSurface('piano')
      const guitar = fakeSurface('guitar')
      const { factory, resolve } = deferredFactory(guitar)
      const router = new SurfaceRouter(piano, factory)
      const staleGuitar = router.setMode('guitar', 1)
      const lease = router.acquireCaptureLease()
      const latestPiano = router.setMode('piano', 2)
      resolve()
      await lease.release(7)
      await Promise.all([staleGuitar, latestPiano])
      expect(router.currentMode).toBe('piano')
      expect(guitar.resumeAutoRender).not.toHaveBeenCalled()
    })

    it('rejects deferred callers when the lazy factory fails', async () => {
      const router = new SurfaceRouter(fakeSurface('piano'), async () => {
        throw new Error('factory failed')
      })
      const lease = router.acquireCaptureLease()
      const switching = router.setMode('guitar', 0)
      await expect(lease.release(7)).rejects.toThrow('factory failed')
      await expect(switching).rejects.toThrow('factory failed')
    })

    it('pins the currently active surface', async () => {
      const piano = fakeSurface('piano')
      const guitar = fakeSurface('guitar')
      const router = new SurfaceRouter(piano, async () => guitar)
      await router.setMode('guitar', 0)

      const lease = router.acquireCaptureLease()
      expect(lease.surface).toBe(guitar)
    })

    it('defers a setMode requested while the lease is held', async () => {
      const piano = fakeSurface('piano')
      const guitar = fakeSurface('guitar')
      const router = new SurfaceRouter(piano, async () => guitar)

      const lease = router.acquireCaptureLease()
      const switching = router.setMode('guitar', 0)
      // Deferred — guitar must not have been constructed or promoted yet.
      expect(router.currentMode).toBe('piano')

      await lease.release(0)
      await switching
      expect(router.currentMode).toBe('guitar')
    })

    it('latest request wins when multiple switches are requested during one lease', async () => {
      const piano = fakeSurface('piano')
      const guitar = fakeSurface('guitar')
      const router = new SurfaceRouter(piano, async () => guitar)

      const lease = router.acquireCaptureLease()
      void router.setMode('guitar', 0)
      void router.setMode('piano', 0)
      const last = router.setMode('guitar', 3)

      await lease.release(3)
      await last
      expect(router.currentMode).toBe('guitar')
      expect(guitar.renderStaticFrame).toHaveBeenCalledWith(3)
    })

    it('a switch requested with no lease held applies immediately', async () => {
      const piano = fakeSurface('piano')
      const guitar = fakeSurface('guitar')
      const router = new SurfaceRouter(piano, async () => guitar)
      await router.setMode('guitar', 0)
      expect(router.currentMode).toBe('guitar')
    })
  })

  // ── Active-surface-only: this is what makes MP4 export capture "whichever
  // surface is on screen" for free — `canvas`/`canvasSize`/`renderManualFrame`
  // all resolve against the currently active surface.
  describe('active-surface-only delegation (export selection)', () => {
    it('canvas/canvasSize track the active surface across a switch', async () => {
      const piano = fakeSurface('piano')
      const guitar = fakeSurface('guitar')
      const router = new SurfaceRouter(piano, async () => guitar)
      expect(router.canvas).toBe(piano.canvas)

      await router.setMode('guitar', 0)
      expect(router.canvas).toBe(guitar.canvas)
      expect(router.canvasSize).toBe(guitar.canvasSize)
    })

    it('renderManualFrame / pauseAutoRender / resumeAutoRender only touch the active surface', async () => {
      const piano = fakeSurface('piano')
      const guitar = fakeSurface('guitar')
      const router = new SurfaceRouter(piano, async () => guitar)
      await router.setMode('guitar', 0)
      vi.clearAllMocks()

      router.renderManualFrame(3, 0.016)
      router.pauseAutoRender()
      router.resumeAutoRender()

      expect(guitar.renderManualFrame).toHaveBeenCalledWith(3, 0.016)
      expect(guitar.pauseAutoRender).toHaveBeenCalled()
      expect(guitar.resumeAutoRender).toHaveBeenCalled()
      expect(piano.renderManualFrame).not.toHaveBeenCalled()
    })

    it('currentTheme / activeKeys / currentViewport read from the active surface', async () => {
      const piano = fakeSurface('piano')
      const guitar = fakeSurface('guitar')
      const router = new SurfaceRouter(piano, async () => guitar)
      expect(router.currentTheme).toBe(piano.currentTheme)
      await router.setMode('guitar', 0)
      expect(router.currentTheme).toBe(guitar.currentTheme)
      expect(router.currentViewport).toBe(guitar.currentViewport)
    })
  })
})
