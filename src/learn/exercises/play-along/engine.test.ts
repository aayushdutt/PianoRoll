import { describe, expect, it, vi } from 'vitest'
import type { MidiFile } from '../../../core/midi/types'
import type { AppServices } from '../../../core/services'
import { LearnState } from '../../core/LearnState'
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
  const learnState = new LearnState()
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
    expect(engine.loopRegion.value).toEqual({ start: 2, end: 10 })
    // Reach end → should wrap to start, bump clean-pass counter.
    clock.emit(10.001)
    expect(clock.currentTime).toBeCloseTo(2)
    expect(engine.cleanPasses.value).toBe(1)
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
    expect(engine.speedPct.value).toBe(80)
    clock.currentTime = 10
    clock.emit(10.001)
    expect(engine.speedPct.value).toBe(100)
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
    learnState.startPlaying()
    const engine = new PlayAlongEngine({ services, learnState })
    engine.attach(makeMidi())
    expect(learnState.status.value).toBe('paused')
    expect(clock.currentTime).toBe(0)
    expect(engine.currentTime.value).toBe(0)
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
    expect(engine.userWantsToPlay.value).toBe(true)
    // Simulate wait-mode pausing.
    learnState.pausePlayback()
    expect(engine.isPlaying.value).toBe(false)
    expect(engine.userWantsToPlay.value).toBe(true)
    // User explicitly pauses.
    engine.pause()
    expect(engine.userWantsToPlay.value).toBe(false)
  })

  it('resets clean-pass counter on a wrong-pitch miss while waiting', () => {
    const { services, learnState } = makeServices()
    const engine = new PlayAlongEngine({ services, learnState })
    engine.attach(makeMidi())
    engine.cleanPasses.set(3)
    engine.setWaitEnabled(true)
    // Manually engage wait by asking the practice engine to re-arm at t=0
    // (the first chord onsets at t=2 — force the engine to notice).
    // The easiest approach is to flip the private state via `notePressed`
    // while the engine is waiting. First advance past the step.
    // For simplicity: simulate the miss path directly — onNoteOn with a
    // pitch that's not pending when waiting should bump misses + reset.
    // Force `waiting=true` by invoking the engine's onClockTick equivalent
    // via the clock subscription path.
    const clock = services.clock as unknown as { emit: (t: number) => void }
    clock.emit(2.01) // crosses the first step onset — practice engine engages
    // Now press a wrong pitch.
    engine.onNoteOn({ pitch: 99, velocity: 1, clockTime: 2.01, source: 'midi' })
    expect(engine.misses.value).toBeGreaterThan(0)
    expect(engine.cleanPasses.value).toBe(0)
  })
})
