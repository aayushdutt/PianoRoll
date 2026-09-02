import { isBlackKey } from '../core/midi/types'

// Single source of truth for piano-key geometry — every place that *draws* a
// key (the baked static keyboard, the pressed-key overlay, the practice-mode
// hint halo) and every place that *hit-tests* one (`Viewport.pitchAtPoint`)
// derives its rectangle from here.
//
// These numbers used to be duplicated as literals across KeyboardRenderer and
// Viewport, so a tweak in one spot silently desynced hint halos from the baked
// key or made the touch target disagree with the pixels. Change them here and
// everything moves together.
//
// Coordinates are keyboard-local: y = 0 is the top edge of the keyboard band,
// so callers add their own yOffset (the roll height) when drawing into stage
// space.

// Black keys occupy the top 62% of the keyboard band. Also defines the
// "black zone" for hit-testing: a point above this line prefers the black key
// that visually sits on top of the white one.
export const BLACK_KEY_HEIGHT_RATIO = 0.62

// White keys are inset by 1px on each side so the dark background shows
// through as a hairline seam between neighbouring keys.
const WHITE_KEY_MARGIN = 1
const WHITE_KEY_TOP = 2
// Bottom inset matches the top inset plus the 1px shadow edge line.
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

// Rectangle (rounded) covering the drawn body of `pitch`. `pos` comes from
// `Viewport.getAllKeyPositions()`; `keyboardHeight` is the full keyboard band
// height in CSS pixels.
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
