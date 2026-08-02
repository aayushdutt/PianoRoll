import type { MidiFile, MidiNote } from '../core/midi/types'
import type { EvaluationTraceRecord, TimingMode } from './ledProtocol'

export interface EvalEvent {
  pitch: number
  time: number
  duration: number
  velocity: number
  eventId?: number
}

export interface MatchedEvent {
  reference: EvalEvent
  actual: EvalEvent
  error: number
}

export interface TimingPoint {
  time: number
  lagMs: number
  tempoRatio: number
}

export interface Hiccup {
  time: number
  magnitudeMs: number
  kind: 'ioi' | 'delay-step' | 'drop'
}

export interface EvaluationMetrics {
  referenceCount: number
  detectedCount: number
  emittedCount: number
  matchedDetected: number
  matchedEmitted: number
  precision: number
  recall: number
  medianAbsErrorMs: number
  p90AbsErrorMs: number
  medianAbsOffsetErrorMs: number
  p90AbsOffsetErrorMs: number
  medianAbsDurationErrorMs: number
  p90AbsDurationErrorMs: number
  prematureReleases: number
  stuckNotes: number
  ioiMedianMs: number
  ioiP90Ms: number
  cumulativeDriftMs: number
  localTempoMin: number
  localTempoMax: number
  suppressedOnsets: number
  lateEvents: number
  droppedAudioMs: number
  hiccups50: number
  hiccups100: number
  timing: TimingPoint[]
  hiccups: Hiccup[]
}

export interface EvaluationRun {
  schemaVersion: 1 | 2
  id: string
  createdAt: string
  referenceName: string
  sourceAudioName?: string
  referenceMidiBase64: string
  timingMode: TimingMode
  trace: EvaluationTraceRecord[]
  metrics: EvaluationMetrics
}

export function flattenMidi(midi: MidiFile): EvalEvent[] {
  return midi.tracks
    .flatMap((track) =>
      track.notes.map((note) => ({
        pitch: note.pitch,
        time: note.time,
        duration: note.duration,
        velocity: note.velocity,
      })),
    )
    .sort((a, b) => a.time - b.time || a.pitch - b.pitch)
}

function finiteNumber(
  record: EvaluationTraceRecord,
  key: keyof EvaluationTraceRecord,
): number | null {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function traceEvents(
  trace: readonly EvaluationTraceRecord[],
  stage: 'detected' | 'emitted',
): EvalEvent[] {
  const offs = trace
    .filter((record) => record.stage === 'off')
    .map((record) => ({
      eventId: finiteNumber(record, 'eventId'),
      pitch: finiteNumber(record, 'pitch'),
      audioTime: finiteNumber(record, 'audioTime'),
      serverTime: finiteNumber(record, 'serverTime'),
    }))
    .filter((item) => item.pitch !== null)

  return trace
    .filter((record) => record.stage === stage)
    .map((record) => {
      const pitch = finiteNumber(record, 'pitch')
      const time =
        stage === 'detected'
          ? finiteNumber(record, 'audioTime')
          : finiteNumber(record, 'serverTime')
      if (pitch === null || time === null) return null
      const eventId = finiteNumber(record, 'eventId')
      const off = offs.find((candidate) => {
        const candidateTime = stage === 'detected' ? candidate.audioTime : candidate.serverTime
        if (candidateTime === null || candidateTime <= time) return false
        if (eventId !== null && candidate.eventId !== null) return candidate.eventId === eventId
        return candidate.pitch === pitch
      })
      const offTime =
        off && (stage === 'detected' ? off.audioTime : off.serverTime)
      return {
        pitch,
        time,
        duration: Math.max(0.05, Math.min(30, (offTime ?? time + 0.25) - time)),
        velocity: Math.max(0, Math.min(1, (finiteNumber(record, 'velocity') ?? 100) / 127)),
        ...(eventId !== null ? { eventId } : {}),
      }
    })
    .filter((event): event is EvalEvent => event !== null)
    .sort((a, b) => a.time - b.time || a.pitch - b.pitch)
}

function percentile(values: readonly number[], pct: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * pct)))
  return sorted[index] ?? 0
}

export function estimateConstantOffset(
  reference: readonly EvalEvent[],
  actual: readonly EvalEvent[],
): number {
  const bins = new Map<number, number>()
  const referenceByPitch = new Map<number, EvalEvent[]>()
  for (const event of reference) {
    const group = referenceByPitch.get(event.pitch) ?? []
    if (group.length < 80) group.push(event)
    referenceByPitch.set(event.pitch, group)
  }
  for (const event of actual.slice(0, 500)) {
    for (const candidate of referenceByPitch.get(event.pitch) ?? []) {
      const offset = event.time - candidate.time
      const bin = Math.round(offset / 0.02)
      bins.set(bin, (bins.get(bin) ?? 0) + 1)
    }
  }
  let bestBin = 0
  let bestCount = -1
  for (const [bin, count] of bins) {
    if (count > bestCount) {
      bestBin = bin
      bestCount = count
    }
  }
  const coarse = bestBin * 0.02
  const deltas: number[] = []
  for (const event of actual) {
    const candidates = referenceByPitch.get(event.pitch) ?? []
    let nearest: EvalEvent | undefined
    let distance = Number.POSITIVE_INFINITY
    for (const candidate of candidates) {
      const next = Math.abs(event.time - coarse - candidate.time)
      if (next < distance) {
        distance = next
        nearest = candidate
      }
    }
    if (nearest && distance <= 0.1) deltas.push(event.time - nearest.time)
  }
  return deltas.length ? percentile(deltas, 0.5) : coarse
}

export function matchEvents(
  reference: readonly EvalEvent[],
  actual: readonly EvalEvent[],
  tolerance = 0.05,
): {
  offset: number
  matches: MatchedEvent[]
  unmatchedReference: EvalEvent[]
  unmatchedActual: EvalEvent[]
} {
  const offset = estimateConstantOffset(reference, actual)
  const used = new Set<number>()
  const matches: MatchedEvent[] = []
  const unmatchedActual: EvalEvent[] = []
  for (const event of actual) {
    let bestIndex = -1
    let bestDistance = Number.POSITIVE_INFINITY
    for (let index = 0; index < reference.length; index++) {
      if (used.has(index)) continue
      const candidate = reference[index]
      if (!candidate || candidate.pitch !== event.pitch) continue
      const distance = Math.abs(event.time - offset - candidate.time)
      if (distance < bestDistance) {
        bestDistance = distance
        bestIndex = index
      }
    }
    if (bestIndex >= 0 && bestDistance <= tolerance) {
      used.add(bestIndex)
      const candidate = reference[bestIndex]
      if (candidate) {
        const aligned = { ...event, time: event.time - offset }
        matches.push({
          reference: candidate,
          actual: aligned,
          error: aligned.time - candidate.time,
        })
      }
    } else {
      unmatchedActual.push(event)
    }
  }
  return {
    offset,
    matches: matches.sort((a, b) => a.reference.time - b.reference.time),
    unmatchedReference: reference.filter((_, index) => !used.has(index)),
    unmatchedActual,
  }
}

function clusterMatches(matches: readonly MatchedEvent[], threshold = 0.03): MatchedEvent[] {
  if (!matches.length) return []
  const clusters: MatchedEvent[][] = []
  for (const match of matches) {
    const cluster = clusters.at(-1)
    if (!cluster || match.reference.time - (cluster.at(-1)?.reference.time ?? 0) > threshold) {
      clusters.push([match])
    } else {
      cluster.push(match)
    }
  }
  return clusters.map((cluster) => {
    const middle = Math.floor(cluster.length / 2)
    const byRef = [...cluster].sort((a, b) => a.reference.time - b.reference.time)
    const byActual = [...cluster].sort((a, b) => a.actual.time - b.actual.time)
    const reference = byRef[middle]?.reference ?? cluster[0]!.reference
    const actual = byActual[middle]?.actual ?? cluster[0]!.actual
    return { reference, actual, error: actual.time - reference.time }
  })
}

export function analyzeEvaluation(
  midi: MidiFile,
  trace: readonly EvaluationTraceRecord[],
): EvaluationMetrics {
  const reference = flattenMidi(midi)
  const detected = traceEvents(trace, 'detected')
  const emitted = traceEvents(trace, 'emitted')
  const detectedMatch = matchEvents(reference, detected, 0.05)
  const emittedMatch = matchEvents(reference, emitted, 0.05)
  // Timing diagnosis intentionally uses a wider association gate than note
  // accuracy. A 100–200 ms hiccup must remain visible as a timing defect rather
  // than being silently reclassified as one missing plus one extra note.
  const timingMatch = matchEvents(reference, emitted, 0.25)
  const clusters = clusterMatches(timingMatch.matches)
  const errors = emittedMatch.matches.map((match) => Math.abs(match.error) * 1000)
  const offsetErrors = emittedMatch.matches.map(
    (match) =>
      (match.actual.time +
        match.actual.duration -
        (match.reference.time + match.reference.duration)) *
      1000,
  )
  const durationErrors = emittedMatch.matches.map(
    (match) => (match.actual.duration - match.reference.duration) * 1000,
  )
  const ioiErrors: number[] = []
  const hiccups: Hiccup[] = []
  for (let index = 1; index < clusters.length; index++) {
    const previous = clusters[index - 1]
    const current = clusters[index]
    if (!previous || !current) continue
    const error =
      current.actual.time -
      previous.actual.time -
      (current.reference.time - previous.reference.time)
    const magnitudeMs = Math.abs(error) * 1000
    ioiErrors.push(magnitudeMs)
    if (magnitudeMs > 50) {
      hiccups.push({ time: current.reference.time, magnitudeMs, kind: 'ioi' })
    }
  }

  const timing: TimingPoint[] = []
  for (let start = 0; start <= midi.duration; start += 1) {
    const window = clusters.filter(
      (match) => match.reference.time >= start - 1.5 && match.reference.time < start + 1.5,
    )
    if (window.length < 2) continue
    const first = window[0]
    const last = window.at(-1)
    if (!first || !last) continue
    const refSpan = last.reference.time - first.reference.time
    const actualSpan = last.actual.time - first.actual.time
    if (refSpan <= 0.1) continue
    const sortedLag = window.map((match) => match.error * 1000).sort((a, b) => a - b)
    timing.push({
      time: start,
      lagMs: percentile(sortedLag, 0.5),
      tempoRatio: actualSpan / refSpan,
    })
  }

  for (let index = 1; index < timing.length; index++) {
    const previous = timing[index - 1]
    const current = timing[index]
    if (!previous || !current) continue
    const magnitudeMs = Math.abs(current.lagMs - previous.lagMs)
    if (magnitudeMs > 50) hiccups.push({ time: current.time, magnitudeMs, kind: 'delay-step' })
  }
  for (const record of trace) {
    if (record.stage === 'dropped_audio' && typeof record.durationMs === 'number') {
      hiccups.push({
        time: record.startAudioTime ?? record.serverTime,
        magnitudeMs: record.durationMs,
        kind: 'drop',
      })
    }
  }

  const firstCluster = clusters[0]
  const lastCluster = clusters.at(-1)
  const cumulativeDriftMs =
    firstCluster && lastCluster ? (lastCluster.error - firstCluster.error) * 1000 : 0
  const tempoRatios = timing.map((point) => point.tempoRatio)
  return {
    referenceCount: reference.length,
    detectedCount: detected.length,
    emittedCount: emitted.length,
    matchedDetected: detectedMatch.matches.length,
    matchedEmitted: emittedMatch.matches.length,
    precision: emitted.length ? emittedMatch.matches.length / emitted.length : 0,
    recall: reference.length ? emittedMatch.matches.length / reference.length : 0,
    medianAbsErrorMs: percentile(errors, 0.5),
    p90AbsErrorMs: percentile(errors, 0.9),
    medianAbsOffsetErrorMs: percentile(offsetErrors.map(Math.abs), 0.5),
    p90AbsOffsetErrorMs: percentile(offsetErrors.map(Math.abs), 0.9),
    medianAbsDurationErrorMs: percentile(durationErrors.map(Math.abs), 0.5),
    p90AbsDurationErrorMs: percentile(durationErrors.map(Math.abs), 0.9),
    prematureReleases: offsetErrors.filter((error) => error < -50).length,
    stuckNotes: trace.filter(
      (record) => record.stage === 'off' && record.reason === 'max_duration',
    ).length,
    ioiMedianMs: percentile(ioiErrors, 0.5),
    ioiP90Ms: percentile(ioiErrors, 0.9),
    cumulativeDriftMs,
    localTempoMin: tempoRatios.length ? Math.min(...tempoRatios) : 1,
    localTempoMax: tempoRatios.length ? Math.max(...tempoRatios) : 1,
    suppressedOnsets: trace.filter((record) => record.stage === 'suppressed').length,
    lateEvents: trace.filter((record) => record.stage === 'emitted' && (record.latenessMs ?? 0) > 1)
      .length,
    droppedAudioMs: trace
      .filter((record) => record.stage === 'dropped_audio')
      .reduce((sum, record) => sum + (record.durationMs ?? 0), 0),
    hiccups50: hiccups.filter((hiccup) => hiccup.magnitudeMs > 50).length,
    hiccups100: hiccups.filter((hiccup) => hiccup.magnitudeMs > 100).length,
    timing,
    hiccups: hiccups.sort((a, b) => a.time - b.time),
  }
}

export function midiFromEvents(name: string, events: readonly EvalEvent[]): MidiFile {
  const notes: MidiNote[] = events.map((event) => ({
    pitch: event.pitch,
    time: Math.max(0, event.time),
    duration: event.duration,
    velocity: event.velocity,
  }))
  return {
    name,
    duration: Math.max(0.1, ...notes.map((note) => note.time + note.duration)),
    bpm: 120,
    timeSignature: [4, 4],
    tracks: [
      {
        id: 'evaluation',
        name,
        channel: 0,
        instrument: 0,
        isDrum: false,
        notes,
        color: 0x38bdf8,
        colorIndex: 0,
      },
    ],
  }
}

export function parseEvaluationRun(value: unknown): EvaluationRun | null {
  if (!value || typeof value !== 'object') return null
  const run = value as Partial<EvaluationRun>
  if (
    (run.schemaVersion !== 1 && run.schemaVersion !== 2) ||
    typeof run.id !== 'string' ||
    typeof run.createdAt !== 'string' ||
    typeof run.referenceName !== 'string' ||
    typeof run.referenceMidiBase64 !== 'string' ||
    (run.timingMode !== 'adaptive' && run.timingMode !== 'fixed') ||
    !Array.isArray(run.trace) ||
    !run.metrics
  ) {
    return null
  }
  const parsed = run as EvaluationRun
  if (parsed.schemaVersion === 1) {
    const metrics = parsed.metrics
    return {
      ...parsed,
      schemaVersion: 2,
      metrics: {
        ...metrics,
        medianAbsOffsetErrorMs: metrics.medianAbsOffsetErrorMs ?? 0,
        p90AbsOffsetErrorMs: metrics.p90AbsOffsetErrorMs ?? 0,
        medianAbsDurationErrorMs: metrics.medianAbsDurationErrorMs ?? 0,
        p90AbsDurationErrorMs: metrics.p90AbsDurationErrorMs ?? 0,
        prematureReleases: metrics.prematureReleases ?? 0,
        stuckNotes: metrics.stuckNotes ?? 0,
      },
    }
  }
  return parsed
}
