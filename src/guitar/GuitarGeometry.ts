import { pitchToNoteName } from '../core/midi/types'
import { STANDARD_GUITAR_PROFILE } from './profile'
import type { GuitarPosition, GuitarProfile } from './types'

export const GUITAR_STRING_COUNT = 6
export const GUITAR_MAX_FRET = 24
export const MIN_FRET_TARGET_PX = 44
export const FRETBOARD_LABEL_WIDTH = 56
export const FRET_MARKERS = new Set([3, 5, 7, 9, 12, 15, 17, 19, 21, 24])

export interface GuitarLayout {
  width: number
  height: number
  highwayHeight: number
  fretboardTop: number
  fretboardHeight: number
  stringHeight: number
  fretWidth: number
  contentWidth: number
  maxPan: number
}

export function createGuitarLayout(width: number, height: number): GuitarLayout {
  const safeWidth = Math.max(1, width)
  const safeHeight = Math.max(1, height)
  const highwayHeight = Math.max(132, Math.round(safeHeight * 0.48))
  const fretboardTop = Math.min(highwayHeight, Math.max(0, safeHeight - GUITAR_STRING_COUNT * 44))
  const fretboardHeight = safeHeight - fretboardTop
  const stringHeight = Math.max(MIN_FRET_TARGET_PX, fretboardHeight / GUITAR_STRING_COUNT)
  const fretWidth = Math.max(MIN_FRET_TARGET_PX, (safeWidth - FRETBOARD_LABEL_WIDTH) / 12)
  const contentWidth = FRETBOARD_LABEL_WIDTH + (GUITAR_MAX_FRET + 1) * fretWidth
  return {
    width: safeWidth,
    height: safeHeight,
    highwayHeight: fretboardTop,
    fretboardTop,
    fretboardHeight,
    stringHeight,
    fretWidth,
    contentWidth,
    maxPan: Math.max(0, contentWidth - safeWidth),
  }
}

/** Highway keeps domain identity: low E (0) at the left, high E (5) at the right. */
export function highwayLaneX(string: number, layout: GuitarLayout): number {
  return ((string + 0.5) / GUITAR_STRING_COUNT) * layout.width
}

/** Tablature orientation reverses the vertical display: high E top, low E bottom. */
export function fretboardStringY(string: number, layout: GuitarLayout): number {
  return layout.fretboardTop + (GUITAR_STRING_COUNT - 1 - string + 0.5) * layout.stringHeight
}

export function positionRect(position: GuitarPosition, layout: GuitarLayout, panX = 0) {
  return {
    x: FRETBOARD_LABEL_WIDTH + position.fret * layout.fretWidth - panX,
    y: fretboardStringY(position.string, layout) - layout.stringHeight / 2,
    width: layout.fretWidth,
    height: layout.stringHeight,
  }
}

export function positionAtPoint(
  x: number,
  y: number,
  layout: GuitarLayout,
  panX = 0,
): GuitarPosition | null {
  if (y < layout.fretboardTop || y >= layout.height) return null
  const contentX = x + panX - FRETBOARD_LABEL_WIDTH
  if (contentX < 0) return null
  const fret = Math.floor(contentX / layout.fretWidth)
  const displayRow = Math.floor((y - layout.fretboardTop) / layout.stringHeight)
  const string = GUITAR_STRING_COUNT - 1 - displayRow
  if (fret < 0 || fret > GUITAR_MAX_FRET || string < 0 || string >= GUITAR_STRING_COUNT) return null
  return { string, fret }
}

export function pitchAtPosition(
  position: GuitarPosition,
  profile: GuitarProfile = STANDARD_GUITAR_PROFILE,
): number {
  return profile.strings[position.string]!.openPitch + position.fret
}

export function guitarPositionLabel(
  position: GuitarPosition,
  profile: GuitarProfile = STANDARD_GUITAR_PROFILE,
): string {
  const pitch = pitchAtPosition(position, profile)
  const displayString = GUITAR_STRING_COUNT - position.string
  return `${pitchToNoteName(pitch)}, string ${displayString}, fret ${position.fret}`
}

export function centeredPanForFret(fret: number, layout: GuitarLayout): number {
  const center = FRETBOARD_LABEL_WIDTH + (fret + 0.5) * layout.fretWidth
  return Math.max(0, Math.min(layout.maxPan, center - layout.width / 2))
}
