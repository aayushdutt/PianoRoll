import { describe, expect, it } from 'vitest'
import type { MidiFile, MidiNote, MidiTrack } from '../core/midi/types'
import { nominalTempoMap } from '../core/midi/types'
import {
  activityBuckets,
  type ExportUiState,
  estimateSeconds,
  previewDims,
  resolutionFor,
  throughputFrom,
  toExportSettings,
} from './exportSettings'

function note(time: number, duration: number, pitch = 60, velocity = 1): MidiNote {
  return { pitch, time, duration, velocity }
}

function track(notes: MidiNote[], colorIndex = 0): MidiTrack {
  return {
    id: `t${colorIndex}`,
    name: 'Track',
    channel: 0,
    instrument: 0,
    isDrum: false,
    notes,
    colorIndex,
  }
}

function midi(duration: number, tracks: MidiTrack[]): MidiFile {
  return {
    name: 'piece',
    duration,
    bpm: 120,
    timeSignature: [4, 4],
    ...nominalTempoMap(120, [4, 4]),
    tracks,
  }
}

const base: ExportUiState = {
  dest: 'video',
  format: 'landscape',
  quality: '1080p',
  fps: 60,
  includeAudio: true,
  focus: 'fit',
  speed: 'drama',
  audioFormat: 'mp3',
}

describe('toExportSettings', () => {
  it('maps destination + audio toggle onto the output kinds App understands', () => {
    expect(toExportSettings(base).output).toBe('av')
    expect(toExportSettings({ ...base, includeAudio: false }).output).toBe('video-only')
    expect(toExportSettings({ ...base, dest: 'audio' }).output).toBe('audio-only')
    expect(toExportSettings({ ...base, dest: 'midi' }).output).toBe('midi')
  })

  it('social formats ignore the landscape quality', () => {
    expect(resolutionFor('landscape', '4k')).toBe('4k')
    expect(resolutionFor('vertical', '4k')).toBe('vertical')
    expect(resolutionFor('square', '720p')).toBe('square')
    expect(toExportSettings({ ...base, format: 'vertical', quality: '4k' }).resolution).toBe(
      'vertical',
    )
  })

  it('passes framing, fall, fps and audio format through', () => {
    const s = toExportSettings({ ...base, focus: 'all', speed: 'compact', audioFormat: 'wav' })
    expect(s).toMatchObject({ fps: 60, focus: 'all', speed: 'compact', audioFormat: 'wav' })
  })
})

describe('previewDims', () => {
  it('resolves presets and falls back to the window for "match"', () => {
    const win = { width: 1440, height: 900 }
    expect(previewDims({ format: 'landscape', quality: '720p' }, win)).toEqual({
      width: 1280,
      height: 720,
    })
    expect(previewDims({ format: 'vertical', quality: '4k' }, win)).toEqual({
      width: 1080,
      height: 1920,
    })
    expect(previewDims({ format: 'landscape', quality: 'match' }, win)).toEqual(win)
  })
})

describe('estimates', () => {
  it('derives throughput from an export and predicts another preset with it', () => {
    // 1800 frames of 1080p in 30 s → 124.4 Mpx/s.
    const t = throughputFrom({
      framesEncoded: 1800,
      width: 1920,
      height: 1080,
      videoEncodeMs: 30_000,
    })
    expect(t).toBeCloseTo(124_416_000, 0)
    // Same piece at 4K (4× pixels) → ~120 s.
    expect(estimateSeconds(t, { width: 3840, height: 2160 }, 60, 30)).toBeCloseTo(120, 6)
  })

  it('refuses to guess without a measurement', () => {
    expect(throughputFrom({ framesEncoded: 0, width: 1, height: 1, videoEncodeMs: 0 })).toBeNull()
    expect(estimateSeconds(null, { width: 1920, height: 1080 }, 30, 60)).toBeNull()
  })
})

describe('activityBuckets', () => {
  it('buckets note energy over the piece and normalises to the loudest bucket', () => {
    // 4 s piece, 4 buckets. Bucket 0 holds a full-velocity whole-second note,
    // bucket 2 a half-velocity one; buckets 1 and 3 are silent.
    const b = activityBuckets(midi(4, [track([note(0, 1, 60, 1), note(2, 1, 64, 0.5)])]), 4)
    expect(b).toEqual([1, 0, 0.5, 0])
  })

  it('splits a held note across every bucket it overlaps', () => {
    const b = activityBuckets(midi(4, [track([note(0, 4, 60, 1)])]), 4)
    expect(b).toEqual([1, 1, 1, 1])
  })

  it('sums across tracks and weights by velocity', () => {
    const b = activityBuckets(
      midi(2, [track([note(0, 1, 60, 1)]), track([note(0, 1, 67, 1)], 1)]),
      2,
    )
    // Two simultaneous notes in bucket 0, nothing in bucket 1.
    expect(b).toEqual([1, 0])
  })

  it('still registers zero-length notes instead of leaving a hole', () => {
    const b = activityBuckets(midi(2, [track([note(0, 0, 60, 1), note(1, 1, 60, 1)])]), 2)
    expect(b[0]).toBeGreaterThan(0)
    expect(b[1]).toBe(1)
  })

  it('returns a flat line for no piece, no duration and no notes', () => {
    expect(activityBuckets(null, 4)).toEqual([0, 0, 0, 0])
    expect(activityBuckets(midi(0, [track([note(0, 1)])]), 4)).toEqual([0, 0, 0, 0])
    expect(activityBuckets(midi(4, [track([])]), 4)).toEqual([0, 0, 0, 0])
  })
})
