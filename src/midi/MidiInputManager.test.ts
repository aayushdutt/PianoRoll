import { describe, expect, it, vi } from 'vitest'
import type { MasterClock } from '../core/clock/MasterClock'
import { backdateEventTime, MidiInputManager, parseMidiMessage } from './MidiInputManager'

// Only the pure decode/timing helpers are tested here. Device hot-plug and
// `requestMIDIAccess` wiring need a real MIDIAccess and are covered by e2e.

describe('backdateEventTime', () => {
  it('shifts the clock time backwards for a past event (negative delta)', () => {
    // Event fired 20ms before our callback runs → clock pulled back 0.02s.
    const result = backdateEventTime(10, /* eventTs */ 1000, /* now */ 1020, /* speed */ 1)
    expect(result).toBeCloseTo(10 - 0.02, 6)
  })

  it('returns the clock time unchanged when the event timestamp equals now', () => {
    expect(backdateEventTime(5, 500, 500, 1)).toBe(5)
  })

  it('scales the back-dating delta by playback speed', () => {
    // 50ms in the past, 2x speed → the past delta covers twice the clock time.
    const at1x = backdateEventTime(10, 1000, 1050, 1)
    const at2x = backdateEventTime(10, 1000, 1050, 2)
    expect(at1x).toBeCloseTo(10 - 0.05, 6)
    expect(at2x).toBeCloseTo(10 - 0.1, 6)
  })

  it('clamps the result at 0 so clock time never goes negative', () => {
    // A large past delta would underflow; clamp keeps it at 0.
    expect(backdateEventTime(0.01, 1000, 2000, 1)).toBe(0)
    expect(backdateEventTime(0, 0, 5000, 4)).toBe(0)
  })

  it('handles a future event timestamp (positive delta) by moving forward', () => {
    expect(backdateEventTime(10, 1100, 1000, 1)).toBeCloseTo(10.1, 6)
  })
})

describe('parseMidiMessage', () => {
  it('returns none for missing or too-short data', () => {
    expect(parseMidiMessage(null, false)).toEqual({ kind: 'none' })
    expect(parseMidiMessage(undefined, false)).toEqual({ kind: 'none' })
    expect(parseMidiMessage([0x90], false)).toEqual({ kind: 'none' })
  })

  it('decodes a note-on with normalised velocity and a zero-based channel', () => {
    expect(parseMidiMessage([0x95, 60, 127], false)).toEqual({
      kind: 'noteOn',
      pitch: 60,
      velocity: 1,
      channel: 5,
    })
    expect(parseMidiMessage([0x90, 64, 64], false)).toMatchObject({
      kind: 'noteOn',
      pitch: 64,
    })
  })

  it('decodes an explicit note-off (0x80)', () => {
    expect(parseMidiMessage([0x8f, 60, 64], false)).toEqual({
      kind: 'noteOff',
      pitch: 60,
      channel: 15,
    })
  })

  it('coerces a velocity-0 note-on into a note-off (running-status hardware)', () => {
    expect(parseMidiMessage([0x92, 60, 0], false)).toEqual({
      kind: 'noteOff',
      pitch: 60,
      channel: 2,
    })
  })

  it('emits pedal-down when CC64 crosses the >=64 threshold', () => {
    expect(parseMidiMessage([0xb0, 64, 127], false)).toEqual({
      kind: 'pedal',
      down: true,
      channel: 0,
    })
    expect(parseMidiMessage([0xb0, 64, 64], false)).toEqual({
      kind: 'pedal',
      down: true,
      channel: 0,
    })
  })

  it('emits pedal-up when CC64 is below the threshold', () => {
    expect(parseMidiMessage([0xb0, 64, 63], true)).toEqual({
      kind: 'pedal',
      down: false,
      channel: 0,
    })
    expect(parseMidiMessage([0xb0, 64, 0], true)).toEqual({
      kind: 'pedal',
      down: false,
      channel: 0,
    })
  })

  it('dedupes redundant same-state pedal messages', () => {
    // Hardware streams repeated 127s while held — no re-emit when already down.
    expect(parseMidiMessage([0xb0, 64, 127], true)).toEqual({ kind: 'none' })
    // ...and repeated 0s while already up.
    expect(parseMidiMessage([0xb0, 64, 0], false)).toEqual({ kind: 'none' })
  })

  it('ignores non-CC64 controllers, pitch-bend, aftertouch, etc.', () => {
    expect(parseMidiMessage([0xb0, 7, 100], false)).toEqual({ kind: 'none' }) // CC7 volume
    expect(parseMidiMessage([0xe0, 0, 64], false)).toEqual({ kind: 'none' }) // pitch-bend
    expect(parseMidiMessage([0xd0, 80, 0], false)).toEqual({ kind: 'none' }) // channel pressure
  })

  it('accepts a Uint8Array as well as a number[]', () => {
    expect(parseMidiMessage(new Uint8Array([0x90, 72, 100]), false)).toMatchObject({
      kind: 'noteOn',
      pitch: 72,
    })
  })
})

describe('MidiInputManager voice identity', () => {
  it('pairs repeated notes FIFO per source/channel and releases voices on disconnect', async () => {
    const input = {
      id: 'device-a',
      name: 'Controller',
      state: 'connected',
      onmidimessage: null as ((event: MIDIMessageEvent) => void) | null,
    }
    const access = {
      inputs: new Map([['device-a', input]]),
      onstatechange: null as (() => void) | null,
    }
    vi.stubGlobal('navigator', { requestMIDIAccess: vi.fn(async () => access) })
    vi.spyOn(performance, 'now').mockReturnValue(100)
    const clock = { currentTime: 10, speed: 1 } as MasterClock
    const manager = new MidiInputManager(clock)
    const ons: NonNullable<(typeof manager.noteOn)['value']>[] = []
    const offs: NonNullable<(typeof manager.noteOff)['value']>[] = []
    manager.noteOn.subscribe((event) => event && ons.push(event))
    manager.noteOff.subscribe((event) => event && offs.push(event))
    await manager.requestAccess()

    const send = (bytes: number[]) =>
      input.onmidimessage?.({ data: new Uint8Array(bytes), timeStamp: 100 } as MIDIMessageEvent)
    send([0x91, 60, 100])
    send([0x91, 60, 110])
    send([0x92, 60, 120])
    send([0x91, 60, 0])

    expect(ons).toHaveLength(3)
    expect(ons[0]).toMatchObject({ sourceId: 'device-a', channel: 1, pitch: 60 })
    expect(ons[0]!.voiceId).not.toBe(ons[1]!.voiceId)
    expect(ons[2]).toMatchObject({ channel: 2 })
    expect(offs[0]!.voiceId).toBe(ons[0]!.voiceId)

    input.state = 'disconnected'
    access.onstatechange?.()
    expect(offs.map((event) => event.voiceId)).toEqual([
      ons[0]!.voiceId,
      ons[1]!.voiceId,
      ons[2]!.voiceId,
    ])
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })
})
