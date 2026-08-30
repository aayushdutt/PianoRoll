import { describe, expect, it, vi } from 'vitest'
import type { MidiFile } from '../../../core/midi/types'
import type { AppServices } from '../../../core/services'
import { createLearnState, type LearnState } from '../../core/LearnState'
import { cycleSpeedPreset, PlayAlongEngine } from './engine'

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
      store: null as never,
      clock: clock as unknown as AppServices['clock'],
      synth: synth as unknown as AppServices['synth'],
      metronome: null as never,
      renderer: renderer as unknown as AppServices['renderer'],
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

  it('restarts to the loop start, or to zero when no loop is set', () => {
    const { services, clock, learnState } = makeServices()
    const engine = new PlayAlongEngine({ services, learnState })
    engine.attach(makeMidi())

    clock.currentTime = 12
    engine.restart()
    expect(clock.currentTime).toBe(0)

    // With a region marked, "back to the top" means the top of the drill.
    clock.currentTime = 10
    engine.setLoopFromBars(4, 10, 60, 120)
    clock.currentTime = 7
    engine.restart()
    expect(clock.currentTime).toBeCloseTo(2)
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

  it('holds the chosen tempo across clean passes', () => {
    const { services, clock, learnState } = makeServices()
    const engine = new PlayAlongEngine({ services, learnState })
    engine.attach(makeMidi())
    engine.setSpeedPreset(60)
    engine.setLoopFromBars(4, 10, 60, 120)
    clock.currentTime = 10
    clock.emit(10.001)
    clock.currentTime = 10
    clock.emit(10.001)
    // Looping never rewrites the user's speed now that the auto-ramp is gone.
    expect(engine.state.speedPct).toBe(60)
    expect(engine.state.cleanPasses).toBe(2)
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

  it('toggleLoop seeds a region at the playhead, and toggles back off', () => {
    // The whole point of the new flow: one click gives you a real region to
    // trim, instead of asking you to catch two moments as the music runs.
    const { services, learnState } = makeServices()
    const engine = new PlayAlongEngine({ services, learnState })
    engine.attach(makeMidi()) // 60 s @ 120 BPM → 4 bars = 8 s

    engine.toggleLoop(10)
    expect(engine.state.loopRegion).toEqual({ start: 10, end: 18 })

    engine.toggleLoop(10)
    expect(engine.state.loopRegion).toBeNull()
  })

  it('slides the seeded region back when the playhead is near the end', () => {
    const { services, learnState } = makeServices()
    const engine = new PlayAlongEngine({ services, learnState })
    engine.attach(makeMidi())
    // 2 s from the end of a 60 s piece — a forward-only span would be clipped
    // to 2 s, so it shifts back to keep the full 4 bars.
    engine.toggleLoop(58)
    expect(engine.state.loopRegion).toEqual({ start: 52, end: 60 })
  })

  it('drags either edge, clamped to the piece and to a minimum span', () => {
    const { services, learnState } = makeServices()
    const engine = new PlayAlongEngine({ services, learnState })
    engine.attach(makeMidi())
    engine.toggleLoop(10) // [10, 18]

    engine.setLoopEdge('start', 4)
    expect(engine.state.loopRegion).toEqual({ start: 4, end: 18 })

    engine.setLoopEdge('end', 30)
    expect(engine.state.loopRegion).toEqual({ start: 4, end: 30 })

    // Past the opposite edge: parks at the minimum span rather than inverting
    // into a region wrapIfAtEnd would refuse to loop.
    engine.setLoopEdge('start', 45)
    expect(engine.state.loopRegion!.start).toBeCloseTo(29.75)
    expect(engine.state.loopRegion!.end).toBe(30)

    // Beyond the piece bounds.
    engine.setLoopEdge('end', 999)
    expect(engine.state.loopRegion!.end).toBe(60)
    engine.setLoopEdge('start', -5)
    expect(engine.state.loopRegion!.start).toBe(0)
  })

  it('setLoopEdge is a no-op when no loop is active', () => {
    const { services, learnState } = makeServices()
    const engine = new PlayAlongEngine({ services, learnState })
    engine.attach(makeMidi())
    expect(engine.setLoopEdge('start', 5)).toBeNull()
    expect(engine.state.loopRegion).toBeNull()
  })

  it('clearLoop wipes the region', () => {
    const { services, learnState } = makeServices()
    const engine = new PlayAlongEngine({ services, learnState })
    engine.attach(makeMidi())
    engine.toggleLoop(3)
    engine.clearLoop()
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
    engine.toggleLoop(2)
    engine.setLoopEdge('end', 2.3)

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

describe('PlayAlongEngine loop playhead snapping', () => {
  it('pulls a playhead sitting before the loop up to the start', () => {
    // Without this the first pass plays the lead-in: wrapIfAtEnd only fires at
    // the END of the region, so a playhead before `start` is never corrected.
    const { services, clock, learnState } = makeServices()
    const engine = new PlayAlongEngine({ services, learnState })
    engine.attach(makeMidi())
    clock.currentTime = 2
    engine.toggleLoop(20)
    expect(clock.currentTime).toBeCloseTo(20)
  })

  it('leaves a playhead already inside the loop alone', () => {
    const { services, clock, learnState } = makeServices()
    const engine = new PlayAlongEngine({ services, learnState })
    engine.attach(makeMidi())
    engine.toggleLoop(20)
    clock.currentTime = 24
    engine.snapPlayheadIntoLoop()
    expect(clock.currentTime).toBeCloseTo(24)
  })

  it('is a no-op with no loop active', () => {
    const { services, clock, learnState } = makeServices()
    const engine = new PlayAlongEngine({ services, learnState })
    engine.attach(makeMidi())
    clock.currentTime = 5
    engine.snapPlayheadIntoLoop()
    expect(clock.currentTime).toBeCloseTo(5)
  })
})

describe('PlayAlongEngine loop editing', () => {
  it('does not wrap, score a pass, or celebrate while an edge is being dragged', () => {
    // Parking the playhead on the end handle is how the user SEES what they are
    // trimming to. Without suspending the wrap it bounced straight back to the
    // loop start, counted a phantom clean pass and fired the celebration swell.
    const { services, clock, learnState } = makeServices()
    const onCleanPass = vi.fn()
    const engine = new PlayAlongEngine({ services, learnState, onCleanPass })
    engine.attach(makeMidi())
    engine.toggleLoop(10) // [10, 18]

    engine.beginLoopEdit()
    clock.currentTime = 18
    clock.emit(18)

    expect(clock.currentTime).toBeCloseTo(18)
    expect(engine.state.cleanPasses).toBe(0)
    expect(onCleanPass).not.toHaveBeenCalled()
  })

  it('re-arms wrapping and pulls the playhead back in on release', () => {
    const { services, clock, learnState } = makeServices()
    const engine = new PlayAlongEngine({ services, learnState })
    engine.attach(makeMidi())
    engine.toggleLoop(10)

    engine.beginLoopEdit()
    clock.currentTime = 18
    engine.endLoopEdit()
    expect(clock.currentTime).toBeCloseTo(10)

    // Wrapping works again once the drag is over.
    clock.currentTime = 18
    clock.emit(18)
    expect(engine.state.cleanPasses).toBe(1)
  })
})

describe('PlayAlongEngine loop ending at the end of the piece', () => {
  it('wraps instead of stopping when region.end === duration', () => {
    // wrapIfAtEnd's 5 ms epsilon is far smaller than a ~16.7 ms tick, so a tick
    // lands past `dur` before it ever lands inside the wrap window. With the
    // end-of-piece stop checked first, the engine paused at the end instead of
    // looping — and this is the COMMON case: toggleLoop slides its seeded span
    // back to finish exactly at `dur` near the end of a piece.
    const { services, clock, learnState } = makeServices()
    const engine = new PlayAlongEngine({ services, learnState })
    engine.attach(makeMidi()) // 60 s
    engine.toggleLoop(58) // slides back to [52, 60] — end === duration
    expect(engine.state.loopRegion).toEqual({ start: 52, end: 60 })

    engine.play()
    clock.emit(60.01) // a tick that overshoots both `dur` and the wrap window

    expect(clock.currentTime).toBeCloseTo(52)
    expect(engine.state.cleanPasses).toBe(1)
    expect(engine.state.userWantsToPlay).toBe(true)
  })

  it('still stops at the end of the piece when no loop is active', () => {
    const { services, clock, learnState } = makeServices()
    const engine = new PlayAlongEngine({ services, learnState })
    engine.attach(makeMidi())
    engine.play()
    clock.emit(60.01)
    expect(engine.state.userWantsToPlay).toBe(false)
    expect(clock.currentTime).toBeCloseTo(60)
  })
})

describe('cycleSpeedPreset', () => {
  it('steps forward and backward through the presets', () => {
    expect(cycleSpeedPreset(80, 1)).toBe(100)
    expect(cycleSpeedPreset(80, -1)).toBe(60)
  })

  it('wraps at both ends, so the chip and [ / ] cannot disagree', () => {
    // The shortcuts used to clamp while the chip wrapped: at 120 pressing ]
    // did nothing, but clicking the chip went back to 40.
    expect(cycleSpeedPreset(120, 1)).toBe(40)
    expect(cycleSpeedPreset(40, -1)).toBe(120)
  })

  it('falls back to the first preset for a value that is not a member', () => {
    // A speed set from elsewhere must not strand the control.
    expect(cycleSpeedPreset(73, 1)).toBe(60)
  })
})

describe('PlayAlongEngine loop seed width', () => {
  it('never seeds a region too thin to read as two handles', () => {
    // The handles sit just outside the region, so the gap between them IS the
    // loop's width on screen. A fixed 8 s on a 10-minute file is under 2% of the
    // bar — the pair would collapse into one blob.
    const { services, learnState } = makeServices()
    const engine = new PlayAlongEngine({ services, learnState })
    const long = makeMidi()
    long.duration = 600
    engine.attach(long)

    engine.toggleLoop(0)
    const region = engine.state.loopRegion!
    expect(region.end - region.start).toBeCloseTo(48) // 8% of 600
  })

  it('uses the flat default when it already clears the minimum', () => {
    const { services, learnState } = makeServices()
    const engine = new PlayAlongEngine({ services, learnState })
    engine.attach(makeMidi()) // 60 s → 8% is 4.8 s, so the 8 s default wins
    engine.toggleLoop(10)
    expect(engine.state.loopRegion).toEqual({ start: 10, end: 18 })
  })

  it('never seeds longer than the piece', () => {
    const { services, learnState } = makeServices()
    const engine = new PlayAlongEngine({ services, learnState })
    const short = makeMidi()
    short.duration = 5
    engine.attach(short)
    engine.toggleLoop(2)
    expect(engine.state.loopRegion).toEqual({ start: 0, end: 5 })
  })
})
