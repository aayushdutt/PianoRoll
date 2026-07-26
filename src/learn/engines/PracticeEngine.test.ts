import { describe, expect, it, vi } from 'vitest'
import type { MasterClock } from '../../core/clock/MasterClock'
import type { MidiFile } from '../../core/midi/types'
import { PracticeEngine } from './PracticeEngine'

function makeClock() {
  const listeners = new Set<(t: number) => void>()
  let t = 0
  return {
    get currentTime() {
      return t
    },
    emit(newT: number) {
      t = newT
      for (const fn of listeners) fn(newT)
    },
    pause: vi.fn(),
    play: vi.fn(),
    seek: vi.fn((newT: number) => {
      t = Math.max(0, newT)
      for (const fn of listeners) fn(t)
    }),
    subscribe(fn: (t: number) => void) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  }
}

function midiWithNotes(notes: Array<{ pitch: number; time: number }>): MidiFile {
  return {
    name: 'early.mid',
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
        notes: notes.map((note) => ({
          ...note,
          duration: 0.5,
          velocity: 1,
        })),
      },
    ],
  }
}

function makeEngine(midi: MidiFile = midiWithNotes([{ pitch: 60, time: 2 }])) {
  const clock = makeClock()
  const onWaitStart = vi.fn()
  const onWaitEnd = vi.fn()
  const engine = new PracticeEngine(clock as unknown as MasterClock, { onWaitStart, onWaitEnd })
  engine.loadMidi(midi)
  engine.setEnabled(true)
  return { clock, engine, onWaitStart, onWaitEnd }
}

describe('PracticeEngine.notePressed outcome types', () => {
  it('returns "duplicate" for a re-strike of an already-accepted pitch while the chord is still pending', () => {
    const { clock, engine } = makeEngine(
      midiWithNotes([
        { pitch: 60, time: 2 },
        { pitch: 64, time: 2 },
      ]),
    )
    clock.emit(2.01)
    expect(engine.notePressed(60).kind).toBe('accepted') // 60 → accepted, 64 still pending
    // Re-strike the accepted pitch — not 'rejected' (that would bump errors)
    // and not 'advanced' (chord not cleared yet).
    expect(engine.notePressed(60).kind).toBe('duplicate')
  })

  it('measures articulationMs as wall-clock span from first to last pitch on a chord', () => {
    const { clock, engine } = makeEngine(
      midiWithNotes([
        { pitch: 60, time: 2 },
        { pitch: 64, time: 2 },
      ]),
    )
    let nowMs = 0
    ;(engine as unknown as { nowMs: () => number }).nowMs = () => nowMs
    clock.emit(2.01)
    nowMs = 1000
    engine.notePressed(60) // first pitch → chordStartMs = 1000
    nowMs = 1300
    const outcome = engine.notePressed(64) // second pitch → chord clears, articulationMs = 300
    expect(outcome.kind).toBe('advanced')
    if (outcome.kind === 'advanced') {
      expect(outcome.articulationMs).toBeCloseTo(300)
    }
  })

  it('does not bleed chordStartMs from a cleared step into the next step', () => {
    // If advancePastCurrentStep doesn't reset chordStartMs, the second chord's
    // articulationMs would be measured from the first chord's first press —
    // thousands of ms — instead of the second chord's own span.
    const { clock, engine } = makeEngine(
      midiWithNotes([
        { pitch: 60, time: 2 },
        { pitch: 64, time: 2 },
        { pitch: 67, time: 5 },
        { pitch: 71, time: 5 },
      ]),
    )
    let nowMs = 0
    ;(engine as unknown as { nowMs: () => number }).nowMs = () => nowMs

    // Clear step 1 quickly (40 ms articulation).
    clock.emit(2.01)
    nowMs = 0
    engine.notePressed(60)
    nowMs = 40
    engine.notePressed(64) // clears step 1 → chordStartMs reset to null

    // Engage step 2. chordStartMs must start fresh on the first press here.
    clock.emit(5.01)
    nowMs = 5000
    engine.notePressed(67) // chordStartMs = 5000
    nowMs = 5200
    const outcome = engine.notePressed(71) // articulationMs = 200
    expect(outcome.kind).toBe('advanced')
    if (outcome.kind === 'advanced') {
      // If the bleed were present this would be ~5160 ms — far larger than 200.
      expect(outcome.articulationMs).toBeCloseTo(200, 0)
    }
  })

  it('notifySeek while waiting clears the wait state completely', () => {
    const { clock, engine } = makeEngine(
      midiWithNotes([
        { pitch: 60, time: 2 },
        { pitch: 64, time: 2 },
      ]),
    )
    clock.emit(2.01) // engage wait
    expect(engine.isWaiting).toBe(true)
    expect(engine.status.value.pending.size).toBeGreaterThan(0)

    engine.notifySeek(0)
    // Check the published status (what the HUD reads), not the internal field.
    expect(engine.status.value.waiting).toBe(false)
    expect(engine.status.value.pending.size).toBe(0)
    expect(engine.status.value.accepted.size).toBe(0)
  })
})

describe('PracticeEngine early note acceptance', () => {
  it('accepts the next step when played slightly before the target time', () => {
    const { clock, engine, onWaitStart, onWaitEnd } = makeEngine()

    clock.emit(1.9)
    const outcome = engine.notePressed(60)

    expect(outcome.kind).toBe('advanced')
    expect(onWaitStart).toHaveBeenCalledOnce()
    expect(onWaitEnd).toHaveBeenCalledWith(2.006)
    expect(engine.isWaiting).toBe(false)
  })

  it('does not accept a matching note outside the early window', () => {
    const { clock, engine, onWaitStart, onWaitEnd } = makeEngine()

    clock.emit(1.87)
    const outcome = engine.notePressed(60)

    expect(outcome.kind).toBe('rejected')
    expect(onWaitStart).not.toHaveBeenCalled()
    expect(onWaitEnd).not.toHaveBeenCalled()
    expect(engine.isWaiting).toBe(false)
  })

  it('does not punish a wrong early note by entering wait mode', () => {
    const { clock, engine, onWaitStart, onWaitEnd } = makeEngine()

    clock.emit(1.9)
    const outcome = engine.notePressed(61)

    expect(outcome.kind).toBe('rejected')
    expect(onWaitStart).not.toHaveBeenCalled()
    expect(onWaitEnd).not.toHaveBeenCalled()
    expect(engine.isWaiting).toBe(false)
  })

  it('keeps early chord notes accepted until the chord is completed', () => {
    const { clock, engine, onWaitStart, onWaitEnd } = makeEngine(
      midiWithNotes([
        { pitch: 60, time: 2 },
        { pitch: 64, time: 2 },
      ]),
    )

    clock.emit(1.9)
    expect(engine.notePressed(60).kind).toBe('accepted')
    expect(engine.isWaiting).toBe(true)
    expect(engine.status.value.pending).toEqual(new Set([64]))
    expect(engine.status.value.accepted).toEqual(new Set([60]))

    expect(engine.notePressed(64).kind).toBe('advanced')
    expect(onWaitStart).toHaveBeenCalledOnce()
    expect(onWaitEnd).toHaveBeenCalledWith(2.006)
    expect(engine.isWaiting).toBe(false)
  })

  it('does not engage a due wait when filtering tracks while disabled', () => {
    const { clock, engine, onWaitStart } = makeEngine()

    engine.setEnabled(false)
    clock.emit(2.01)
    engine.setVisibleTracks(['rh'])

    expect(engine.isWaiting).toBe(false)
    expect(onWaitStart).not.toHaveBeenCalled()
  })

  it('accepts a note at exactly the EARLY_ACCEPT_SEC boundary (boundary is inclusive)', () => {
    // EARLY_ACCEPT_SEC = 0.12; note at t=2; lower boundary = 2.0 - 0.12 = 1.88.
    // Guard: `time < step.time - EARLY_ACCEPT_SEC` → `1.88 < 1.88` → false → not rejected.
    // In IEEE 754, `2.0 - 0.12` and `1.88` share the same bit pattern, so the
    // comparison is equality and the `<` keeps it inclusive.
    const { clock, engine } = makeEngine()
    clock.emit(1.88)
    expect(engine.notePressed(60).kind).toBe('advanced')
  })

  it('rejects a note pressed one step before the EARLY_ACCEPT_SEC boundary', () => {
    const { clock, engine } = makeEngine()
    clock.emit(1.879) // 1.879 < 1.88 → strictly outside the window
    expect(engine.notePressed(60).kind).toBe('rejected')
  })
})

describe('PracticeEngine.setEnabled while waiting', () => {
  it('silently drops wait state without calling onWaitEnd', () => {
    // Firing onWaitEnd here would ask the caller to resume playback while
    // they are actively trying to stop — the comment in setEnabled explains
    // the contract. A future refactor that calls onWaitEnd "for symmetry"
    // would bleed audio on mode exit.
    const { clock, engine, onWaitEnd } = makeEngine()
    clock.emit(2.01)
    expect(engine.isWaiting).toBe(true)
    engine.setEnabled(false)
    expect(engine.isWaiting).toBe(false)
    expect(onWaitEnd).not.toHaveBeenCalled()
  })
})

describe('PracticeEngine step building and peekNextStep', () => {
  it('excludes drum tracks — drum hits never create a wait step', () => {
    const drumMidi: MidiFile = {
      name: 'drums.mid',
      duration: 10,
      bpm: 120,
      timeSignature: [4, 4],
      tracks: [
        {
          id: 'dr',
          name: 'Drums',
          channel: 9,
          instrument: 0,
          isDrum: true,
          color: 0xffffff,
          colorIndex: 0,
          notes: [{ pitch: 36, time: 2, duration: 0.1, velocity: 1 }],
        },
      ],
    }
    const { clock, engine, onWaitStart } = makeEngine(drumMidi)
    clock.emit(2.01)
    expect(engine.isWaiting).toBe(false)
    expect(onWaitStart).not.toHaveBeenCalled()
  })

  it('peekNextStep returns the upcoming step before it is cleared', () => {
    const { engine } = makeEngine()
    const step = engine.peekNextStep()
    expect(step).not.toBeNull()
    expect(step?.pitches.has(60)).toBe(true)
  })

  it('peekNextStep returns null after the last step is cleared', () => {
    const { clock, engine } = makeEngine()
    clock.emit(2.01)
    engine.notePressed(60)
    expect(engine.peekNextStep()).toBeNull()
  })

  it('peekNextStep returns null when no MIDI is loaded', () => {
    const clock = makeClock()
    const engine = new PracticeEngine(clock as unknown as MasterClock, {
      onWaitStart: vi.fn(),
      onWaitEnd: vi.fn(),
    })
    engine.setEnabled(true)
    expect(engine.peekNextStep()).toBeNull()
  })
})

function midiWithTwoTracks(): MidiFile {
  return {
    name: 'two.mid',
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
        notes: [{ pitch: 60, time: 2, duration: 0.5, velocity: 1 }],
      },
      {
        id: 'lh',
        name: 'Left',
        channel: 1,
        instrument: 0,
        isDrum: false,
        color: 0xffffff,
        colorIndex: 1,
        notes: [{ pitch: 48, time: 4, duration: 0.5, velocity: 1 }],
      },
    ],
  }
}

describe('PracticeEngine.setVisibleTracks', () => {
  it('filters steps to only the visible track', () => {
    const { engine } = makeEngine(midiWithTwoTracks())
    engine.setVisibleTracks(['rh'])
    const step = engine.peekNextStep()
    expect(step?.pitches.has(60)).toBe(true) // rh pitch
    expect(step?.pitches.has(48)).toBe(false) // lh pitch excluded
  })

  it('setVisibleTracks(null) restores all tracks', () => {
    const { engine } = makeEngine(midiWithTwoTracks())
    engine.setVisibleTracks(['rh'])
    engine.setVisibleTracks(null)
    // Both steps should be present — rh at t=2 is first.
    const first = engine.peekNextStep()
    expect(first?.pitches.has(60)).toBe(true)
  })

  it('switching to a different track while not waiting recomputes steps without engaging wait', () => {
    const { clock, engine, onWaitStart } = makeEngine(midiWithTwoTracks())
    clock.emit(0.5) // well before either note
    engine.setVisibleTracks(['lh'])
    expect(engine.isWaiting).toBe(false)
    expect(onWaitStart).not.toHaveBeenCalled()
    // Next step is now lh's note at t=4.
    expect(engine.peekNextStep()?.pitches.has(48)).toBe(true)
  })
})

// Guitar Play-Along: pitches a filter excludes (e.g. outside the fretboard's
// range) stay audible/visible via the schedule/synth — this only tests what
// wait-mode *requires*. Uses a fake "unsupported past 100" filter rather than
// the real guitar profile so the engine's behavior is tested independent of
// guitar/profile.ts (that has its own tests).
const dropHighPitches = (pitches: ReadonlySet<number>): Set<number> =>
  new Set([...pitches].filter((p) => p < 100))

describe('PracticeEngine.setPitchFilter — unsupported-voice scoring', () => {
  it('ends and advances an active wait when filtering removes the whole step', () => {
    const { clock, engine, onWaitEnd } = makeEngine(
      midiWithNotes([
        { pitch: 60, time: 2 },
        { pitch: 64, time: 5 },
      ]),
    )
    clock.emit(2.01)
    expect(engine.isWaiting).toBe(true)
    engine.setPitchFilter((pitches) => new Set([...pitches].filter((pitch) => pitch !== 60)))
    expect(onWaitEnd).toHaveBeenCalledWith(2.006)
    expect(engine.isWaiting).toBe(false)
    expect(engine.peekNextStep()?.time).toBe(5)
  })

  it('preserves articulation start time when an accepted pitch survives filtering', () => {
    const { clock, engine } = makeEngine(
      midiWithNotes([
        { pitch: 60, time: 2 },
        { pitch: 64, time: 2 },
        { pitch: 67, time: 2 },
      ]),
    )
    let nowMs = 1000
    ;(engine as unknown as { nowMs: () => number }).nowMs = () => nowMs
    clock.emit(2.01)
    expect(engine.notePressed(60).kind).toBe('accepted')
    engine.setPitchFilter((pitches) => new Set([...pitches].filter((pitch) => pitch !== 67)))
    nowMs = 1123
    expect(engine.notePressed(64)).toMatchObject({ kind: 'advanced', articulationMs: 123 })
  })

  it('narrows a mixed chord to only the pitches the filter allows', () => {
    const { engine } = makeEngine(
      midiWithNotes([
        { pitch: 60, time: 2 },
        { pitch: 130, time: 2 },
      ]),
    )
    engine.setPitchFilter(dropHighPitches)
    expect(engine.peekNextStep()?.pitches).toEqual(new Set([60]))
  })

  it('drops an all-unsupported step entirely so playback advances through it unblocked', () => {
    const { clock, engine, onWaitStart } = makeEngine(
      midiWithNotes([
        { pitch: 130, time: 2 },
        { pitch: 140, time: 2 },
        { pitch: 60, time: 5 },
      ]),
    )
    engine.setPitchFilter(dropHighPitches)
    // The all-unsupported chord at t=2 must not appear as a step at all —
    // the next (only) step is the supported one at t=5.
    expect(engine.peekNextStep()?.time).toBe(5)

    clock.emit(2)
    expect(onWaitStart).not.toHaveBeenCalled()
    expect(engine.isWaiting).toBe(false)

    clock.emit(5 - 0.005)
    expect(onWaitStart).toHaveBeenCalledTimes(1)
    expect(engine.isWaiting).toBe(true)
  })

  it('an all-unsupported group between two supported ones does not stall either', () => {
    const { clock, engine, onWaitStart } = makeEngine(
      midiWithNotes([
        { pitch: 60, time: 1 },
        { pitch: 130, time: 3 },
        { pitch: 64, time: 6 },
      ]),
    )
    engine.setPitchFilter(dropHighPitches)
    expect(engine.peekNextStep()?.time).toBe(1)
    const first = engine.notePressed(60)
    expect(first.kind).toBe('rejected') // not waiting yet at t=0
    clock.emit(1 - 0.005)
    expect(engine.notePressed(60).kind).toBe('advanced')
    // Next step must skip straight to t=6 — the unsupported t=3 chord never
    // became a step.
    expect(engine.peekNextStep()?.time).toBe(6)
    clock.emit(3)
    expect(engine.isWaiting).toBe(false)
    clock.emit(6 - 0.005)
    expect(onWaitStart).toHaveBeenCalledTimes(2)
  })

  it('clearing the filter (null) restores every pitch as required again', () => {
    const { engine } = makeEngine(
      midiWithNotes([
        { pitch: 60, time: 2 },
        { pitch: 130, time: 2 },
      ]),
    )
    engine.setPitchFilter(dropHighPitches)
    expect(engine.peekNextStep()?.pitches).toEqual(new Set([60]))
    engine.setPitchFilter(null)
    expect(engine.peekNextStep()?.pitches).toEqual(new Set([60, 130]))
  })
})

describe('PracticeEngine.toggle and dispose', () => {
  it('toggle() alternates enabled state and returns the new value', () => {
    const { engine } = makeEngine()
    expect(engine.isEnabled).toBe(true)
    expect(engine.toggle()).toBe(false)
    expect(engine.isEnabled).toBe(false)
    expect(engine.toggle()).toBe(true)
    expect(engine.isEnabled).toBe(true)
  })

  it('dispose() stops the clock subscription — ticks no longer engage wait', () => {
    const { clock, engine, onWaitStart } = makeEngine()
    engine.dispose()
    clock.emit(2.01)
    expect(engine.isWaiting).toBe(false)
    expect(onWaitStart).not.toHaveBeenCalled()
  })
})
