import { describe, expect, it, vi } from 'vitest'
import type { MidiFile } from '../core/midi/types'
import { LearnController } from './LearnController'

const runnerLaunch = vi.hoisted(() => vi.fn(() => Promise.resolve()))
const runnerClose = vi.hoisted(() => vi.fn(() => null))
const createSessionSummaryMock = vi.hoisted(() =>
  vi.fn(() => ({ show: vi.fn(), dismiss: vi.fn() })),
)

// LearnOverlay pulls in PixiJS (Container / Graphics) which needs a real
// WebGL context — not available in jsdom. Mock the whole module so
// `new LearnOverlay()` returns a plain object with enough of the surface to
// satisfy the controller without touching graphics.
vi.mock('../learn/overlays/LearnOverlay', () => ({
  LearnOverlay: class {
    pulseTargetZone() {}
    drawLoopBand() {}
    celebrationSwell() {}
    update() {}
  },
}))

// ExerciseRunner.launch mounts a full exercise (Solid render + Tone). Mocking
// it keeps the test focused on the controller's drain behaviour without
// pulling in the entire play-along lifecycle.
vi.mock('../learn/core/ExerciseRunner', () => ({
  ExerciseRunner: class {
    get isActive() {
      return false
    }
    get activeId() {
      return null
    }
    launch = runnerLaunch
    close = runnerClose
  },
}))

// LearnHub.mount calls solid-js/web `render` which tries to insert DOM.
// Mocking it keeps the test hermetic (no stray Solid roots to clean up) and
// avoids a dependency on the full catalog / i18n surface.
vi.mock('../learn/hub/LearnHub', () => ({
  createLearnHub: () => ({ mount: () => {}, unmount: () => {} }),
}))

// SessionSummary renders HTML into the hub host after an exercise closes.
// Not exercised by these tests; mocking prevents stray DOM side-effects.
vi.mock('../learn/ui/SessionSummary', () => ({
  createSessionSummary: createSessionSummaryMock,
}))

vi.mock('../telemetry', () => ({
  track: vi.fn(),
  trackEvent: vi.fn(),
}))

// play-along/index.ts imports `getContext` from 'tone'; tone's ESM build
// references internal paths that don't resolve in vitest's Node environment.
// Mock the descriptor directly so the catalog + controller never trigger
// the Tone import chain.
vi.mock('../learn/exercises/play-along', () => ({
  playAlongDescriptor: {
    id: 'play-along',
    get title() {
      return 'Play Along'
    },
    category: 'play-along',
    difficulty: 'beginner',
    get blurb() {
      return ''
    },
    factory: () => ({}),
  },
}))

// catalog.ts re-imports playAlongDescriptor; mock it independently so
// findExercise(id) also avoids the Tone resolution chain.
vi.mock('../learn/hub/catalog', () => ({
  findExercise: vi.fn(() => undefined),
  CATALOG: [],
}))

// ── Helpers ───────────────────────────────────────────────────────────────

function makeMidi(name = 'test.mid'): MidiFile {
  return {
    name,
    duration: 30,
    bpm: 120,
    timeSignature: [4, 4] as [number, number],
    tracks: [],
  }
}

function makeFakeCtx() {
  const storeState = { mode: 'play' as const }
  return {
    services: {
      store: {
        state: storeState,
        setState: vi.fn((key: string, val: unknown) => {
          ;(storeState as Record<string, unknown>)[key] = val
        }),
        setVisualizationForced: vi.fn(),
      },
      clock: {
        currentTime: 0,
        pause: vi.fn(),
        seek: vi.fn(),
        subscribe: vi.fn(() => () => {}),
      },
      synth: {
        pause: vi.fn(),
        play: vi.fn().mockResolvedValue(undefined),
        load: vi.fn().mockResolvedValue(undefined),
      },
      renderer: {
        clearMidi: vi.fn(),
        loadMidi: vi.fn(),
        setLiveNotesVisible: vi.fn(),
        addLayer: vi.fn(),
        removeLayer: vi.fn(),
        setVisible: vi.fn(),
      },
      input: null as never,
      metronome: null as never,
    },
    overlay: document.createElement('div'),
    trackPanel: { close: vi.fn() },
    dropzone: { hide: vi.fn() },
    keyboardInput: { enable: vi.fn(), disable: vi.fn() },
    midiInput: null as never,
    resetInteractionState: vi.fn(),
    openFilePicker: vi.fn(),
    primeInteractiveAudio: vi.fn(),
    setLearnFileName: vi.fn(),
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('LearnController.queueMidi', () => {
  it('does not consume the MIDI before enter() is called', () => {
    const ctrl = new LearnController(makeFakeCtx() as never)
    ctrl.queueMidi(makeMidi())
    // learnState should still be clean — nothing was loaded yet.
    expect(ctrl.learnState.state.loadedMidi).toBeNull()
  })

  it('enter() drains the queued MIDI into learnState', async () => {
    const ctx = makeFakeCtx()
    const ctrl = new LearnController(ctx as never)
    const midi = makeMidi('piece.mid')
    ctrl.queueMidi(midi)
    ctrl.enter()
    // consumeMidi fires synth.load asynchronously but calls
    // learnState.completeLoad synchronously — flush the microtask queue so
    // any void-async tails settle.
    await Promise.resolve()
    // Solid stores wrap values in reactive proxies, so reference equality
    // fails; check the name field as a stable identity proxy instead.
    expect(ctrl.learnState.state.loadedMidi?.name).toBe('piece.mid')
  })

  it('clears the queue after enter() so a second enter() does not replay the MIDI', async () => {
    const ctx = makeFakeCtx()
    const ctrl = new LearnController(ctx as never)
    ctrl.queueMidi(makeMidi())
    ctrl.enter()
    await Promise.resolve()
    const firstMidi = ctrl.learnState.state.loadedMidi

    // Simulate a hub back-button → re-enter without queuing anything.
    ctrl.exit()
    ctrl.enter()
    await Promise.resolve()

    // Second enter must NOT re-load the first MIDI; the hub starts clean.
    expect(ctrl.learnState.state.loadedMidi).toBeNull()
    // First midi was genuinely loaded during the first session.
    expect(firstMidi).not.toBeNull()
  })

  it('enter() without a queued MIDI leaves learnState empty', async () => {
    const ctrl = new LearnController(makeFakeCtx() as never)
    ctrl.enter()
    await Promise.resolve()
    expect(ctrl.learnState.state.loadedMidi).toBeNull()
  })

  it('exposes the queued name via setLearnFileName after drain', async () => {
    const ctx = makeFakeCtx()
    const ctrl = new LearnController(ctx as never)
    ctrl.queueMidi(makeMidi('bach-prelude.mid'))
    ctrl.enter()
    await Promise.resolve()
    expect(ctx.setLearnFileName).toHaveBeenCalledWith('bach-prelude.mid')
  })
})

// `launchExercise` is private — the hub UI is mocked out (see the
// `createLearnHub` mock above), so it's the only way to drive a non-default
// exercise without standing up the real catalog/hub DOM. Casting to reach it
// tests the forcing/restoration policy directly, independent of hub wiring.
interface LaunchExerciseAccess {
  launchExercise(descriptor: { id: string; category: string }): Promise<void>
  consumeMidi(midi: MidiFile): Promise<void>
}

describe('LearnController visualization forcing', () => {
  const sightReading = { id: 'sight-reading', category: 'sight-reading' }
  const playAlongLike = { id: 'play-along', category: 'play-along' }

  it('forces piano and disables the selector for a non-play-along exercise', async () => {
    const ctx = makeFakeCtx()
    const ctrl = new LearnController(ctx as never)
    ctrl.enter()
    await Promise.resolve()
    await (ctrl as unknown as LaunchExerciseAccess).launchExercise(sightReading)
    expect(ctx.services.store.setVisualizationForced).toHaveBeenLastCalledWith('piano')
  })

  it('clears the force when the launched exercise is play-along', async () => {
    const ctx = makeFakeCtx()
    const ctrl = new LearnController(ctx as never)
    ctrl.enter()
    await Promise.resolve()
    await (ctrl as unknown as LaunchExerciseAccess).launchExercise(sightReading)
    await (ctrl as unknown as LaunchExerciseAccess).launchExercise(playAlongLike)
    expect(ctx.services.store.setVisualizationForced).toHaveBeenLastCalledWith(null)
  })

  it('restores on exit() — never overwrites the saved preference, only clears the force', async () => {
    const ctx = makeFakeCtx()
    const ctrl = new LearnController(ctx as never)
    ctrl.enter()
    await Promise.resolve()
    await (ctrl as unknown as LaunchExerciseAccess).launchExercise(sightReading)
    expect(ctx.services.store.setVisualizationForced).toHaveBeenLastCalledWith('piano')
    ctrl.exit()
    expect(ctx.services.store.setVisualizationForced).toHaveBeenLastCalledWith(null)
  })

  it('exit invalidates runner work even when no exercise is active', async () => {
    const ctx = makeFakeCtx()
    const ctrl = new LearnController(ctx as never)
    ctrl.enter()
    await (ctrl as unknown as LaunchExerciseAccess).launchExercise(sightReading)
    runnerClose.mockClear()
    ctrl.exit()
    expect(runnerClose).toHaveBeenCalledWith('abandoned')
  })

  it('clears a piano force when exercise launch rejects', async () => {
    const ctx = makeFakeCtx()
    const ctrl = new LearnController(ctx as never)
    ctrl.enter()
    runnerLaunch.mockRejectedValueOnce(new Error('exercise failed'))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await (ctrl as unknown as LaunchExerciseAccess).launchExercise(sightReading)
    expect(ctx.services.store.setVisualizationForced).toHaveBeenNthCalledWith(1, 'piano')
    expect(ctx.services.store.setVisualizationForced).toHaveBeenLastCalledWith(null)
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })

  it('does not let a stale failed launch roll back a newer successful launch', async () => {
    const ctx = makeFakeCtx()
    const ctrl = new LearnController(ctx as never)
    ctrl.enter()
    let rejectFirst!: (reason: unknown) => void
    runnerLaunch
      .mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectFirst = reject
          }),
      )
      .mockResolvedValueOnce(undefined)
    const first = (ctrl as unknown as LaunchExerciseAccess).launchExercise(sightReading)
    const second = (ctrl as unknown as LaunchExerciseAccess).launchExercise(sightReading)
    await second
    rejectFirst(new Error('stale preload failed'))
    await first
    expect(ctx.services.store.setVisualizationForced).toHaveBeenLastCalledWith('piano')
  })

  it.each([
    'resolve',
    'reject',
  ] as const)('closes an inactive pending launch and ignores its later %s', async (settlement) => {
    const ctx = makeFakeCtx()
    const ctrl = new LearnController(ctx as never)
    ctrl.enter()
    ctrl.learnState.completeLoad(makeMidi('pending.mid'))
    let resolveLaunch!: () => void
    let rejectLaunch!: (reason: unknown) => void
    runnerLaunch.mockImplementationOnce(
      () =>
        new Promise<void>((resolve, reject) => {
          resolveLaunch = resolve
          rejectLaunch = reject
        }),
    )
    const launch = (ctrl as unknown as LaunchExerciseAccess).launchExercise(sightReading)

    runnerClose.mockClear()
    createSessionSummaryMock.mockClear()
    ctrl.closeActiveExercise('abandoned')

    expect(runnerClose).toHaveBeenCalledWith('abandoned')
    expect(createSessionSummaryMock).not.toHaveBeenCalled()
    expect(ctx.services.store.setVisualizationForced).toHaveBeenLastCalledWith(null)
    expect(ctrl.view.value).toBe('hub')
    expect(ctrl.learnState.state.loadedMidi).toBeNull()
    expect(ctx.setLearnFileName).toHaveBeenLastCalledWith(null)

    if (settlement === 'resolve') resolveLaunch()
    else rejectLaunch(new Error('cancelled preload failed'))
    await launch

    expect(ctx.services.store.setVisualizationForced).toHaveBeenLastCalledWith(null)
    expect(ctrl.view.value).toBe('hub')
    expect(ctrl.learnState.state.loadedMidi).toBeNull()
  })

  it('cancels a pending launch before consuming a fresh MIDI', async () => {
    const ctx = makeFakeCtx()
    const ctrl = new LearnController(ctx as never)
    ctrl.enter()
    let rejectOld!: (reason: unknown) => void
    runnerLaunch
      .mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectOld = reject
          }),
      )
      .mockResolvedValueOnce(undefined)
    const oldLaunch = (ctrl as unknown as LaunchExerciseAccess).launchExercise(sightReading)

    runnerClose.mockClear()
    await (ctrl as unknown as LaunchExerciseAccess).consumeMidi(makeMidi('fresh.mid'))
    expect(runnerClose).toHaveBeenCalledWith('abandoned')
    expect(ctrl.learnState.state.loadedMidi?.name).toBe('fresh.mid')
    expect(ctx.services.store.setVisualizationForced).toHaveBeenLastCalledWith(null)

    rejectOld(new Error('stale pending launch failed'))
    await oldLaunch
    expect(ctrl.learnState.state.loadedMidi?.name).toBe('fresh.mid')
    expect(ctx.services.store.setVisualizationForced).toHaveBeenLastCalledWith(null)
    expect(ctrl.view.value).toBe('exercise')
  })
})
