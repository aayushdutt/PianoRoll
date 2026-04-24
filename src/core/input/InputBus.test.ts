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
