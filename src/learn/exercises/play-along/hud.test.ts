import { describe, expect, it } from 'vitest'
import { cap, playAlongAccuracy } from './hud'

// NOTE ON SCOPE: this file deliberately does NOT try to assert that the scrubber
// keeps its width when the score grows. jsdom has no layout engine —
// getBoundingClientRect() returns zeros and stylesheets are never laid out — so
// such an assertion would pass without measuring anything. That invariant needs
// the Playwright tier (Tier 3, docs/TESTING_STRATEGY_2026-06-21.md).
//
// What IS testable here is the half of the invariant that is pure logic: the
// stats column is a fixed width, so the numbers inside it must be bounded or
// they will eventually outgrow the box and start pushing the scrubber again.

describe('cap', () => {
  it('passes through anything that fits the two-digit box', () => {
    expect(cap(0)).toBe('0')
    expect(cap(9)).toBe('9')
    expect(cap(99)).toBe('99')
  })

  it('clamps past 99 so the fixed stats column cannot be outgrown', () => {
    expect(cap(100)).toBe('99+')
    expect(cap(1234)).toBe('99+')
  })

  it('never returns more than three characters', () => {
    // The width budget is what matters, not the specific value: three glyphs is
    // what .pa-hud__body's fixed meta column is sized against.
    for (const n of [0, 7, 42, 99, 100, 999, 100000]) {
      expect(cap(n).length).toBeLessThanOrEqual(3)
    }
  })
})

describe('playAlongAccuracy', () => {
  const engine = (perfect: number, good: number, errors: number) =>
    ({ state: { perfect, good, errors } }) as Parameters<typeof playAlongAccuracy>[0]

  it('is 100 before anything is attempted', () => {
    // A fresh session should not read as 0% — nothing has gone wrong yet.
    expect(playAlongAccuracy(engine(0, 0, 0))).toBe(100)
  })

  it('counts perfect and good alike against errors', () => {
    expect(playAlongAccuracy(engine(3, 1, 0))).toBe(100)
    expect(playAlongAccuracy(engine(3, 1, 4))).toBe(50)
    expect(playAlongAccuracy(engine(0, 0, 5))).toBe(0)
  })

  it('rounds to a whole percent, so the readout is at most three glyphs', () => {
    expect(playAlongAccuracy(engine(2, 0, 1))).toBe(67)
  })
})
