import { describe, expect, it } from 'vitest'
import { isBlackKey } from '../core/midi/types'
import { BLACK_KEY_HEIGHT_RATIO, keyRect } from './keyGeometry'

describe('BLACK_KEY_HEIGHT_RATIO', () => {
  it('is the 0.62 the keyboard bake and hit-test both encode', () => {
    expect(BLACK_KEY_HEIGHT_RATIO).toBe(0.62)
  })
})

describe('keyRect', () => {
  const KB_HEIGHT = 120

  it('insets a white key by 1px horizontally and 2px/4px vertically', () => {
    // C4 = 60 is a white key.
    expect(isBlackKey(60)).toBe(false)
    expect(keyRect(60, { x: 100, width: 20 }, KB_HEIGHT)).toEqual({
      x: 101,
      y: 2,
      w: 18,
      h: 116,
      radius: 3,
    })
  })

  it('gives a black key the full position width and 62% of the keyboard height', () => {
    // C#4 = 61 is a black key.
    expect(isBlackKey(61)).toBe(true)
    expect(keyRect(61, { x: 111.6, width: 11.6 }, KB_HEIGHT)).toEqual({
      x: 111.6,
      y: 0,
      w: 11.6,
      h: 120 * 0.62,
      radius: 2,
    })
  })

  it('scales the black key height with the keyboard height', () => {
    expect(keyRect(61, { x: 0, width: 10 }, 200).h).toBeCloseTo(124)
    expect(keyRect(61, { x: 0, width: 10 }, 80).h).toBeCloseTo(49.6)
  })

  it('scales the white key height with the keyboard height (constant 4px inset)', () => {
    expect(keyRect(60, { x: 0, width: 10 }, 200).h).toBe(196)
    expect(keyRect(60, { x: 0, width: 10 }, 80).h).toBe(76)
  })

  const pitches = [21, 22, 24, 36, 59, 60, 61, 66, 70, 71, 72, 108]
  it.each(pitches)('pitch %i picks the shape matching isBlackKey', (pitch) => {
    const rect = keyRect(pitch, { x: 40, width: 12 }, KB_HEIGHT)
    if (isBlackKey(pitch)) {
      expect(rect).toEqual({ x: 40, y: 0, w: 12, h: KB_HEIGHT * BLACK_KEY_HEIGHT_RATIO, radius: 2 })
    } else {
      expect(rect).toEqual({ x: 41, y: 2, w: 10, h: KB_HEIGHT - 4, radius: 3 })
    }
  })

  it('never lets a black key reach the bottom of the keyboard band', () => {
    for (const pitch of pitches) {
      if (!isBlackKey(pitch)) continue
      expect(keyRect(pitch, { x: 0, width: 10 }, KB_HEIGHT).h).toBeLessThan(KB_HEIGHT)
    }
  })
})
