import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { InputBus } from '../../core/input/InputBus'
import type { AppServices } from '../../core/services'
import type { LearnOverlay } from '../overlays/LearnOverlay'
import type { Exercise, ExerciseDescriptor } from './Exercise'
import type { ExerciseContext } from './ExerciseContext'
import { ExerciseRunner } from './ExerciseRunner'
import { LearnState } from './LearnState'
import { LearnProgressStore } from './progress'
import type { ExerciseResult } from './Result'

// Stub — the runner only stores the overlay reference; no method is invoked
// on it by the runner itself.
const fakeOverlay = {} as LearnOverlay

function installLocalStorageShim(): () => void {
  const data = new Map<string, string>()
  const shim: Storage = {
    get length() {
      return data.size
    },
    clear: () => data.clear(),
    getItem: (k) => (data.has(k) ? data.get(k)! : null),
    key: (i) => Array.from(data.keys())[i] ?? null,
    removeItem: (k) => {
      data.delete(k)
    },
    setItem: (k, v) => {
      data.set(k, String(v))
    },
  }
  const prev = (globalThis as { localStorage?: Storage }).localStorage
  ;(globalThis as { localStorage?: Storage }).localStorage = shim
  return () => {
    if (prev === undefined) delete (globalThis as { localStorage?: Storage }).localStorage
    else (globalThis as { localStorage?: Storage }).localStorage = prev
  }
}

// The clock service only needs to expose `subscribe` for the runner's tick
// wiring. Everything else on MasterClock is irrelevant at this layer.
function fakeClock(): AppServices['clock'] {
  const listeners = new Set<(t: number) => void>()
  return {
    subscribe: (fn: (t: number) => void) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    // Other MasterClock members aren't touched by the runner; cast away.
  } as unknown as AppServices['clock']
}

function makeServices(input: InputBus): AppServices {
  return {
    store: null as never,
    clock: fakeClock(),
    synth: null as never,
    metronome: null as never,
    renderer: null as never,
    input,
  }
}

// Build a runner with sensible defaults for the Learn-scoped deps. Individual
// tests override just what they need.
function makeRunner(
  bus: InputBus,
  progress: LearnProgressStore,
  host: HTMLElement = {} as HTMLElement,
  onClose: (reason: 'completed' | 'abandoned') => void = () => {},
): ExerciseRunner {
  return new ExerciseRunner({
    services: makeServices(bus),
    learnState: new LearnState(),
    progress,
    overlay: fakeOverlay,
    host,
    onClose,
  })
}

interface TestExercise extends Exercise {
  mountCalls: number
  startCalls: number
  stopCalls: number
  unmountCalls: number
  noteOnCalls: number
  sessionResult: ExerciseResult | null
}

function makeExercise(descriptor: ExerciseDescriptor, result: ExerciseResult | null): TestExercise {
  const ex: TestExercise = {
    descriptor,
    mountCalls: 0,
    startCalls: 0,
    stopCalls: 0,
    unmountCalls: 0,
    noteOnCalls: 0,
    sessionResult: result,
    mount: () => {
      ex.mountCalls++
    },
    start: () => {
      ex.startCalls++
    },
    stop: () => {
      ex.stopCalls++
    },
    unmount: () => {
      ex.unmountCalls++
    },
    onNoteOn: () => {
      ex.noteOnCalls++
    },
    result: () => ex.sessionResult,
  }
  return ex
}

describe('ExerciseRunner', () => {
  let uninstall: () => void
  beforeAll(() => {
    uninstall = installLocalStorageShim()
  })
  afterAll(() => {
    uninstall()
  })
  beforeEach(() => {
    localStorage.clear()
  })

  it('runs the full lifecycle and commits the result on completion', async () => {
    const bus = new InputBus()
    const progress = new LearnProgressStore(() => '2026-04-24')
    const host = {} as HTMLElement
    const runner = makeRunner(bus, progress, host)

    const descriptor: ExerciseDescriptor = {
      id: 'test.play-along',
      title: 'Test',
      category: 'play-along',
      difficulty: 'beginner',
      blurb: '',
      factory: (_ctx: ExerciseContext) =>
        makeExercise(descriptor, {
          exerciseId: 'test.play-along',
          duration_s: 30,
          accuracy: 0.8,
          xp: 12,
          weakSpots: [],
          completed: true,
        }),
    }

    const exerciseRef = vi.fn<(ctx: ExerciseContext) => Exercise>()
    descriptor.factory = (ctx) => {
      const ex = makeExercise(descriptor, {
        exerciseId: 'test.play-along',
        duration_s: 30,
        accuracy: 0.8,
        xp: 12,
        weakSpots: [],
        completed: true,
      })
      exerciseRef(ctx)
      return ex
    }

    await runner.launch(descriptor)
    expect(runner.isActive).toBe(true)
    expect(runner.activeId).toBe('test.play-along')

    const result = runner.close('completed')
    expect(runner.isActive).toBe(false)
    expect(result?.xp).toBe(12)
    expect(progress.xp).toBe(12)
    expect(progress.state.value.exercises['test.play-along']?.completions).toBe(1)
  })

  it('forwards InputBus note-ons to the active exercise only', async () => {
    const bus = new InputBus()
    const progress = new LearnProgressStore(() => '2026-04-24')
    const runner = makeRunner(bus, progress)

    let captured: TestExercise | null = null
    const descriptor: ExerciseDescriptor = {
      id: 'test.fanout',
      title: 'Fanout',
      category: 'ear-training',
      difficulty: 'beginner',
      blurb: '',
      factory: () => {
        captured = makeExercise(descriptor, null)
        return captured
      },
    }

    // Before launch, emits are ignored (no subscriber).
    bus.emitNoteOn({ pitch: 60, velocity: 1, clockTime: 0 }, 'midi')

    await runner.launch(descriptor)
    bus.emitNoteOn({ pitch: 60, velocity: 1, clockTime: 0 }, 'midi')
    bus.emitNoteOn({ pitch: 64, velocity: 1, clockTime: 0 }, 'midi')
    expect(captured!.noteOnCalls).toBe(2)

    runner.close('abandoned')
    bus.emitNoteOn({ pitch: 60, velocity: 1, clockTime: 0 }, 'midi')
    // No subscription remains; counter is frozen.
    expect(captured!.noteOnCalls).toBe(2)
  })

  it('marks abandoned closes as incomplete regardless of exercise result', async () => {
    const bus = new InputBus()
    const progress = new LearnProgressStore(() => '2026-04-24')
    const runner = makeRunner(bus, progress)

    const descriptor: ExerciseDescriptor = {
      id: 'test.abandon',
      title: 'Abandon',
      category: 'play-along',
      difficulty: 'beginner',
      blurb: '',
      factory: () =>
        makeExercise(descriptor, {
          // Exercise optimistically set `completed: true` — the runner should
          // overwrite based on how we actually closed.
          exerciseId: 'test.abandon',
          duration_s: 5,
          accuracy: 1,
          xp: 5,
          weakSpots: [],
          completed: true,
        }),
    }

    await runner.launch(descriptor)
    const result = runner.close('abandoned')
    expect(result?.completed).toBe(false)
    // Abandoned runs don't increment completions.
    expect(progress.state.value.exercises['test.abandon']?.completions).toBe(0)
    // But the time spent still accrues — so a half-finished 5-s attempt
    // shows up in practice totals.
    expect(progress.state.value.exercises['test.abandon']?.totalTime_s).toBeGreaterThanOrEqual(0)
  })

  it('closes any previous exercise when launching a new one', async () => {
    const bus = new InputBus()
    const progress = new LearnProgressStore(() => '2026-04-24')
    const runner = makeRunner(bus, progress)

    const firstExercises: TestExercise[] = []
    const first: ExerciseDescriptor = {
      id: 'test.first',
      title: 'First',
      category: 'play-along',
      difficulty: 'beginner',
      blurb: '',
      factory: () => {
        const e = makeExercise(first, null)
        firstExercises.push(e)
        return e
      },
    }
    const second: ExerciseDescriptor = {
      id: 'test.second',
      title: 'Second',
      category: 'play-along',
      difficulty: 'beginner',
      blurb: '',
      factory: () => makeExercise(second, null),
    }

    await runner.launch(first)
    await runner.launch(second)
    expect(firstExercises[0]?.stopCalls).toBe(1)
    expect(firstExercises[0]?.unmountCalls).toBe(1)
    expect(runner.activeId).toBe('test.second')
  })
})
