import { isBlackKey } from '../core/midi/types'

// Single source of truth for piano-key geometry, shared by everything that
// draws a key (KeyboardRenderer) and hit-tests one (Viewport.pitchAtPoint).
// Coordinates are keyboard-local: y = 0 is the top of the keyboard band.

// Black keys occupy the top 62% of the band; also the hit-test "black zone".
export const BLACK_KEY_HEIGHT_RATIO = 0.62

// White keys are inset 1px per side so the background shows as a seam.
const WHITE_KEY_MARGIN = 1
const WHITE_KEY_TOP = 2
const WHITE_KEY_VERTICAL_INSET = 4
const WHITE_KEY_RADIUS = 3
const BLACK_KEY_RADIUS = 2

export interface KeyRect {
  x: number
  y: number
  w: number
  h: number
  radius: number
}

// Rounded rect of the drawn key body. `pos` from `Viewport.getAllKeyPositions()`.
export function keyRect(
  pitch: number,
  pos: { x: number; width: number },
  keyboardHeight: number,
): KeyRect {
  if (isBlackKey(pitch)) {
    return {
      x: pos.x,
      y: 0,
      w: pos.width,
      h: keyboardHeight * BLACK_KEY_HEIGHT_RATIO,
      radius: BLACK_KEY_RADIUS,
    }
  }
  return {
    x: pos.x + WHITE_KEY_MARGIN,
    y: WHITE_KEY_TOP,
    w: pos.width - WHITE_KEY_MARGIN * 2,
    h: keyboardHeight - WHITE_KEY_VERTICAL_INSET,
    radius: WHITE_KEY_RADIUS,
  }
}
