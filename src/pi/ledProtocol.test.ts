import { describe, expect, it } from 'vitest'
import {
  applyLedMessage,
  LED_OUTPUT_COUNT,
  midiVelocityToUnit,
  parseLedMessageJson,
} from './ledProtocol'

describe('LED harness protocol', () => {
  it('accepts an in-range set message', () => {
    expect(parseLedMessageJson('{"type":"set","index":99,"on":true}')).toEqual({
      type: 'set',
      index: 99,
      on: true,
    })
  })

  it('accepts pedal state without changing LED outputs', () => {
    const message = parseLedMessageJson(
      '{"type":"pedal","down":true,"t":1.25,"confidence":0.91}',
    )
    expect(message).toEqual({
      type: 'pedal', down: true, t: 1.25, confidence: 0.91,
    })
    const initial = Array.from({ length: LED_OUTPUT_COUNT }, () => false)
    expect(applyLedMessage(initial, message!)).toEqual(initial)
  })

  it('rejects out-of-range and malformed messages', () => {
    expect(parseLedMessageJson('{"type":"set","index":100,"on":true}')).toBeNull()
    expect(parseLedMessageJson('{not json')).toBeNull()
  })

  it('accepts Pi playback status', () => {
    expect(
      parseLedMessageJson(
        '{"type":"status","state":"paused","song":"demo.mid","position":2,"duration":5,"eventCount":10}',
      ),
    ).toEqual({
      type: 'status',
      state: 'paused',
      song: 'demo.mid',
      position: 2,
      duration: 5,
      eventCount: 10,
    })
  })

  it('applies set and clear messages immutably', () => {
    const initial = Array.from({ length: LED_OUTPUT_COUNT }, () => false)
    const lit = applyLedMessage(initial, { type: 'set', index: 42, on: true })
    expect(initial[42]).toBe(false)
    expect(lit[42]).toBe(true)
    expect(applyLedMessage(lit, { type: 'clear_all' }).some(Boolean)).toBe(false)
  })

  it('normalizes Pi MIDI velocity for Midee', () => {
    expect(midiVelocityToUnit(0)).toBe(0)
    expect(midiVelocityToUnit(64)).toBeCloseTo(64 / 127)
    expect(midiVelocityToUnit(127)).toBe(1)
    expect(midiVelocityToUnit(200)).toBe(1)
    expect(midiVelocityToUnit(undefined)).toBe(0.8)
  })

  it('accepts chunked evaluation traces', () => {
    expect(
      parseLedMessageJson(
        '{"type":"evaluation_trace","sessionId":"abc","chunkIndex":0,"chunkCount":1,"records":[{"stage":"detected","serverTime":1.2,"pitch":60}]}',
      ),
    ).toMatchObject({
      type: 'evaluation_trace',
      sessionId: 'abc',
      chunkIndex: 0,
      chunkCount: 1,
    })
  })
})
