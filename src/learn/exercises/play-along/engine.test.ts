import { describe, expect, it, vi } from 'vitest'
import type { MidiFile } from '../../../core/midi/types'
import type { AppServices } from '../../../core/services'
import { createLearnState, type LearnState } from '../../core/LearnState'
import { guitarPitchFilter, PlayAlongEngine } from './engine'

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

function makeRenderer() {
  const focusCalls: Array<string[] | null> = []
  return {
    setPracticeTrackFocus: (ids: Iterable<string> | null) => {
      focusCalls.push(ids ? Array.from(ids) : null)
    },
    get focusCalls() {
      return focusCalls
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

function makeSplitHandMidi(): MidiFile {
  return {
    name: 'split.mid',
    duration: 12,
    bpm: 120,
    timeSignature: [4, 4],
    tracks: [
      {
        id: 'lh',
        name: 'Left',
        channel: 0,
        instrument: 0,
        isDrum: false,
        color: 0xffffff,
        colorIndex: 0,
        notes: [{ pitch: 48, time: 2, duration: 0.5, velocity: 1 }],
      },
      {
        id: 'rh',
        name: 'Right',
        channel: 1,
        instrument: 0,
        isDrum: false,
        color: 0xffffff,
        colorIndex: 1,
        notes: [{ pitch: 72, time: 4, duration: 0.5, velocity: 1 }],
      },
    ],
  }
}

function makeServices(): {
  services: AppServices
  clock: ReturnType<typeof makeClock>
  synth: ReturnType<typeof makeSynth>
  renderer: ReturnType<typeof makeRenderer>
  learnState: LearnState
} {
  const clock = makeClock()
  const synth = makeSynth()
  const renderer = makeRenderer()
  const learnState = createLearnState()
  return {
    clock,
    synth,
    renderer,
    learnState,
    services: {
      // Only `effectiveVisualizationMode` is read (guitar pitch filtering) —
      // these tests exercise piano-only behavior, so a fixed 'piano' is
      // enough without standing up a full reactive store.
      store: { effectiveVisualizationMode: 'piano' } as unknown as AppServices['store'],
      clock: clock as unknown as AppServices['clock'],
      synth: synth as unknown as AppServices['synth'],
      metronome: null as never,
      renderer: renderer as unknown as AppServices['renderer'],
      input: null as never,
    },
  }
}

function makeMidiWithUnsupportedGuitarNote(): MidiFile {
  return {
    name: 'guitar-drill.mid',
    duration: 10,
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
          // Standard guitar tuning covers pitch 40 (low E) through 88 — 30 is
          // below the lowest open string, so it's unsupported on the
          // fretboard; 60 sits comfortably within range.
          { pitch: 30, time: 2, duration: 0.5, velocity: 1 },
          { pitch: 60, time: 2, duration: 0.5, velocity: 1 },
        ],
      },
    ],
  }
}

describe('PlayAlongEngine guitar visualization — unsupported-voice scoring', () => {
  it('never requires more pitches than can be assigned to six strings', () => {
    const required = guitarPitchFilter(new Set([40, 41, 42, 43, 44, 45, 46]))
    expect(required.size).toBeLessThanOrEqual(6)
    for (const pitch of required) expect([40, 41, 42, 43, 44, 45, 46]).toContain(pitch)
  })

  it('piano mode requires every pitch, unfiltered', () => {
    const { services, learnState } = makeServices()
    ;(
      services.store as unknown as { effectiveVisualizationMode: string }
    ).effectiveVisualizationMode = 'piano'
    const engine = new PlayAlongEngine({ services, learnState })
    engine.attach(makeMidiWithUnsupportedGuitarNote())
    expect(engine.practice.peekNextStep()?.pitches).toEqual(new Set([30, 60]))
  })

  it('guitar mode excludes the pitch with no fretboard position from what is required', () => {
    const { services, learnState } = makeServices()
    ;(
      services.store as unknown as { effectiveVisualizationMode: string }
    ).effectiveVisualizationMode = 'guitar'
    const engine = new PlayAlongEngine({ services, learnState })
    engine.attach(makeMidiWithUnsupportedGuitarNote())
    // 30 stays out of the required set — it's still part of the schedule the
    // synth/renderer play, just not something wait-mode blocks on.
    expect(engine.practice.peekNextStep()?.pitches).toEqual(new Set([60]))
  })
})

describe('PlayAlongEngine', () => {
  it('keeps an equal-pitch held bonus alive until every voice releases', () => {
    const { services, clock, learnState } = makeServices()
    const midi = makeMidi()
    midi.tracks[0]!.notes = [{ pitch: 60, time: 2, duration: 1, velocity: 1 }]
    const engine = new PlayAlongEngine({ services, learnState })
    engine.attach(midi)
    engine.setWaitEnabled(true)
    engine.play()
    clock.emit(1.995)
    engine.onNoteOn({
      pitch: 60,
      velocity: 1,
      clockTime: 2,
      source: 'midi',
      voiceId: 'midi:a',
    })
    engine.onNoteOn({
      pitch: 60,
      velocity: 1,
      clockTime: 2,
      source: 'guitar',
      voiceId: 'guitar:b',
    })
    clock.emit(2.1)
    const before = engine.state.heldTicks
    engine.onNoteOff({
      pitch: 60,
      velocity: 0,
      clockTime: 2.2,
      source: 'midi',
      voiceId: 'midi:a',
    })
    clock.emit(2.2)
    expect(engine.state.heldTicks).toBeGreaterThan(before)
    const afterOne = engine.state.heldTicks
    engine.onNoteOff({
      pitch: 60,
      velocity: 0,
      clockTime: 2.3,
      source: 'guitar',
      voiceId: 'guitar:b',
    })
    clock.emit(2.3)
    expect(engine.state.heldTicks).toBe(afterOne)
  })

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

  it('continues to the selected hand when switching away from the current wait', () => {
    const { services, clock, learnState, renderer } = makeServices()
    const engine = new PlayAlongEngine({ services, learnState })
    engine.attach(makeSplitHandMidi())
    engine.setWaitEnabled(true)
    engine.play()

    clock.emit(2.01)
    expect(engine.practice.isWaiting).toBe(true)
    expect(clock.playing).toBe(false)
    expect(learnState.state.status).toBe('paused')

    engine.setHand('right')
    expect(engine.practice.isWaiting).toBe(false)
    expect(clock.playing).toBe(true)
    expect(learnState.state.status).toBe('playing')
    expect(renderer.focusCalls.at(-1)).toEqual(['rh'])

    clock.emit(4.01)
    expect(engine.practice.isWaiting).toBe(true)
    expect(clock.playing).toBe(false)
    expect(learnState.state.status).toBe('paused')
  })

  it('keeps waiting when switching to the hand that owns the current wait', () => {
    const { services, clock, learnState, renderer } = makeServices()
    const engine = new PlayAlongEngine({ services, learnState })
    engine.attach(makeSplitHandMidi())
    engine.setWaitEnabled(true)
    engine.play()

    clock.emit(2.01)
    expect(engine.practice.isWaiting).toBe(true)
    expect(clock.playing).toBe(false)

    engine.setHand('left')
    expect(engine.practice.isWaiting).toBe(true)
    expect(clock.playing).toBe(false)
    expect(learnState.state.status).toBe('paused')
    expect(renderer.focusCalls.at(-1)).toEqual(['lh'])

    engine.onNoteOn({ pitch: 48, velocity: 1, clockTime: 2.01, source: 'midi' })
    expect(engine.state.perfect).toBe(1)
    expect(clock.playing).toBe(true)
    expect(learnState.state.status).toBe('playing')
  })

  it('does not resume playback on hand switch when the user is explicitly paused', () => {
    const { services, clock, learnState, renderer } = makeServices()
    const engine = new PlayAlongEngine({ services, learnState })
    engine.attach(makeSplitHandMidi())
    engine.setWaitEnabled(true)

    clock.emit(2.01)
    expect(engine.practice.isWaiting).toBe(true)
    engine.setHand('right')

    expect(engine.practice.isWaiting).toBe(false)
    expect(clock.playing).toBe(false)
    expect(learnState.state.status).toBe('paused')
    expect(renderer.focusCalls.at(-1)).toEqual(['rh'])
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

describe('PlayAlongEngine transport invariants', () => {
  it('auto-pauses at the end of the piece and seeks to the exact duration', () => {
    // onTick: `if (dur > 0 && time >= dur && isPlaying)` — the only thing
    // stopping the transport at song end. A broken condition leaves the engine
    // stuck playing silence past the last note.
    const { services, clock, learnState } = makeServices()
    const engine = new PlayAlongEngine({ services, learnState })
    engine.attach(makeMidi()) // duration = 60
    engine.play()

    clock.emit(60.01) // one tick past the end
    expect(learnState.state.status).toBe('paused')
    expect(engine.state.userWantsToPlay).toBe(false)
    expect(clock.currentTime).toBe(60) // seeked to exact end, not past it
  })

  it('seek() during a wait-mode pause does not resume the clock', () => {
    // The gate is `clock.playing`, not `userWantsToPlay`. During wait-mode,
    // both are diverged: user intends to play (userWantsToPlay=true) but the
    // clock is halted (clock.playing=false). If the guard were swapped to
    // userWantsToPlay, every scrub during a wait would bleed audio.
    const { services, clock, learnState } = makeServices()
    const engine = new PlayAlongEngine({ services, learnState })
    engine.attach(makeMidi())
    engine.setWaitEnabled(true)
    engine.play() // userWantsToPlay = true, clock.playing = true

    clock.emit(2.01) // engage wait → onWaitStart → clock.pause() → clock.playing = false
    expect(engine.state.userWantsToPlay).toBe(true)
    expect(clock.playing).toBe(false)

    engine.seek(0) // wasPlaying = clock.playing = false → should NOT resume
    expect(clock.playing).toBe(false)
  })

  it('seek() while genuinely playing resumes the clock after the seek', () => {
    const { services, clock, learnState } = makeServices()
    const engine = new PlayAlongEngine({ services, learnState })
    engine.attach(makeMidi())
    engine.play() // clock.playing = true, no wait engaged

    engine.seek(1) // wasPlaying = true → resumes
    expect(clock.playing).toBe(true)
  })

  it('play() recomputes the practice step from the current clock position', () => {
    // play() calls practice.notifySeek(clock.currentTime) before starting the
    // clock. Without it, nextStepIdx stays stale after a manual rewind and the
    // first chord on the replayed section is silently skipped.
    const { services, clock, learnState } = makeServices()
    const engine = new PlayAlongEngine({ services, learnState })
    engine.attach(makeMidi()) // chords at t=2 and t=4
    engine.setWaitEnabled(true)
    engine.play()

    // Clear the t=2 chord → practice advances nextStepIdx to t=4.
    clock.emit(2.01)
    engine.onNoteOn({ pitch: 60, velocity: 1, clockTime: 2.01, source: 'midi' })
    engine.onNoteOn({ pitch: 64, velocity: 1, clockTime: 2.01, source: 'midi' })
    engine.onNoteOn({ pitch: 67, velocity: 1, clockTime: 2.01, source: 'midi' })

    // Rewind the clock externally — bypassing engine.seek so practice.notifySeek
    // is NOT called and nextStepIdx stays pointing at t=4.
    engine.pause()
    clock.seek(1.5)

    // play() must notifySeek the practice engine so it rediscovers the t=2 chord.
    engine.play()
    clock.emit(2.01)
    expect(engine.practice.isWaiting).toBe(true) // wait re-engages at t=2
  })
})

describe('PlayAlongEngine held-tick eligibility clearing', () => {
  it('loop wrap clears held eligibility so ticks do not bleed across passes', () => {
    // onTick: tickHeldBonus fires first, then heldEligible.clear() inside the
    // wrap block. Post-wrap ticks must not accumulate even while pitches are held.
    const { services, clock, learnState } = makeServices()
    const engine = new PlayAlongEngine({ services, learnState })
    engine.attach(makeMidi()) // chord at t=2, latestEnd=2.5, eligible until 2.55
    engine.setWaitEnabled(true)

    // Short loop [2, 2.3] — wraps well before the eligibility window expires.
    engine.markLoopPoint(2)
    engine.markLoopPoint(2.3)

    clock.emit(2.01)
    engine.onNoteOn({ pitch: 60, velocity: 1, clockTime: 2.01, source: 'midi' })
    engine.onNoteOn({ pitch: 64, velocity: 1, clockTime: 2.01, source: 'midi' })
    engine.onNoteOn({ pitch: 67, velocity: 1, clockTime: 2.01, source: 'midi' })
    // All three pitches held; heldEligible = {60,64,67: expiry 2.55}

    clock.emit(2.15) // ticks accumulate (before wrap, before expiry)
    expect(engine.state.heldTicks).toBeGreaterThan(0)

    // Wrap fires at 2.295 (region.end - epsilon). tickHeldBonus runs first
    // at this tick, then heldEligible.clear().
    clock.emit(2.301)
    const ticksAfterWrap = engine.state.heldTicks

    // Post-wrap tick: heldEligible empty → no further accumulation.
    clock.emit(2.05)
    expect(engine.state.heldTicks).toBe(ticksAfterWrap)
  })

  it('seek() clears held eligibility so a jump does not earn ticks for pre-jump chords', () => {
    const { services, clock, learnState } = makeServices()
    const engine = new PlayAlongEngine({ services, learnState })
    engine.attach(makeMidi())
    engine.setWaitEnabled(true)

    clock.emit(2.01)
    engine.onNoteOn({ pitch: 60, velocity: 1, clockTime: 2.01, source: 'midi' })
    engine.onNoteOn({ pitch: 64, velocity: 1, clockTime: 2.01, source: 'midi' })
    engine.onNoteOn({ pitch: 67, velocity: 1, clockTime: 2.01, source: 'midi' })

    clock.emit(2.2) // confirm accumulation before seek
    expect(engine.state.heldTicks).toBeGreaterThan(0)

    engine.seek(0) // heldEligible.clear()
    const ticksAfterSeek = engine.state.heldTicks

    clock.emit(2.2) // still inside the old eligibility window — but cleared
    expect(engine.state.heldTicks).toBe(ticksAfterSeek)
  })

  it('setHand() clears held eligibility so ticks stop after a hand switch', () => {
    const { services, clock, learnState } = makeServices()
    const engine = new PlayAlongEngine({ services, learnState })
    engine.attach(makeSplitHandMidi()) // LH: pitch 48 at t=2, eligible until 2.55
    engine.setWaitEnabled(true)

    clock.emit(2.01)
    engine.onNoteOn({ pitch: 48, velocity: 1, clockTime: 2.01, source: 'midi' })

    clock.emit(2.2) // 48 held → ticks accumulate
    expect(engine.state.heldTicks).toBeGreaterThan(0)

    engine.setHand('right') // applyHand → heldEligible.clear()
    const ticksAfterSwitch = engine.state.heldTicks

    clock.emit(2.3) // 48 still in pressedPitches but heldEligible empty
    expect(engine.state.heldTicks).toBe(ticksAfterSwitch)
  })
})

describe('PlayAlongEngine error scoring rules', () => {
  it('wrong pitch when wait is disabled is a no-op — errors stay at 0', () => {
    // errors only increment when `practice.isWaiting`. With wait off this is
    // free-play mode; penalizing wrong notes would break the free-play contract.
    const { services, clock, learnState } = makeServices()
    const engine = new PlayAlongEngine({ services, learnState })
    engine.attach(makeMidi())
    engine.setWaitEnabled(false)

    clock.emit(2.01) // clock past the chord, but no wait was engaged
    engine.onNoteOn({ pitch: 99, velocity: 1, clockTime: 2.01, source: 'midi' })
    expect(engine.state.errors).toBe(0)
  })

  it('wrong pitch between steps (wait enabled but not currently waiting) is also a no-op', () => {
    // The clock hasn't reached the first chord yet — practice is armed but not
    // waiting. Penalizing between-step presses would make the exercise unplayable.
    const { services, learnState } = makeServices()
    const engine = new PlayAlongEngine({ services, learnState })
    engine.attach(makeMidi())
    engine.setWaitEnabled(true)

    engine.onNoteOn({ pitch: 99, velocity: 1, clockTime: 0, source: 'midi' })
    expect(engine.state.errors).toBe(0)
  })
})
