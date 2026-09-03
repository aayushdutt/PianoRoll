import { describe, expect, it } from 'vitest'
import { computeBarlineTicks, detectAnacrusisTicks, type Onset } from './measures'

const PPQ = 480

// Helper: a bass note (low pitch) plus optional upper chord tones at a tick.
function chord(tick: number, pitches: number[]): Onset[] {
  return pitches.map((pitch) => ({ tick, pitch }))
}

describe('detectAnacrusisTicks', () => {
  it('finds a one-beat pickup from the bass downbeats', () => {
    // 2/4: bar = 960, beat = 480. The bass root lands on the real downbeats
    // (480, 1440, 2400, 3360); single melody upbeats fall on 0, 960, 1920, 2880.
    const onsets: Onset[] = []
    for (const down of [480, 1440, 2400, 3360]) onsets.push(...chord(down, [43, 59, 62]))
    for (const up of [0, 960, 1920, 2880]) onsets.push({ tick: up, pitch: 72 })
    expect(detectAnacrusisTicks(PPQ, 2, 4, onsets)).toBe(480)
  })

  it('is not fooled by off-beat chords over an on-beat bass (Satie-style vamp)', () => {
    // Bass on beat 1 (phase 0); dense 4-note chords on the off-beats. A naive
    // onset count would pick the chord phase — the bass-only vote must not.
    const onsets: Onset[] = []
    for (const beat1 of [0, 960, 1920, 2880]) onsets.push({ tick: beat1, pitch: 41 })
    for (const off of [480, 1440, 2400, 3360]) onsets.push(...chord(off, [56, 60, 65, 72]))
    expect(detectAnacrusisTicks(PPQ, 2, 4, onsets)).toBe(0)
  })

  it('does not guess a pickup from too little material', () => {
    expect(detectAnacrusisTicks(PPQ, 2, 4, [{ tick: 480, pitch: 60 }])).toBe(0)
  })

  it('skips compound meters (x/8) where the dotted beat makes phase unreliable', () => {
    // Same bass-on-offbeat shape as the positive case, but in 6/8 it must not
    // shift — compound-meter pickup estimation is intentionally disabled.
    const onsets: Onset[] = []
    for (const down of [288, 1440, 2592]) onsets.push(...chord(down, [43, 59, 62]))
    for (const up of [0, 1152, 2304]) onsets.push({ tick: up, pitch: 72 })
    expect(detectAnacrusisTicks(PPQ, 6, 8, onsets)).toBe(0)
  })
})

describe('computeBarlineTicks', () => {
  it('defaults to 4/4 barlines when no time signature is present', () => {
    const bars = computeBarlineTicks({
      ppq: PPQ,
      timeSignatures: [],
      endTick: 4 * 1920,
      onsets: [],
    })
    expect(bars.slice(0, 5)).toEqual([0, 1920, 3840, 5760, 7680])
  })

  it('offsets the grid by a detected anacrusis', () => {
    const onsets: Onset[] = []
    for (const down of [480, 1440, 2400, 3360]) onsets.push(...chord(down, [43, 59, 62]))
    for (const up of [0, 960, 1920, 2880]) onsets.push({ tick: up, pitch: 72 })
    const bars = computeBarlineTicks({
      ppq: PPQ,
      timeSignatures: [{ ticks: 0, numerator: 2, denominator: 4 }],
      endTick: 3840,
      onsets,
    })
    // Short pickup bar [0,480), then full 2/4 bars every 960 ticks.
    expect(bars.slice(0, 5)).toEqual([0, 480, 1440, 2400, 3360])
  })

  it('places barlines across a meter change', () => {
    const bars = computeBarlineTicks({
      ppq: PPQ,
      timeSignatures: [
        { ticks: 0, numerator: 4, denominator: 4 },
        { ticks: 3840, numerator: 3, denominator: 4 },
      ],
      endTick: 6720,
      onsets: [],
    })
    expect(bars).toEqual([0, 1920, 3840, 5280, 6720])
  })
})
