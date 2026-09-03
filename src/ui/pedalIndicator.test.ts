import { describe, expect, it } from 'vitest'
import { pedalIndicatorState } from './pedalIndicator'

const base = {
  pieceHolds: null,
  time: 0,
  liveDown: false,
  midiConnected: false,
  liveEverUsed: false,
}

describe('pedalIndicatorState', () => {
  it('is hidden with nothing to show', () => {
    expect(pedalIndicatorState(base)).toEqual({ visible: false, down: false })
    expect(pedalIndicatorState({ ...base, pieceHolds: [] })).toEqual({
      visible: false,
      down: false,
    })
  })

  it('follows the piece while it plays', () => {
    const holds = [{ start: 1, end: 2 }]
    expect(pedalIndicatorState({ ...base, pieceHolds: holds, time: 0.5 })).toEqual({
      visible: true,
      down: false,
    })
    expect(pedalIndicatorState({ ...base, pieceHolds: holds, time: 1.5 })).toEqual({
      visible: true,
      down: true,
    })
  })

  it('shows for a connected device and lights on the player pedal', () => {
    expect(pedalIndicatorState({ ...base, midiConnected: true })).toEqual({
      visible: true,
      down: false,
    })
    expect(pedalIndicatorState({ ...base, midiConnected: true, liveDown: true })).toEqual({
      visible: true,
      down: true,
    })
  })

  it('stays visible once a keyboard pedal has been used without a device', () => {
    expect(pedalIndicatorState({ ...base, liveEverUsed: true })).toEqual({
      visible: true,
      down: false,
    })
  })

  it('unions the piece and the player', () => {
    const holds = [{ start: 1, end: 2 }]
    expect(pedalIndicatorState({ ...base, pieceHolds: holds, time: 5, liveDown: true }).down).toBe(
      true,
    )
  })
})
