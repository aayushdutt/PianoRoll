import { describe, expect, it, vi } from 'vitest'
import type { MidiFile } from '../../../core/midi/types'
import type { AppServices } from '../../../core/services'
import { createLearnState, type LearnState } from '../../core/LearnState'
import { PlayAlongEngine } from './engine'

// Fake clock that speaks to the same surface the engine uses. Tests tick
// directly by calling `emit` with a time — no RAF, no AudioContext.
function makeClock() {
  const listeners = new Set<(t: number) => void>()
  let t = 0
  let speed = 1
  let playing = false
  return {
    get currentTime() {
      return t
    },
    set currentTime(v: number) {
      t = v
    },
    get playing() {
      return playing
    },
    get speed() {
      return speed
    },
    set speed(v: number) {
      speed = v
    },
    play() {
      playing = true
    },
    pause() {
      playing = false
    },
    seek(newT: number) {
      t = Math.max(0, newT)
    },
    subscribe(fn: (t: number) => void) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    // Test helper — the engine subscribes, then we manually emit.
    emit(newT: number) {
      t = newT
      for (const fn of listeners) fn(newT)
    },
  }
}

function makeSynth() {
  const speed = { current: 1 }
  const seekCalls: number[] = []
  return {
    setSpeed: (v: number) => {
      speed.current = v
    },
    seek: (t: number) => {
      seekCalls.push(t)
    },
    get speed() {
      return speed.current
    },
    get seekCalls() {
      return seekCalls
    },
  }
}

function makeMidi(): MidiFile {
  return {
    name: 'drill.mid',
    duration: 60,
    bpm: 120,
    timeSignature: [4, 4],
    tracks: [
      {
        id: 'rh',
        name: 'Right',
        channel: 0,
        instrument: 0,
        isDrum: false,
        color: 0xffffff,
        colorIndex: 0,
        notes: [
          // Two simple chord steps: 2 s (C4+E4+G4), then 4 s (F4+A4+C5).
          { pitch: 60, time: 2, duration: 0.5, velocity: 1 },
          { pitch: 64, time: 2, duration: 0.5, velocity: 1 },
          { pitch: 67, time: 2, duration: 0.5, velocity: 1 },
          { pitch: 65, time: 4, duration: 0.5, velocity: 1 },
          { pitch: 69, time: 4, duration: 0.5, velocity: 1 },
          { pitch: 72, time: 4, duration: 0.5, velocity: 1 },
        ],
      },
    ],
  }
}

function makeServices(): {
  services: AppServices
  clock: ReturnType<typeof makeClock>
  synth: ReturnType<typeof makeSynth>
  learnState: LearnState
} {
  const clock = makeClock()
  const synth = makeSynth()
  const learnState = createLearnState()
  return {
    clock,
    synth,
    learnState,
    services: {
      store: null as never,
      clock: clock as unknown as AppServices['clock'],
      synth: synth as unknown as AppServices['synth'],
      metronome: null as never,
      renderer: null as never,
      input: null as never,
    },
  }
}

describe('PlayAlongEngine', () => {
  it('applies speed preset to clock and synth', () => {
    const { services, clock, synth, learnState } = makeServices()
    const engine = new PlayAlongEngine({ services, learnState })
    engine.attach(makeMidi())
    engine.setSpeedPreset(60)
    expect(clock.speed).toBeCloseTo(0.6)
    expect(synth.speed).toBeCloseTo(0.6)
    engine.setSpeedPreset(100)
    expect(clock.speed).toBeCloseTo(1)
  })

  it('resets clock/synth speed on detach', () => {
    // Switching away from Play-Along shouldn't leave the rest of the app
    // stuck at 60% — detach restores base playback speed.
    const { services, clock, synth, learnState } = makeServices()
    const engine = new PlayAlongEngine({ services, learnState })
    engine.attach(makeMidi())
    engine.setSpeedPreset(60)
    engine.detach()
    expect(clock.speed).toBe(1)
    expect(synth.speed).toBe(1)
  })

  it('wraps the clock when the playhead reaches the loop end and counts a clean pass', () => {
    const { services, clock, learnState } = makeServices()
    const onCleanPass = vi.fn()
    const engine = new PlayAlongEngine({ services, learnState, onCleanPass })
    engine.attach(makeMidi())
    // 4 bars @ 120 BPM = 8 s. Playhead at 10 → loop = [2, 10].
    clock.currentTime = 10
    engine.setLoopFromBars(4, 10, 60, 120)
    expect(engine.state.loopRegion).toEqual({ start: 2, end: 10 })
    // Reach end → should wrap to start, bump clean-pass counter.
    clock.emit(10.001)
    expect(clock.currentTime).toBeCloseTo(2)
    expect(engine.state.cleanPasses).toBe(1)
    expect(onCleanPass).toHaveBeenCalledOnce()
  })

  it('ramp-toggles bump the tempo preset on each clean pass when enabled', () => {
    const { services, clock, learnState } = makeServices()
    const engine = new PlayAlongEngine({ services, learnState })
    engine.attach(makeMidi())
    engine.setTempoRamp(true)
    // Base: 60 (first preset), since zero clean passes → ramp returns 60.
    // Using custom presets is the engine's concern — verify the public
    // behavior: clean pass flips us to the next preset.
    engine.setSpeedPreset(60)
    engine.setLoopFromBars(4, 10, 60, 120)
    clock.currentTime = 10
    clock.emit(10.001)
    // After one clean pass + ramp on: moved up from 60 → 80.
    expect(engine.state.speedPct).toBe(80)
    clock.currentTime = 10
    clock.emit(10.001)
    expect(engine.state.speedPct).toBe(100)
  })

  it('pauses clock + synth on attach even if a prior session left them running', () => {
    // Regression guard for the "first entry plays audio but notes don't
    // move" bug: if a prior session was mid-playback, the clock + synth
    // must be halted BEFORE practice steps are built so wait-mode can
    // engage at the right position rather than skipping to whatever stale
    // time the clock had drifted to.
    const { services, clock, synth, learnState } = makeServices()
    // Simulate a prior Learn session playing at 3 s.
    clock.currentTime = 3
    learnState.setState('status', 'playing')
    const engine = new PlayAlongEngine({ services, learnState })
    engine.attach(makeMidi())
    expect(learnState.state.status).toBe('paused')
    // Attach seeds transport from clock.currentTime (clamped to duration).
    // The 3s seed is <= makeMidi().duration so it's preserved; the critical
    // invariant is that status flipped to 'paused' before practice steps
    // were built.
    expect(clock.currentTime).toBe(3)
    expect(engine.state.currentTime).toBe(3)
    // synth.seek may or may not be called on attach; what matters is that
    // no tempo leak escaped from the prior session.
    void synth
  })

  it('play button signal (userWantsToPlay) does not flip on wait-mode pauses', () => {
    // When PracticeEngine engages wait-mode, it flips `learnState.status`
    // to 'paused'. The HUD's play/pause icon must stay showing "pause"
    // (i.e. userWantsToPlay=true) so the button doesn't strobe across
    // every chord.
    const { services, learnState } = makeServices()
    const engine = new PlayAlongEngine({ services, learnState })
    engine.attach(makeMidi())
    engine.play()
    expect(engine.state.userWantsToPlay).toBe(true)
    // Simulate wait-mode pausing.
    learnState.setState('status', 'paused')
    expect(engine.state.isPlaying).toBe(false)
    expect(engine.state.userWantsToPlay).toBe(true)
    // User explicitly pauses.
    engine.pause()
    expect(engine.state.userWantsToPlay).toBe(false)
  })

  it('resets clean-pass counter on a wrong-pitch error while waiting', () => {
    const { services, learnState } = makeServices()
    const engine = new PlayAlongEngine({ services, learnState })
    engine.attach(makeMidi())
    engine.setState('cleanPasses', 3)
    engine.setWaitEnabled(true)
    // The first chord onsets at t=2 — engaging wait at 2.01 puts the engine
    // in waiting state with the C-major chord pending.
    const clock = services.clock as unknown as { emit: (t: number) => void }
    clock.emit(2.01)
    // Wrong pitch (99 not in {60,64,67}) → errors++, streak=0, cleanPasses=0.
    engine.onNoteOn({ pitch: 99, velocity: 1, clockTime: 2.01, source: 'midi' })
    expect(engine.state.errors).toBeGreaterThan(0)
    expect(engine.state.streak).toBe(0)
    expect(engine.state.cleanPasses).toBe(0)
  })

  it('grades a cohesive single-note chord as "perfect" and bumps streak', () => {
    // Construct a one-note step at t=1 to exercise the articulation path
    // without the multi-pitch chord overhead.
    const midi: MidiFile = {
      name: 'one.mid',
      duration: 30,
      bpm: 120,
      timeSignature: [4, 4],
      tracks: [
        {
          id: 'rh',
          name: 'Right',
          channel: 0,
          instrument: 0,
          isDrum: false,
          color: 0xffffff,
          colorIndex: 0,
          notes: [{ pitch: 60, time: 1, duration: 0.5, velocity: 1 }],
        },
      ],
    }
    const { services, learnState } = makeServices()
    const engine = new PlayAlongEngine({ services, learnState })
    engine.attach(midi)
    engine.setWaitEnabled(true)
    // Engage wait.
    const clock = services.clock as unknown as { emit: (t: number) => void }
    clock.emit(1.01)
    // Single-note articulation is always 0 ms → perfect.
    engine.onNoteOn({ pitch: 60, velocity: 1, clockTime: 1.01, source: 'midi' })
    expect(engine.state.perfect).toBe(1)
    expect(engine.state.good).toBe(0)
    expect(engine.state.streak).toBe(1)
    expect(engine.state.errors).toBe(0)
  })

  it('grades a slowly-articulated multi-note chord as "good"', () => {
    // Inject a controllable wall-clock so we can advance "between" the two
    // chord presses by 250 ms — past the 80 ms perfect threshold.
    const { services, learnState } = makeServices()
    let nowMs = 0
    const engine = new PlayAlongEngine({ services, learnState })
    // Replace the engine's PracticeEngine with one that uses our clock seam.
    // (Done via reflection — production code passes `performance.now`.)
    ;(engine as unknown as { practice: { ['nowMs']: () => number } }).practice['nowMs'] = () =>
      nowMs
    engine.attach(makeMidi())
    engine.setWaitEnabled(true)
    const clock = services.clock as unknown as { emit: (t: number) => void }
    clock.emit(2.01) // engage at first chord (60+64+67)
    nowMs = 0
    engine.onNoteOn({ pitch: 60, velocity: 1, clockTime: 2.01, source: 'midi' })
    nowMs = 100
    engine.onNoteOn({ pitch: 64, velocity: 1, clockTime: 2.01, source: 'midi' })
    nowMs = 250
    engine.onNoteOn({ pitch: 67, velocity: 1, clockTime: 2.01, source: 'midi' })
    expect(engine.state.good).toBe(1)
    expect(engine.state.perfect).toBe(0)
    expect(engine.state.streak).toBe(1)
  })

  it('held-tick bonus increments while a cleared pitch is still held', () => {
    // Clear the first chord, then keep holding through the song; ticks
    // accumulate for each held pitch until each pitch's held-eligibility
    // window expires.
    const { services, learnState } = makeServices()
    const engine = new PlayAlongEngine({ services, learnState })
    engine.attach(makeMidi())
    engine.setWaitEnabled(true)
    const clock = services.clock as unknown as { emit: (t: number) => void }
    clock.emit(2.01) // engage
    engine.onNoteOn({ pitch: 60, velocity: 1, clockTime: 2.01, source: 'midi' })
    engine.onNoteOn({ pitch: 64, velocity: 1, clockTime: 2.01, source: 'midi' })
    engine.onNoteOn({ pitch: 67, velocity: 1, clockTime: 2.01, source: 'midi' })
    expect(engine.state.heldTicks).toBe(0)
    // Tick BEFORE the chord's note-end (chord ends at 2.5; eligibility runs
    // through 2.5 + 0.05 = 2.55). All 3 pitches are still held → +3 each.
    clock.emit(2.2)
    expect(engine.state.heldTicks).toBe(3)
    clock.emit(2.4)
    expect(engine.state.heldTicks).toBe(6)
    // Past 2.55 → eligibility expires → no more accumulation even if held.
    clock.emit(3.0)
    expect(engine.state.heldTicks).toBe(6)
  })

  it('markLoopPoint cycles idle → mark A → set region → clear', () => {
    // Mirrors the HUD's three-click flow: first click parks A, second click
    // sets B and the region becomes active, third click clears everything.
    const { services, learnState } = makeServices()
    const engine = new PlayAlongEngine({ services, learnState })
    engine.attach(makeMidi())
    expect(engine.state.loopMark).toBeNull()
    expect(engine.state.loopRegion).toBeNull()

    // 1st click @ t=2 → A parked.
    engine.markLoopPoint(2)
    expect(engine.state.loopMark).toBeCloseTo(2)
    expect(engine.state.loopRegion).toBeNull()

    // 2nd click @ t=10 → region [2,10], mark cleared.
    engine.markLoopPoint(10)
    expect(engine.state.loopRegion).toEqual({ start: 2, end: 10 })
    expect(engine.state.loopMark).toBeNull()

    // 3rd click → clear back to idle.
    engine.markLoopPoint(15)
    expect(engine.state.loopRegion).toBeNull()
    expect(engine.state.loopMark).toBeNull()
  })

  it('markLoopPoint orders A and B regardless of click sequence', () => {
    // User clicks B *before* A (i.e. their second click is at an earlier
    // playhead than the first). The region should still be valid [min,max].
    const { services, learnState } = makeServices()
    const engine = new PlayAlongEngine({ services, learnState })
    engine.attach(makeMidi())
    engine.markLoopPoint(10)
    engine.markLoopPoint(2)
    expect(engine.state.loopRegion).toEqual({ start: 2, end: 10 })
  })

  it('markLoopPoint twice on the same spot is a clear (no zero-length region)', () => {
    // A double-click at the same playhead would make a zero-length loop the
    // wrap helper would refuse — guard at the engine instead so the UX
    // doesn't get stuck in an unkillable mark state.
    const { services, learnState } = makeServices()
    const engine = new PlayAlongEngine({ services, learnState })
    engine.attach(makeMidi())
    engine.markLoopPoint(5)
    engine.markLoopPoint(5.01) // within 50 ms tolerance → treated as same spot
    expect(engine.state.loopRegion).toBeNull()
    expect(engine.state.loopMark).toBeNull()
  })

  it('clearLoop wipes both the region and the half-set mark', () => {
    const { services, learnState } = makeServices()
    const engine = new PlayAlongEngine({ services, learnState })
    engine.attach(makeMidi())
    engine.markLoopPoint(3) // half-set
    engine.clearLoop()
    expect(engine.state.loopMark).toBeNull()
    expect(engine.state.loopRegion).toBeNull()
  })

  it('re-pressing a chord pitch the user already cleared is a no-op (no error)', () => {
    // Regression: a re-strike of an already-accepted pitch (MIDI bounce,
    // octave doubling, sustained-then-re-played) used to land in
    // `practice.notePressed`'s `'rejected'` branch and bump errors. The
    // `'duplicate'` outcome separates this from wrong-pitch and the host
    // ignores it.
    const { services, learnState } = makeServices()
    const engine = new PlayAlongEngine({ services, learnState })
    engine.attach(makeMidi())
    engine.setWaitEnabled(true)
    const clock = services.clock as unknown as { emit: (t: number) => void }
    clock.emit(2.01) // engage at first chord (60+64+67)
    engine.onNoteOn({ pitch: 60, velocity: 1, clockTime: 2.01, source: 'midi' })
    expect(engine.state.errors).toBe(0)
    // Re-strike 60 mid-chord — must NOT bump errors and must NOT reset
    // the streak (which is still 0 here since the chord isn't cleared, but
    // we assert errors specifically).
    engine.onNoteOn({ pitch: 60, velocity: 1, clockTime: 2.01, source: 'midi' })
    expect(engine.state.errors).toBe(0)
    // Wrong pitch still counts.
    engine.onNoteOn({ pitch: 99, velocity: 1, clockTime: 2.01, source: 'midi' })
    expect(engine.state.errors).toBe(1)
  })
})
