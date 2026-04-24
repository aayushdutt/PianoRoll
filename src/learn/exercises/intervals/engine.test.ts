import { describe, expect, it, vi } from 'vitest'
import type { AppServices } from '../../../core/services'
import { IntervalsEngine } from './engine'
import { BEGINNER_SET } from './theory'

// Minimal stub AppServices. The engine only touches services.synth via the
// default scheduler, and the tests below replace that scheduler with a spy
// so we never need a real AudioContext.
function makeServices(): AppServices {
  // `as unknown as AppServices` is deliberate — the engine only uses a narrow
  // surface and building the full object would bloat every test with
  // unrelated plumbing. If a new property is needed, the test will fail
  // loudly at the touchpoint rather than silently pass on a stale stub.
  return {} as unknown as AppServices
}

describe('IntervalsEngine', () => {
  it('starts in ready phase and flips to question on start()', () => {
    const engine = new IntervalsEngine({
      services: makeServices(),
      questionCount: 3,
      set: BEGINNER_SET,
      scheduleInterval: () => {},
    })
    expect(engine.phase.value).toBe('ready')
    engine.start()
    expect(engine.phase.value).toBe('question')
    expect(engine.questions.value.length).toBe(3)
    expect(engine.index.value).toBe(0)
  })

  it('playCurrent delegates to the injected scheduler with the current root + semitones', () => {
    const spy = vi.fn()
    const engine = new IntervalsEngine({
      services: makeServices(),
      questionCount: 1,
      set: ['P5'],
      scheduleInterval: spy,
    })
    engine.start()
    engine.playCurrent()
    expect(spy).toHaveBeenCalledTimes(1)
    const [root, semis] = spy.mock.calls[0]!
    expect(semis).toBe(7)
    expect(root).toBeGreaterThanOrEqual(48)
  })

  it('correct answer advances hits + streak, not misses', () => {
    const engine = new IntervalsEngine({
      services: makeServices(),
      questionCount: 1,
      set: ['M3'],
      scheduleInterval: () => {},
    })
    engine.start()
    const fb = engine.answer('M3')
    expect(fb?.correct).toBe(true)
    expect(engine.hits.value).toBe(1)
    expect(engine.misses.value).toBe(0)
    expect(engine.streak.value).toBe(1)
    expect(engine.phase.value).toBe('feedback')
  })

  it('wrong answer bumps misses and resets streak', () => {
    const engine = new IntervalsEngine({
      services: makeServices(),
      questionCount: 2,
      set: ['M3', 'P5'],
      scheduleInterval: () => {},
      // Seed so both generated questions are M3 — makes the miss check
      // deterministic without asserting on a specific pool index.
      rand: () => 0,
    })
    engine.start()
    // Two M3 questions expected with rand=0 (first interval, first root).
    engine.answer('M3') // hit, streak=1
    expect(engine.streak.value).toBe(1)
    engine.next()
    engine.answer('P5') // miss, streak back to 0
    expect(engine.hits.value).toBe(1)
    expect(engine.misses.value).toBe(1)
    expect(engine.streak.value).toBe(0)
  })

  it('ignores repeated answers on the same question', () => {
    const engine = new IntervalsEngine({
      services: makeServices(),
      questionCount: 1,
      set: ['P5'],
      scheduleInterval: () => {},
    })
    engine.start()
    engine.answer('M3') // miss
    // Second answer during 'feedback' is dropped — otherwise a user
    // hammering two buttons before the UI repaints could inflate misses.
    const second = engine.answer('P5')
    expect(second).toBeNull()
    expect(engine.misses.value).toBe(1)
  })

  it('next() advances to the next question until the last, then flips to done', () => {
    const engine = new IntervalsEngine({
      services: makeServices(),
      questionCount: 2,
      set: ['P4'],
      scheduleInterval: () => {},
    })
    engine.start()
    engine.answer('P4')
    engine.next()
    expect(engine.index.value).toBe(1)
    expect(engine.phase.value).toBe('question')
    engine.answer('P4')
    engine.next()
    expect(engine.phase.value).toBe('done')
  })

  it('accuracy reflects hits / attempts', () => {
    const engine = new IntervalsEngine({
      services: makeServices(),
      questionCount: 4,
      set: ['M3'],
      scheduleInterval: () => {},
    })
    engine.start()
    engine.answer('M3')
    engine.next()
    engine.answer('P4') // miss
    engine.next()
    engine.answer('M3')
    engine.next()
    engine.answer('P5') // miss
    expect(engine.accuracy).toBeCloseTo(0.5, 5)
  })

  it('emits no feedback when answer() is called outside question phase', () => {
    const engine = new IntervalsEngine({
      services: makeServices(),
      questionCount: 1,
      set: ['P5'],
      scheduleInterval: () => {},
    })
    // Before start — phase is 'ready'.
    expect(engine.answer('P5')).toBeNull()
    engine.start()
    expect(engine.phase.value).toBe('question')
  })
})
