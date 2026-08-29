import { describe, expect, it } from 'vitest'
import { formatSpeed, SPEED_PRESETS, stepSpeedPreset } from './ControlsView'

describe('stepSpeedPreset', () => {
  it('walks forward and backward through the presets', () => {
    expect(stepSpeedPreset(1, 1)).toBe(1.25)
    expect(stepSpeedPreset(1, -1)).toBe(0.75)
  })

  it('wraps at both ends', () => {
    const first = SPEED_PRESETS[0]!
    const last = SPEED_PRESETS[SPEED_PRESETS.length - 1]!
    expect(stepSpeedPreset(last, 1)).toBe(first)
    expect(stepSpeedPreset(first, -1)).toBe(last)
  })

  it('resolves an off-preset value to its nearest neighbour first', () => {
    // A speed persisted by the old continuous slider must not strand the chip:
    // 1.05 is nearest 1, so forward lands on 1.25 rather than doing nothing.
    expect(stepSpeedPreset(1.05, 1)).toBe(1.25)
    expect(stepSpeedPreset(1.05, -1)).toBe(0.75)
    expect(stepSpeedPreset(0.6, 1)).toBe(0.75)
  })

  it('formats every preset without a trailing zero', () => {
    expect(SPEED_PRESETS.map(formatSpeed)).toEqual([
      '0.25x',
      '0.5x',
      '0.75x',
      '1x',
      '1.25x',
      '1.5x',
      '2x',
    ])
  })
})
