import { describe, expect, it } from 'vitest'
import type { MidiFile } from '../core/midi/types'
import {
  analyzeEvaluation,
  type EvaluationRun,
  estimateConstantOffset,
  flattenMidi,
  matchEvents,
  parseEvaluationRun,
  traceEvents,
} from './evaluation'
import type { EvaluationTraceRecord } from './ledProtocol'

function fixture(count = 40): MidiFile {
  const notes = Array.from({ length: count }, (_, index) => ({
    pitch: 48 + (index % 24),
    time: index * 0.5,
    duration: 0.2,
    velocity: 0.8,
  }))
  return {
    name: 'synthetic',
    duration: count * 0.5,
    bpm: 120,
    timeSignature: [4, 4],
    tracks: [
      {
        id: 'track',
        name: 'Synthetic',
        channel: 0,
        instrument: 0,
        isDrum: false,
        notes,
        color: 0,
        colorIndex: 0,
      },
    ],
  }
}

function traceFor(
  midi: MidiFile,
  transform: (time: number, index: number) => number = (time) => time,
): EvaluationTraceRecord[] {
  return flattenMidi(midi).flatMap((note, index) => {
    const emitted = transform(note.time, index) + 2
    return [
      {
        stage: 'detected',
        serverTime: note.time + 0.5,
        audioTime: note.time + 12,
        eventId: index + 1,
        pitch: note.pitch,
        velocity: 102,
      },
      {
        stage: 'emitted',
        serverTime: emitted,
        audioTime: note.time + 12,
        eventId: index + 1,
        pitch: note.pitch,
        velocity: 102,
        latenessMs: 0,
      },
      {
        stage: 'off',
        serverTime: emitted + note.duration,
        audioTime: note.time + 12 + note.duration,
        pitch: note.pitch,
      },
    ]
  })
}

describe('Pi reconstruction evaluation', () => {
  it('reports release timing and stuck-note diagnostics', () => {
    const midi = fixture(2)
    midi.tracks[0]!.notes[0]!.duration = 1
    const trace = [
      { stage: 'emitted', serverTime: 0, audioTime: 0, pitch: 48, eventId: 1 },
      {
        stage: 'off',
        serverTime: 0.4,
        audioTime: 0.4,
        pitch: 48,
        eventId: 1,
        reason: 'frame',
      },
      { stage: 'emitted', serverTime: 0.5, audioTime: 0.5, pitch: 49, eventId: 2 },
      {
        stage: 'off',
        serverTime: 0.7,
        audioTime: 0.7,
        pitch: 49,
        eventId: 2,
        reason: 'max_duration',
      },
    ]
    const metrics = analyzeEvaluation(midi, trace)
    expect(metrics.prematureReleases).toBe(1)
    expect(metrics.stuckNotes).toBe(1)
    expect(metrics.p90AbsDurationErrorMs).toBeGreaterThan(0)
  })

  it('recovers a constant offset without treating it as latency error', () => {
    const midi = fixture()
    const reference = flattenMidi(midi)
    const actual = reference.map((event) => ({ ...event, time: event.time + 12.345 }))
    expect(estimateConstantOffset(reference, actual)).toBeCloseTo(12.345, 3)
    const result = matchEvents(reference, actual)
    expect(result.matches).toHaveLength(reference.length)
    expect(Math.max(...result.matches.map((match) => Math.abs(match.error)))).toBeLessThan(1e-6)
  })

  it('detects gradual tempo drift', () => {
    const midi = fixture(80)
    const metrics = analyzeEvaluation(
      midi,
      traceFor(midi, (time) => time * 1.01),
    )
    // Strict 50 ms note accuracy intentionally degrades as the accumulated
    // drift exceeds the gate; the wider timing association must still recover
    // the tempo curve below.
    expect(metrics.precision).toBeGreaterThan(0.15)
    expect(metrics.cumulativeDriftMs).toBeGreaterThan(300)
    expect(metrics.localTempoMax).toBeGreaterThan(1.005)
  })

  it('keeps a 120 ms step as a hiccup rather than aligning it away', () => {
    const midi = fixture()
    const metrics = analyzeEvaluation(
      midi,
      traceFor(midi, (time, index) => time + (index >= 20 ? 0.12 : 0)),
    )
    expect(metrics.hiccups100).toBeGreaterThanOrEqual(1)
  })

  it('attributes suppression and dropped audio', () => {
    const midi = fixture()
    const trace = traceFor(midi)
    trace.push(
      { stage: 'suppressed', serverTime: 3, pitch: 60, reason: 'pitch_already_on' },
      { stage: 'dropped_audio', serverTime: 5, startAudioTime: 10, durationMs: 500 },
    )
    const metrics = analyzeEvaluation(midi, trace)
    expect(metrics.suppressedOnsets).toBe(1)
    expect(metrics.droppedAudioMs).toBe(500)
    expect(metrics.hiccups.some((hiccup) => hiccup.kind === 'drop')).toBe(true)
  })

  it('rejects unsupported bundle versions', () => {
    const run = {
      schemaVersion: 1,
      id: 'id',
      createdAt: new Date(0).toISOString(),
      referenceName: 'test',
      referenceMidiBase64: 'AA==',
      timingMode: 'fixed',
      trace: [],
      metrics: analyzeEvaluation(fixture(1), []),
    } satisfies EvaluationRun
    expect(parseEvaluationRun(run)).toMatchObject({ ...run, schemaVersion: 2 })
    expect(parseEvaluationRun({ ...run, schemaVersion: 3 })).toBeNull()
  })

  it('pairs repeated same-pitch releases by event ID and timing domain', () => {
    const trace: EvaluationTraceRecord[] = [
      { stage: 'detected', serverTime: 1, audioTime: 10, eventId: 1, pitch: 60 },
      { stage: 'detected', serverTime: 2, audioTime: 10.4, eventId: 2, pitch: 60 },
      {
        stage: 'off',
        serverTime: 2.3,
        audioTime: 10.7,
        eventId: 2,
        pitch: 60,
      },
      {
        stage: 'off',
        serverTime: 3,
        audioTime: 10.35,
        eventId: 1,
        pitch: 60,
      },
    ]
    const notes = traceEvents(trace, 'detected')
    expect(notes).toHaveLength(2)
    expect(notes[0]?.duration).toBeCloseTo(0.35)
    expect(notes[1]?.duration).toBeCloseTo(0.3)
  })
})
