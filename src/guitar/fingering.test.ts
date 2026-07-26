import { describe, expect, it } from 'vitest'
import {
  assignGuitarCluster,
  candidatePositions,
  GUITAR_CLUSTER_WINDOW_MS,
  type GuitarVoice,
  LiveGuitarFingering,
  precomputeGuitarFingerings,
  STANDARD_GUITAR_DP_STATE_LIMIT,
  STANDARD_GUITAR_PROFILE,
} from '.'

const voice = (pitch: number, time = 0, channel?: number): GuitarVoice => ({
  pitch,
  time,
  ...(channel === undefined ? {} : { channel }),
})

const positions = (assignment: ReturnType<typeof assignGuitarCluster>) =>
  assignment.voices.map((note) => note.position && [note.position.string, note.position.fret])

describe('STANDARD_GUITAR_PROFILE', () => {
  it('describes six-string standard tuning and frets 0 through 24', () => {
    expect(STANDARD_GUITAR_PROFILE.strings.map((string) => string.openPitch)).toEqual([
      40, 45, 50, 55, 59, 64,
    ])
    expect(STANDARD_GUITAR_PROFILE.strings.every((string) => string.maxFret === 24)).toBe(true)
  })

  it('includes open strings and the 24th fret but excludes notes outside the range', () => {
    expect(candidatePositions(40)).toEqual([{ string: 0, fret: 0 }])
    expect(candidatePositions(64)).toContainEqual({ string: 0, fret: 24 })
    expect(candidatePositions(88)).toEqual([{ string: 5, fret: 24 }])
    expect(candidatePositions(39)).toEqual([])
    expect(candidatePositions(89)).toEqual([])
    expect(candidatePositions(40.5)).toEqual([])
  })
})

describe('assignGuitarCluster', () => {
  it('assigns a chord without reusing strings', () => {
    const result = assignGuitarCluster([
      voice(40),
      voice(45),
      voice(50),
      voice(55),
      voice(59),
      voice(64),
    ])
    expect(positions(result)).toEqual([
      [0, 0],
      [1, 0],
      [2, 0],
      [3, 0],
      [4, 0],
      [5, 0],
    ])
    expect(new Set(result.voices.map((note) => note.position?.string)).size).toBe(6)
  })

  it('supports duplicate pitches on distinct strings', () => {
    const result = assignGuitarCluster([voice(64), voice(64)])
    expect(result.voices.every((note) => note.supported)).toBe(true)
    expect(result.voices[0]!.position?.string).not.toBe(result.voices[1]!.position?.string)
  })

  it('maximizes assigned voices when a cluster has more than six voices', () => {
    const result = assignGuitarCluster([40, 45, 50, 55, 59, 64, 67].map((pitch) => voice(pitch)))
    expect(result.voices.filter((note) => note.supported)).toHaveLength(6)
    expect(result.voices.filter((note) => !note.supported)).toHaveLength(1)
  })

  it('bounds dense duplicate search by guitar state rather than voice permutations', () => {
    const denseVoices = Array.from({ length: 20 }, (_, index) => ({
      ...voice(64),
      voiceId: `voice-${index}`,
      sourceId: 'stress-fixture',
    }))
    const first = assignGuitarCluster(denseVoices)
    const second = assignGuitarCluster(denseVoices)
    const assigned = first.voices.filter((note) => note.supported)

    expect(STANDARD_GUITAR_DP_STATE_LIMIT).toBe(19_264)
    expect(assigned).toHaveLength(6)
    expect(new Set(assigned.map((note) => note.position?.string))).toHaveLength(6)
    expect(first).toEqual(second)
    expect(first.voices[0]).toMatchObject({ voiceId: 'voice-0', sourceId: 'stress-fixture' })
  })

  it('returns an explicit unsupported result for impossible notes', () => {
    const result = assignGuitarCluster([voice(20), voice(100)])
    expect(result.voices).toEqual([
      { pitch: 20, time: 0, position: null, supported: false },
      { pitch: 100, time: 0, position: null, supported: false },
    ])
  })

  it('prefers a compact non-open shape before total fret cost', () => {
    const result = assignGuitarCluster([voice(59), voice(61), voice(64)])
    const frets = result.voices.flatMap((note) =>
      note.position && note.position.fret > 0 ? [note.position.fret] : [],
    )
    expect(Math.max(...frets) - Math.min(...frets)).toBeLessThanOrEqual(4)
  })

  it('uses channel affinity only as a soft tie-break and never as a fixed mapping', () => {
    const noAffinity = assignGuitarCluster([voice(64, 0, 9)])
    const affinity = assignGuitarCluster([voice(64, 0, 9)], {
      previousByVoice: new Map(),
      affinityByChannel: new Map([[9, 4]]),
    })
    expect(noAffinity.voices[0]!.position).toEqual({ string: 5, fret: 0 })
    expect(affinity.voices[0]!.position).toEqual({ string: 4, fret: 5 })

    const chord = assignGuitarCluster([voice(64, 0, 9), voice(64, 0, 9)], {
      previousByVoice: new Map(),
      affinityByChannel: new Map([[9, 4]]),
    })
    expect(chord.voices.every((note) => note.supported)).toBe(true)
    expect(new Set(chord.voices.map((note) => note.position?.string)).size).toBe(2)
  })

  it('uses prior movement before affinity and total fret', () => {
    const result = assignGuitarCluster([voice(64, 0, 1)], {
      previousByVoice: new Map([[0, { string: 1, fret: 19 }]]),
      affinityByChannel: new Map([[1, 5]]),
    })
    expect(result.voices[0]!.position).toEqual({ string: 1, fret: 19 })
  })

  it('resolves otherwise equal choices by stable low-string ordering', () => {
    const result = assignGuitarCluster(
      [voice(45)],
      { previousByVoice: new Map(), affinityByChannel: new Map() },
      {
        strings: [
          { index: 0, openPitch: 40, maxFret: 24 },
          { index: 1, openPitch: 40, maxFret: 24 },
        ],
      },
    )
    expect(result.voices[0]!.position).toEqual({ string: 0, fret: 5 })
  })
})

describe('chronological and live assignment', () => {
  it('sorts input, groups the inclusive 40 ms boundary, and avoids transitive clustering', () => {
    const result = precomputeGuitarFingerings([
      voice(52, 81),
      voice(45, 40),
      voice(40, 0),
      voice(50, GUITAR_CLUSTER_WINDOW_MS + 1),
    ])
    expect(
      result.map((cluster) => [cluster.time, cluster.voices.map((note) => note.time)]),
    ).toEqual([
      [0, [0, 40]],
      [41, [41, 81]],
    ])
  })

  it('is deterministic across repeated precomputation for seek and export', () => {
    const notes = [voice(64, 100, 2), voice(59, 0, 1), voice(64, 0, 2), voice(67, 100, 1)]
    expect(precomputeGuitarFingerings(notes)).toEqual(precomputeGuitarFingerings(notes))
  })

  it('maintains rolling state and returns a completed cluster when the window advances', () => {
    const live = new LiveGuitarFingering()
    expect(live.push(voice(64, 0, 3))).toBeNull()
    expect(live.push(voice(64, 40, 4))).toBeNull()
    const first = live.push(voice(67, 41, 3))
    expect(first?.voices).toHaveLength(2)
    expect(live.flush()?.voices).toHaveLength(1)
  })

  it('reset drops pending notes and clears learned movement and affinity', () => {
    const live = new LiveGuitarFingering()
    live.push(voice(64, 0, 7))
    live.flush()
    live.push(voice(67, 100, 7))
    live.reset()
    expect(live.flush()).toBeNull()
    live.push(voice(64, 200, 7))
    expect(live.flush()?.voices[0]?.position).toEqual({ string: 5, fret: 0 })
  })
})
