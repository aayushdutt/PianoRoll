import { candidatePositions, STANDARD_GUITAR_PROFILE } from './profile'
import type {
  AssignedGuitarVoice,
  GuitarClusterAssignment,
  GuitarPosition,
  GuitarProfile,
  GuitarVoice,
} from './types'

export const GUITAR_CLUSTER_WINDOW_MS = 40

export interface FingeringState {
  readonly previousByVoice: ReadonlyMap<number, GuitarPosition>
  readonly affinityByChannel: ReadonlyMap<number, number>
}

interface SearchState {
  positions: readonly (GuitarPosition | null)[]
  usedStrings: number
  minFret: number
  maxFret: number
}

// For standard tuning a layer is bounded by 64 string masks multiplied by
// the empty range plus every possible non-open [min, max] pair within frets 1..24.
export const STANDARD_GUITAR_DP_STATE_LIMIT = 64 * (1 + (24 * 25) / 2)

const EMPTY_STATE: FingeringState = {
  previousByVoice: new Map(),
  affinityByChannel: new Map(),
}

function compareScore(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < left.length; index++) {
    const difference = left[index]! - right[index]!
    if (difference !== 0) return difference
  }
  return 0
}

function scorePositions(
  voices: readonly GuitarVoice[],
  positions: readonly (GuitarPosition | null)[],
  state: FingeringState,
): readonly number[] {
  const assigned = positions.filter((position): position is GuitarPosition => position !== null)
  const fretted = assigned.filter((position) => position.fret > 0).map((position) => position.fret)
  const span = fretted.length < 2 ? 0 : Math.max(...fretted) - Math.min(...fretted)
  let movement = 0
  let affinityMatches = 0

  for (let index = 0; index < positions.length; index++) {
    const position = positions[index]
    if (!position) continue
    const previous = state.previousByVoice.get(index)
    if (previous) movement += Math.abs(position.fret - previous.fret)
    const channel = voices[index]?.channel
    if (channel !== undefined && state.affinityByChannel.get(channel) === position.string) {
      affinityMatches++
    }
  }

  return [
    -assigned.length,
    span <= 4 ? 0 : 1,
    span,
    movement,
    -affinityMatches,
    assigned.reduce((total, position) => total + position.fret, 0),
    ...positions.map((position) => position?.string ?? Number.MAX_SAFE_INTEGER),
  ]
}

export function assignGuitarCluster(
  voices: readonly GuitarVoice[],
  state: FingeringState = EMPTY_STATE,
  profile: GuitarProfile = STANDARD_GUITAR_PROFILE,
): GuitarClusterAssignment {
  let states = new Map<string, SearchState>([
    ['0:0:0', { positions: [], usedStrings: 0, minFret: 0, maxFret: 0 }],
  ])

  const retainBetter = (next: Map<string, SearchState>, candidate: SearchState): void => {
    const key = `${candidate.usedStrings}:${candidate.minFret}:${candidate.maxFret}`
    const incumbent = next.get(key)
    if (
      !incumbent ||
      compareScore(
        scorePositions(voices, candidate.positions, state),
        scorePositions(voices, incumbent.positions, state),
      ) < 0
    ) {
      next.set(key, candidate)
    }
  }

  for (let voiceIndex = 0; voiceIndex < voices.length; voiceIndex++) {
    const next = new Map<string, SearchState>()
    for (const partial of states.values()) {
      retainBetter(next, { ...partial, positions: [...partial.positions, null] })
      for (const position of candidatePositions(voices[voiceIndex]!.pitch, profile)) {
        const stringBit = 1 << position.string
        if ((partial.usedStrings & stringBit) !== 0) continue
        const hasFrettedPosition = partial.maxFret > 0
        retainBetter(next, {
          positions: [...partial.positions, position],
          usedStrings: partial.usedStrings | stringBit,
          minFret:
            position.fret === 0
              ? partial.minFret
              : hasFrettedPosition
                ? Math.min(partial.minFret, position.fret)
                : position.fret,
          maxFret: Math.max(partial.maxFret, position.fret),
        })
      }
    }
    states = next
  }

  let best: SearchState | undefined
  for (const candidate of states.values()) {
    if (
      !best ||
      compareScore(
        scorePositions(voices, candidate.positions, state),
        scorePositions(voices, best.positions, state),
      ) < 0
    ) {
      best = candidate
    }
  }
  const selected = best?.positions ?? []
  const assignedVoices: AssignedGuitarVoice[] = voices.map((voice, index) => ({
    ...voice,
    position: selected[index] ?? null,
    supported: selected[index] !== null,
  }))
  return { time: voices[0]?.time ?? 0, voices: assignedVoices }
}

function nextState(previous: FingeringState, assignment: GuitarClusterAssignment): FingeringState {
  const previousByVoice = new Map<number, GuitarPosition>()
  const affinityByChannel = new Map(previous.affinityByChannel)
  assignment.voices.forEach((voice, index) => {
    if (!voice.position) return
    previousByVoice.set(index, voice.position)
    if (voice.channel !== undefined) affinityByChannel.set(voice.channel, voice.position.string)
  })
  return { previousByVoice, affinityByChannel }
}

export function precomputeGuitarFingerings(
  voices: readonly GuitarVoice[],
  profile: GuitarProfile = STANDARD_GUITAR_PROFILE,
  clusterWindowMs = GUITAR_CLUSTER_WINDOW_MS,
): GuitarClusterAssignment[] {
  const ordered = voices
    .map((voice, order) => ({ voice, order }))
    .sort((left, right) =>
      left.voice.time === right.voice.time
        ? left.order - right.order
        : left.voice.time - right.voice.time,
    )
  const results: GuitarClusterAssignment[] = []
  let state = EMPTY_STATE
  let cluster: GuitarVoice[] = []

  const flush = (): void => {
    if (cluster.length === 0) return
    const assignment = assignGuitarCluster(cluster, state, profile)
    results.push(assignment)
    state = nextState(state, assignment)
    cluster = []
  }

  for (const entry of ordered) {
    if (cluster.length > 0 && entry.voice.time - cluster[0]!.time > clusterWindowMs) flush()
    cluster.push(entry.voice)
  }
  flush()
  return results
}

export class LiveGuitarFingering {
  private state: FingeringState = EMPTY_STATE
  private pending: GuitarVoice[] = []

  constructor(
    private readonly profile: GuitarProfile = STANDARD_GUITAR_PROFILE,
    private readonly clusterWindowMs = GUITAR_CLUSTER_WINDOW_MS,
  ) {}

  push(voice: GuitarVoice): GuitarClusterAssignment | null {
    if (this.pending.length > 0 && voice.time - this.pending[0]!.time > this.clusterWindowMs) {
      const completed = this.flush()
      this.pending.push(voice)
      return completed
    }
    this.pending.push(voice)
    return null
  }

  flush(): GuitarClusterAssignment | null {
    if (this.pending.length === 0) return null
    const assignment = assignGuitarCluster(this.pending, this.state, this.profile)
    this.state = nextState(this.state, assignment)
    this.pending = []
    return assignment
  }

  reset(): void {
    this.state = EMPTY_STATE
    this.pending = []
  }
}
