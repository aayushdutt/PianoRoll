import { describe, expect, it } from 'vitest'
import {
  centeredPanForFret,
  createGuitarLayout,
  fretboardStringY,
  guitarPositionLabel,
  highwayLaneX,
  MIN_FRET_TARGET_PX,
  positionAtPoint,
  positionRect,
} from './GuitarGeometry'
import { candidatePositions } from './profile'

describe('guitar geometry', () => {
  it('keeps highway identity low E to high E while tablature renders high E on top', () => {
    const layout = createGuitarLayout(390, 844)
    expect(highwayLaneX(0, layout)).toBeLessThan(highwayLaneX(5, layout))
    expect(fretboardStringY(5, layout)).toBeLessThan(fretboardStringY(0, layout))
  })

  it('keeps all fret targets at least 44px and maps the full 0-24 range', () => {
    const layout = createGuitarLayout(320, 568)
    expect(layout.fretWidth).toBeGreaterThanOrEqual(MIN_FRET_TARGET_PX)
    expect(layout.stringHeight).toBeGreaterThanOrEqual(MIN_FRET_TARGET_PX)
    for (const position of [
      { string: 5, fret: 0 },
      { string: 0, fret: 24 },
      { string: 2, fret: 12 },
    ]) {
      const pan = position.fret === 24 ? layout.maxPan : 0
      const rect = positionRect(position, layout, pan)
      expect(
        positionAtPoint(rect.x + rect.width / 2, rect.y + rect.height / 2, layout, pan),
      ).toEqual(position)
    }
  })

  it('centers active frets within pan bounds', () => {
    const layout = createGuitarLayout(390, 700)
    expect(centeredPanForFret(0, layout)).toBe(0)
    expect(centeredPanForFret(12, layout)).toBeGreaterThan(0)
    expect(centeredPanForFret(24, layout)).toBe(layout.maxPan)
  })

  it('provides note, string, and fret in accessible labels', () => {
    expect(guitarPositionLabel({ string: 5, fret: 0 })).toBe('E4, string 1, fret 0')
    expect(guitarPositionLabel({ string: 0, fret: 3 })).toBe('G2, string 6, fret 3')
  })

  it('keeps out-of-range pitches off the playable fretboard', () => {
    expect(candidatePositions(20)).toEqual([])
    expect(candidatePositions(89)).toEqual([])
  })
})
