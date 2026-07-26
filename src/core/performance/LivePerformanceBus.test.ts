import { describe, expect, it } from 'vitest'
import { createLivePerformanceBus } from './LivePerformanceBus'

function makeNoteOn(pitch: number, vel = 1) {
  return { pitch, velocity: vel, clockTime: 1, source: 'keyboard' as const }
}

function makeNoteOff(pitch: number) {
  return { pitch, velocity: 0, clockTime: 2, source: 'keyboard' as const }
}

describe('LivePerformanceBus', () => {
  it('fan-out: noteOn reaches all on-note subscribers', () => {
    const bus = createLivePerformanceBus()
    const received: number[] = []
    const unsub = bus.subscribeNotes(
      (e) => received.push(e.pitch),
      () => {},
    )
    bus.routeNoteOn(makeNoteOn(60))
    bus.routeNoteOn(makeNoteOn(64))
    expect(received).toEqual([60, 64])
    unsub()
    bus.routeNoteOn(makeNoteOn(67))
    expect(received).toEqual([60, 64]) // no new call after unsub
  })

  it('noteOff without pedal reaches off-note subscribers', () => {
    const bus = createLivePerformanceBus()
    const offs: number[] = []
    bus.subscribeNotes(
      () => {},
      (e) => offs.push(e.pitch),
    )
    bus.routeNoteOff(makeNoteOff(60))
    expect(offs).toEqual([60])
  })

  it('pedal held: noteOff defers to sustained, released on pedal-up', () => {
    const bus = createLivePerformanceBus()
    const offs: number[] = []
    bus.subscribeNotes(
      () => {},
      (e) => offs.push(e.pitch),
    )

    bus.routePedalDown('keyboard')
    expect(bus.pedalDown).toBe(true)

    bus.routeNoteOff(makeNoteOff(60))
    bus.routeNoteOff(makeNoteOff(64))
    expect(offs).toEqual([]) // deferred

    bus.routePedalUp('keyboard')
    expect(bus.pedalDown).toBe(false)
    expect(offs).toEqual([60, 64])
  })

  it('treats a guitar-sourced note-on/off like any other input source', () => {
    // Guitar has no pedal of its own, but its note events must flow through
    // the same fan-out as MIDI/keyboard — no special-cased source list to
    // fall through.
    const bus = createLivePerformanceBus()
    const ons: string[] = []
    bus.subscribeNotes(
      (e) => ons.push(`${e.source}:${e.pitch}`),
      () => {},
    )
    bus.routeNoteOn({
      pitch: 45,
      velocity: 0.8,
      clockTime: 1,
      source: 'guitar',
      sourceId: 'guitar:fretboard',
      voiceId: 'guitar:fretboard:pointer-1:1',
      string: 0,
      fret: 5,
    })
    expect(ons).toEqual(['guitar:45'])
  })

  it('keeps sustained equal pitches distinct by voice across channels and sources', () => {
    const bus = createLivePerformanceBus()
    const offs: string[] = []
    bus.subscribeNotes(
      () => {},
      (event) => offs.push(event.voiceId ?? ''),
    )
    bus.routePedalDown('midi')
    bus.routeNoteOff({
      ...makeNoteOff(60),
      source: 'midi',
      sourceId: 'a',
      channel: 0,
      voiceId: 'a-0',
    })
    bus.routeNoteOff({
      ...makeNoteOff(60),
      source: 'midi',
      sourceId: 'b',
      channel: 1,
      voiceId: 'b-1',
    })

    expect(bus.sustainedPitches).toEqual(new Set([60]))
    expect(bus.sustainedVoiceIds).toEqual(new Set(['a-0', 'b-1']))
    bus.routePedalUp('midi')
    expect(offs).toEqual(['a-0', 'b-1'])
  })

  it('pedal merge: OR of MIDI and keyboard sources', () => {
    const bus = createLivePerformanceBus()

    bus.routePedalDown('midi')
    expect(bus.pedalDown).toBe(true)

    bus.routePedalDown('keyboard')
    expect(bus.pedalDown).toBe(true)

    // Release only MIDI — pedal should still be down (keyboard still held)
    bus.routePedalUp('midi')
    expect(bus.pedalDown).toBe(true)

    // Release keyboard too — now pedal should be up
    bus.routePedalUp('keyboard')
    expect(bus.pedalDown).toBe(false)
  })

  it('repress-release: re-pressing a sustained pitch emits note-off first', () => {
    const bus = createLivePerformanceBus()
    const onEvents: Array<{ pitch: number; velocity: number }> = []
    const offEvents: Array<{ pitch: number }> = []
    bus.subscribeNotes(
      (e) => onEvents.push(e),
      (e) => offEvents.push(e),
    )

    // Hold pedal, release note 60 (goes to sustained)
    bus.routePedalDown('keyboard')
    bus.routeNoteOn(makeNoteOn(60))
    bus.routeNoteOff(makeNoteOff(60))
    expect(offEvents).toEqual([]) // deferred

    // Re-press 60 — should emit noteOff for the sustained one, then noteOn
    bus.routeNoteOn(makeNoteOn(60, 0.8))
    expect(offEvents.length).toBe(1)
    expect(offEvents[0]!.pitch).toBe(60)
    expect(onEvents.length).toBe(2) // first noteOn + re-press noteOn
    expect(onEvents[1]!.pitch).toBe(60)
    expect(onEvents[1]!.velocity).toBe(0.8)
  })

  it('pedal subscribers receive true/false on transitions', () => {
    const bus = createLivePerformanceBus()
    const states: boolean[] = []
    bus.subscribePedal((down) => states.push(down))

    bus.routePedalDown('midi')
    expect(states).toEqual([true])

    bus.routePedalDown('keyboard')
    expect(states).toEqual([true]) // no duplicate true

    bus.routePedalUp('midi')
    expect(states).toEqual([true]) // still down

    bus.routePedalUp('keyboard')
    expect(states).toEqual([true, false])
  })

  it('routed events carry pedalDown state', () => {
    const bus = createLivePerformanceBus()
    const flags: boolean[] = []
    bus.subscribeNotes(
      (e) => flags.push(e.pedalDown),
      () => {},
    )

    bus.routeNoteOn(makeNoteOn(60))
    expect(flags).toEqual([false])

    bus.routePedalDown('midi')
    bus.routeNoteOn(makeNoteOn(64))
    expect(flags).toEqual([false, true])
  })

  it('pedal-up synthetic note-offs carry clockTime: -1', () => {
    const bus = createLivePerformanceBus()
    const times: number[] = []
    bus.subscribeNotes(
      () => {},
      (e) => times.push(e.clockTime),
    )

    bus.routePedalDown('keyboard')
    bus.routeNoteOff(makeNoteOff(60))
    bus.routeNoteOff(makeNoteOff(64))
    // Mark the internal sustained state
    expect(bus.sustainedPitches.size).toBe(2)

    bus.routePedalUp('keyboard')
    expect(times.length).toBe(2)
    expect(times[0]).toBe(-1) // synthetic
  })

  it('forceReleaseAll clears pedal state and releases sustained pitches', () => {
    const bus = createLivePerformanceBus()
    const offs: number[] = []
    const pedalStates: boolean[] = []
    bus.subscribeNotes(
      () => {},
      (e) => offs.push(e.pitch),
    )
    bus.subscribePedal((down) => pedalStates.push(down))

    // Hold pedal, release two notes (deferred)
    bus.routePedalDown('midi')
    expect(bus.pedalDown).toBe(true)
    bus.routeNoteOff(makeNoteOff(60))
    bus.routeNoteOff(makeNoteOff(64))
    expect(offs).toEqual([])

    // Emergency reset with real clockTime
    bus.forceReleaseAll(42)
    expect(bus.pedalDown).toBe(false)
    expect(offs).toEqual([60, 64])
    expect(pedalStates).toEqual([true, false])
  })

  it('after forceReleaseAll, pedal sources are all false', () => {
    const bus = createLivePerformanceBus()
    bus.routePedalDown('midi')
    bus.routePedalDown('keyboard')
    expect(bus.pedalDown).toBe(true)

    bus.forceReleaseAll(0)
    expect(bus.pedalDown).toBe(false)

    // Partial source re-activation should work
    bus.routePedalDown('midi')
    expect(bus.pedalDown).toBe(true)
  })

  it('pedal-up note-offs use clockTime: -1', () => {
    const bus = createLivePerformanceBus()
    const times: number[] = []
    bus.subscribeNotes(
      () => {},
      (e) => times.push(e.clockTime),
    )

    bus.routePedalDown('midi')
    bus.routeNoteOff(makeNoteOff(60))
    bus.routePedalUp('midi')

    expect(times).toEqual([-1])
  })
})
