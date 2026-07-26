import { describe, expect, it, vi } from 'vitest'
import type { MidiNoteEvent } from '../../midi/MidiInputManager'
import { type BusNoteEvent, type BusPedalEvent, InputBus } from './InputBus'

function noteEvent(pitch: number, velocity = 0.75, clockTime = 0): MidiNoteEvent {
  return { pitch, velocity, clockTime }
}

describe('InputBus', () => {
  it('delivers note-on events to subscribers with the source attached', () => {
    const bus = new InputBus()
    const received: BusNoteEvent[] = []
    bus.noteOn.subscribe((e) => {
      if (e) received.push(e)
    })

    bus.emitNoteOn(noteEvent(60, 0.5, 1.2), 'midi')
    bus.emitNoteOn(noteEvent(72), 'touch')

    expect(received).toEqual([
      { pitch: 60, velocity: 0.5, clockTime: 1.2, source: 'midi' },
      { pitch: 72, velocity: 0.75, clockTime: 0, source: 'touch' },
    ])
  })

  it('delivers note-off events tagged with the source', () => {
    const bus = new InputBus()
    const received: BusNoteEvent[] = []
    bus.noteOff.subscribe((e) => {
      if (e) received.push(e)
    })

    bus.emitNoteOff(noteEvent(60, 0, 2.5), 'keyboard')
    expect(received).toEqual([{ pitch: 60, velocity: 0, clockTime: 2.5, source: 'keyboard' }])
  })

  it('preserves optional source, channel, and voice identity without requiring it', () => {
    const bus = new InputBus()
    const received: BusNoteEvent[] = []
    bus.noteOn.subscribe((event) => event && received.push(event))
    bus.emitNoteOn(
      {
        ...noteEvent(60),
        sourceId: 'device-a',
        channel: 3,
        voiceId: 'device-a:1',
      },
      'midi',
    )

    expect(received[0]).toMatchObject({
      pitch: 60,
      source: 'midi',
      sourceId: 'device-a',
      channel: 3,
      voiceId: 'device-a:1',
    })
  })

  it('routes guitar fretboard hits with their sourceId/channel/voiceId intact', () => {
    // Mirrors how `App` re-publishes `GuitarSurface.surfaceHits` — a fretboard
    // tap/click carries its own identity (string/fret encoded into the
    // sourceId, a per-press voiceId) the same way MIDI/keyboard input does.
    const bus = new InputBus()
    const received: BusNoteEvent[] = []
    bus.noteOn.subscribe((e) => e && received.push(e))
    bus.emitNoteOn(
      {
        pitch: 45,
        velocity: 0.9,
        clockTime: 1.5,
        sourceId: 'guitar:fretboard',
        voiceId: 'guitar:fretboard:pointer-1:3',
        string: 0,
        fret: 5,
      },
      'guitar',
    )
    expect(received[0]).toMatchObject({
      pitch: 45,
      source: 'guitar',
      sourceId: 'guitar:fretboard',
      voiceId: 'guitar:fretboard:pointer-1:3',
      string: 0,
      fret: 5,
    })
  })

  it('fans out pedal events to every subscriber', () => {
    const bus = new InputBus()
    const a: BusPedalEvent[] = []
    const b: BusPedalEvent[] = []
    bus.pedal.subscribe((e) => {
      if (e) a.push(e)
    })
    bus.pedal.subscribe((e) => {
      if (e) b.push(e)
    })

    bus.emitPedal(true, 'midi')
    bus.emitPedal(false, 'keyboard')

    const expected: BusPedalEvent[] = [
      { down: true, source: 'midi' },
      { down: false, source: 'keyboard' },
    ]
    expect(a).toEqual(expected)
    expect(b).toEqual(expected)
  })

  it('does not conflate note-on and note-off subscribers', () => {
    const bus = new InputBus()
    const onHandler = vi.fn()
    const offHandler = vi.fn()
    bus.noteOn.subscribe(onHandler)
    bus.noteOff.subscribe(offHandler)

    bus.emitNoteOn(noteEvent(60), 'midi')
    expect(onHandler).toHaveBeenCalledOnce()
    expect(offHandler).not.toHaveBeenCalled()

    bus.emitNoteOff(noteEvent(60, 0), 'midi')
    expect(offHandler).toHaveBeenCalledOnce()
  })

  it('emits fresh event objects so subscribers can safely mutate or stash', () => {
    // A downstream consumer that pushes the event into an array and later
    // mutates the array must not find the bus overwriting the payload on
    // the next emit. The bus always produces a new object per emit.
    const bus = new InputBus()
    const captured: BusNoteEvent[] = []
    bus.noteOn.subscribe((e) => {
      if (e) captured.push(e)
    })
    bus.emitNoteOn(noteEvent(60), 'midi')
    bus.emitNoteOn(noteEvent(64), 'midi')
    expect(captured[0]?.pitch).toBe(60)
    expect(captured[1]?.pitch).toBe(64)
    expect(captured[0]).not.toBe(captured[1])
  })
})
