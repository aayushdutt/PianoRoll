import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { MidiFile, MidiNote, MidiTrack } from '../core/midi/types'
import {
  fitPitchRange,
  overallProgress,
  type ProgressMode,
  pitchSignature,
  resolveExportBitrate,
  resolveExportDims,
  speedToPps,
  stageEtaSeconds,
  stageWindow,
  trimAudioBuffer,
  trimmedFrameCount,
} from './exportMath'

// --- helpers -----------------------------------------------------------------

function note(pitch: number): MidiNote {
  return { pitch, time: 0, duration: 1, velocity: 0.8 }
}

function track(pitches: number[]): MidiTrack {
  return {
    id: 't',
    name: 't',
    channel: 0,
    instrument: 0,
    isDrum: false,
    notes: pitches.map(note),
    color: 0,
    colorIndex: 0,
  }
}

function midiWith(...trackPitches: number[][]): MidiFile {
  return {
    name: 'm',
    duration: 10,
    bpm: 120,
    timeSignature: [4, 4],
    tracks: trackPitches.map(track),
  }
}

// --- fitPitchRange -----------------------------------------------------------

describe('fitPitchRange', () => {
  it('returns the full 88-key range when there are no notes (hi < lo sentinel)', () => {
    expect(fitPitchRange(midiWith())).toEqual({ min: 21, max: 108 })
    expect(fitPitchRange(midiWith([]))).toEqual({ min: 21, max: 108 })
  })

  it('pads a wide range by 12% of its span (rounded), clamped to 21..108', () => {
    // span = 84 — 36 = 48; pad = round(48 * 0.12) = round(5.76) = 6
    const r = fitPitchRange(midiWith([36, 84]))
    expect(r).toEqual({ min: 30, max: 90 })
  })

  it('uses the 3-semitone floor when 12% of the span is smaller', () => {
    // span = 64 — 60 = 4; round(0.48) = 0 -> floor at 3
    const r = fitPitchRange(midiWith([60, 64]))
    expect(r).toEqual({ min: 57, max: 67 })
  })

  it('pads a single note (zero span) by the 3-semitone floor', () => {
    const r = fitPitchRange(midiWith([60]))
    expect(r).toEqual({ min: 57, max: 63 })
  })

  it('clamps the padded min to 21 (A0) at the bottom of the keyboard', () => {
    // lo=21, hi=23 span=2 -> pad floor 3; 21-3 = 18 clamps to 21
    const r = fitPitchRange(midiWith([21, 23]))
    expect(r.min).toBe(21)
  })

  it('clamps the padded max to 108 (C8) at the top of the keyboard', () => {
    const r = fitPitchRange(midiWith([105, 108]))
    expect(r.max).toBe(108)
  })

  it('scans across all tracks for the global min/max', () => {
    // lo=40 (track2), hi=80 (track1); span=40 pad=round(4.8)=5
    const r = fitPitchRange(midiWith([60, 80], [40, 50]))
    expect(r).toEqual({ min: 35, max: 85 })
  })
})

// --- speedToPps --------------------------------------------------------------

describe('speedToPps', () => {
  it('maps each speed preset to its pixels-per-second value', () => {
    expect(speedToPps('compact')).toBe(300)
    expect(speedToPps('standard')).toBe(200)
    expect(speedToPps('drama')).toBe(120)
  })

  it('orders compact > standard > drama (faster scroll = more pps)', () => {
    expect(speedToPps('compact')).toBeGreaterThan(speedToPps('standard'))
    expect(speedToPps('standard')).toBeGreaterThan(speedToPps('drama'))
  })
})

// --- trimmedFrameCount (pure sample-count math) ------------------------------

describe('trimmedFrameCount', () => {
  it('returns null (no-op) when the requested duration meets/exceeds the source', () => {
    // source is exactly 10s at 1000 Hz = 10000 frames
    expect(trimmedFrameCount(10, 1000, 10_000)).toBeNull()
    // longer request than source -> still a no-op
    expect(trimmedFrameCount(11, 1000, 10_000)).toBeNull()
  })

  it('returns the ceil()-rounded frame count when trimming shorter', () => {
    // 5.0001s * 1000 = 5000.1 -> ceil 5001
    expect(trimmedFrameCount(5.0001, 1000, 10_000)).toBe(5001)
    expect(trimmedFrameCount(5, 1000, 10_000)).toBe(5000)
  })

  it('never produces a buffer shorter than the requested duration (ceil, not floor)', () => {
    // 44100 Hz, duration that lands between samples
    const frames = trimmedFrameCount(2.00001, 44_100, 1_000_000)
    // 2.00001 * 44100 = 88200.441 -> ceil 88201
    expect(frames).toBe(88_201)
  })

  it('floors at 1 frame for a zero or negative duration (never an empty buffer)', () => {
    expect(trimmedFrameCount(0, 44_100, 10_000)).toBe(1)
    expect(trimmedFrameCount(-5, 44_100, 10_000)).toBe(1)
  })

  // The bug context: OfflineAudioRenderer renders `midi.duration + 1.5s`
  // (TAIL_SECONDS). Trimming to midi.duration must drop exactly that tail.
  it('drops the 1.5s release tail when trimming a rendered buffer to midi.duration', () => {
    const sampleRate = 44_100
    const midiDuration = 10
    const renderedTail = 1.5
    const sourceLength = Math.ceil((midiDuration + renderedTail) * sampleRate)
    const frames = trimmedFrameCount(midiDuration, sampleRate, sourceLength)
    expect(frames).toBe(midiDuration * sampleRate) // 441000
    // The trimmed length is shorter than the source by ~the tail.
    const dropped = sourceLength - (frames as number)
    expect(dropped / sampleRate).toBeCloseTo(renderedTail, 5)
  })
})

// --- trimAudioBuffer (with a duck-typed AudioBuffer) -------------------------
//
// jsdom has no AudioBuffer. We install a minimal stub that records construction
// args and supports getChannelData/copyToChannel so we can assert the real
// trimming behavior (passthrough vs copy, channel count, copied samples).

interface StubInit {
  length: number
  numberOfChannels: number
  sampleRate: number
}

class StubAudioBuffer {
  length: number
  numberOfChannels: number
  sampleRate: number
  private channels: Float32Array[]

  constructor(init: StubInit) {
    this.length = init.length
    this.numberOfChannels = init.numberOfChannels
    this.sampleRate = init.sampleRate
    this.channels = Array.from(
      { length: init.numberOfChannels },
      () => new Float32Array(init.length),
    )
  }

  get duration(): number {
    return this.length / this.sampleRate
  }

  getChannelData(ch: number): Float32Array {
    const data = this.channels[ch]
    if (!data) throw new Error(`no channel ${ch}`)
    return data
  }

  copyToChannel(src: Float32Array, ch: number): void {
    this.channels[ch]?.set(src)
  }
}

// Builds a populated stub whose channel data is a ramp so we can verify the
// copied prefix matches the source.
function filledBuffer(length: number, channels: number, sampleRate: number): StubAudioBuffer {
  const buf = new StubAudioBuffer({ length, numberOfChannels: channels, sampleRate })
  for (let ch = 0; ch < channels; ch++) {
    const data = buf.getChannelData(ch)
    for (let i = 0; i < length; i++) data[i] = i + ch * 1000
  }
  return buf
}

describe('trimAudioBuffer', () => {
  const realAudioBuffer = (globalThis as { AudioBuffer?: unknown }).AudioBuffer

  beforeAll(() => {
    ;(globalThis as { AudioBuffer?: unknown }).AudioBuffer = StubAudioBuffer
  })
  afterAll(() => {
    ;(globalThis as { AudioBuffer?: unknown }).AudioBuffer = realAudioBuffer
  })

  it('returns the SAME instance (no copy) when no trimming is needed', () => {
    const audio = filledBuffer(10_000, 2, 1000) as unknown as AudioBuffer
    // duration 10s == source 10s -> targetFrames >= length -> passthrough
    expect(trimAudioBuffer(audio, 10)).toBe(audio)
  })

  it('returns a new, shorter buffer preserving channel count and sample rate', () => {
    const audio = filledBuffer(10_000, 2, 1000) as unknown as AudioBuffer
    const out = trimAudioBuffer(audio, 5) as unknown as StubAudioBuffer
    expect(out).not.toBe(audio)
    expect(out.length).toBe(5000)
    expect(out.numberOfChannels).toBe(2)
    expect(out.sampleRate).toBe(1000)
  })

  it('copies exactly the leading frames from every channel', () => {
    const audio = filledBuffer(10_000, 2, 1000)
    const out = trimAudioBuffer(audio as unknown as AudioBuffer, 5) as unknown as StubAudioBuffer
    expect(out.getChannelData(0)[0]).toBe(0)
    expect(out.getChannelData(0)[4999]).toBe(4999)
    expect(out.getChannelData(1)[0]).toBe(1000) // channel 1 offset
    expect(out.getChannelData(1)[4999]).toBe(5999)
  })

  it('drops the rendered 1.5s tail when trimming to midi.duration (the av path)', () => {
    const sampleRate = 1000
    const midiDuration = 10
    const source = filledBuffer((midiDuration + 1.5) * sampleRate, 2, sampleRate)
    const out = trimAudioBuffer(
      source as unknown as AudioBuffer,
      midiDuration,
    ) as unknown as StubAudioBuffer
    expect(out.length).toBe(midiDuration * sampleRate)
    expect(out.duration).toBeCloseTo(midiDuration, 5)
    // the tail (frames 10000..11499 of the source) is gone
    expect(out.length).toBeLessThan(source.length)
  })
})

// --- resolveExportDims -------------------------------------------------------

describe('resolveExportDims', () => {
  it('maps each landscape preset to its 16:9 dimensions', () => {
    expect(resolveExportDims('720p')).toEqual({ width: 1280, height: 720 })
    expect(resolveExportDims('1080p')).toEqual({ width: 1920, height: 1080 })
    expect(resolveExportDims('2k')).toEqual({ width: 2560, height: 1440 })
    expect(resolveExportDims('4k')).toEqual({ width: 3840, height: 2160 })
  })

  it('maps social presets to their aspect ratios', () => {
    expect(resolveExportDims('vertical')).toEqual({ width: 1080, height: 1920 })
    expect(resolveExportDims('square')).toEqual({ width: 1080, height: 1080 })
  })

  it('returns null for "match" so the caller keeps the current canvas size', () => {
    expect(resolveExportDims('match')).toBeNull()
  })
})

// --- resolveExportBitrate ----------------------------------------------------

describe('resolveExportBitrate', () => {
  it('scales bitrate up with resolution', () => {
    expect(resolveExportBitrate('720p')).toBe(5_000_000)
    expect(resolveExportBitrate('1080p')).toBe(8_000_000)
    expect(resolveExportBitrate('2k')).toBe(16_000_000)
    expect(resolveExportBitrate('4k')).toBe(35_000_000)
  })

  it('uses sensible bitrates for social formats and the match fallback', () => {
    expect(resolveExportBitrate('vertical')).toBe(8_000_000)
    expect(resolveExportBitrate('square')).toBe(5_000_000)
    expect(resolveExportBitrate('match')).toBe(8_000_000)
  })

  it('never returns a non-positive bitrate for any preset', () => {
    for (const p of ['720p', '1080p', '2k', '4k', 'vertical', 'square', 'match'] as const) {
      expect(resolveExportBitrate(p)).toBeGreaterThan(0)
    }
  })
})

// --- pitchSignature ----------------------------------------------------------

describe('pitchSignature', () => {
  it('returns an empty string for the empty set', () => {
    expect(pitchSignature(new Set())).toBe('')
  })

  it('joins a single pitch as its number', () => {
    expect(pitchSignature(new Set([60]))).toBe('60')
  })

  it('sorts numerically (not lexicographically) so insertion order does not matter', () => {
    expect(pitchSignature(new Set([62, 60, 64]))).toBe('60.62.64')
    // lexicographic sort would put 100 before 9; numeric must not.
    expect(pitchSignature(new Set([100, 9, 60]))).toBe('9.60.100')
  })

  it('is stable across different insertion orders of the same pitches', () => {
    const a = pitchSignature(new Set([67, 60, 64]))
    const b = pitchSignature(new Set([64, 67, 60]))
    expect(a).toBe(b)
  })
})

// --- staged progress ---------------------------------------------------------

describe('stageWindow / overallProgress', () => {
  it('covers 0→1 contiguously for every progress mode', () => {
    const sequences: Record<ProgressMode, string[]> = {
      av: ['Rendering audio', 'Encoding audio', 'Encoding', 'Finalizing', 'Saving'],
      'video-only': ['Encoding', 'Finalizing', 'Saving'],
      'audio-only': ['Rendering audio', 'Saving'],
    }
    for (const [mode, stages] of Object.entries(sequences) as Array<
      [ProgressMode, Array<Parameters<typeof stageWindow>[1]>]
    >) {
      let cursor = 0
      for (const stage of stages) {
        const w = stageWindow(mode, stage)
        expect(w.from).toBeCloseTo(cursor, 10)
        expect(w.to).toBeGreaterThan(w.from)
        cursor = w.to
      }
      expect(cursor).toBe(1)
    }
  })

  it('numbers steps monotonically and agrees on totalSteps within a mode', () => {
    const w1 = stageWindow('av', 'Rendering audio')
    const w2 = stageWindow('av', 'Encoding')
    const w3 = stageWindow('av', 'Saving')
    expect(w1.totalSteps).toBe(3)
    expect([w1.step, w2.step, w3.step]).toEqual([1, 2, 3])
  })

  it('maps per-stage pct into the stage window on the overall bar', () => {
    // av encode runs 0.25→0.93: halfway through it = 0.59 overall.
    expect(overallProgress('av', 'Encoding', 0.5)).toBeCloseTo(0.59, 10)
    expect(overallProgress('av', 'Encoding', 0)).toBeCloseTo(0.25, 10)
    expect(overallProgress('av', 'Encoding', 1)).toBeCloseTo(0.93, 10)
  })

  it('clamps out-of-range pct instead of escaping the stage window', () => {
    expect(overallProgress('av', 'Encoding', -0.5)).toBeCloseTo(0.25, 10)
    expect(overallProgress('av', 'Encoding', 1.7)).toBeCloseTo(0.93, 10)
  })

  it('falls back to a full-range single step for stages a mode never emits', () => {
    // video-only never renders audio; the fallback keeps the bar sane.
    expect(stageWindow('video-only', 'Rendering audio')).toEqual({
      step: 1,
      totalSteps: 1,
      from: 0,
      to: 1,
    })
  })

  it("'Done' pins the bar at 100% in every mode", () => {
    for (const mode of ['av', 'video-only', 'audio-only'] as const) {
      expect(overallProgress(mode, 'Done', 1)).toBe(1)
    }
  })
})

describe('stageEtaSeconds', () => {
  it('returns null while the rate is still junk (too early)', () => {
    expect(stageEtaSeconds(10_000, 0.02)).toBeNull() // < 4% done
    expect(stageEtaSeconds(1000, 0.5)).toBeNull() // < 3 s elapsed
  })

  it('extrapolates the remaining time from the stage-local rate', () => {
    // 10 s for 25% → 30 s left.
    expect(stageEtaSeconds(10_000, 0.25)).toBeCloseTo(30, 6)
    // 60 s for 50% → 60 s left.
    expect(stageEtaSeconds(60_000, 0.5)).toBeCloseTo(60, 6)
  })

  it('approaches zero as the stage completes', () => {
    expect(stageEtaSeconds(120_000, 0.999)).toBeLessThan(1)
  })
})
