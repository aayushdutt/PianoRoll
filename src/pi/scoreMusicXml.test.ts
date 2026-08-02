import { describe, expect, it } from 'vitest'
import { evaluationEventsToMusicXml } from './scoreMusicXml'

describe('evaluation score preparation', () => {
  it('creates a two-staff MusicXML score with quantized chords', () => {
    const result = evaluationEventsToMusicXml(
      'A & B',
      [
        { pitch: 60, time: 0, duration: 0.4, velocity: 0.8 },
        { pitch: 64, time: 0.01, duration: 0.4, velocity: 0.8 },
        { pitch: 48, time: 0.5, duration: 0.4, velocity: 0.8 },
      ],
      { bpm: 120, timeSignature: [4, 4], duration: 2 },
    )
    expect(result.xml).toContain('<work-title>A &amp; B</work-title>')
    expect(result.xml).toContain('<staves>2</staves>')
    expect(result.xml).toContain('<chord/>')
    expect(result.xml).toContain('<staff>2</staff>')
    expect(result.quantizationSeconds).toBeCloseTo(0.125)
  })

  it('creates additional measures for longer material', () => {
    const result = evaluationEventsToMusicXml(
      'Long',
      [{ pitch: 72, time: 4.2, duration: 0.2, velocity: 1 }],
      { bpm: 120, timeSignature: [4, 4], duration: 5 },
    )
    expect(result.xml.match(/<measure /g)).toHaveLength(3)
  })

  it('uses predicted durations, voices for overlaps, and ties across measures', () => {
    const result = evaluationEventsToMusicXml(
      'Durations',
      [
        { pitch: 60, time: 0, duration: 2.5, velocity: 1 },
        { pitch: 64, time: 0.5, duration: 0.25, velocity: 1 },
      ],
      { bpm: 120, timeSignature: [4, 4], duration: 3 },
    )
    expect(result.xml).toContain('<voice>2</voice>')
    expect(result.xml).toContain('<tie type="start"/>')
    expect(result.xml).toContain('<tie type="stop"/>')
    expect(result.xml).toContain('<tied type="start"/>')
    expect(result.xml).toContain('<tied type="stop"/>')
  })
})
