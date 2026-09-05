// Pure headroom / clipping analysis over rendered audio — the measurement
// half of the `headroom` bench suite (docs/AUDIO_GLITCH_HARNESS_2026-09-05.md).
//
// Why offline output is a valid clipping probe: an OfflineAudioContext writes
// unclamped floats, so |x| > 1 here is exactly the overshoot the ONLINE path
// hard-clips at the hardware boundary. No Web Audio in this file so it unit
// tests under jsdom.

export interface HeadroomMetrics {
  // 20·log10(max |x|) across all channels. > 0 means the live path clips.
  peakDb: number
  // Share (0–100) of frames where any channel reaches |x| ≥ 1.
  clipPct: number
  // Longest consecutive run of clipped frames, ms. Distinguishes a click
  // (a few ms) from sustained crunch (hundreds of ms).
  clipRunMaxMs: number
  // First clipped frame, seconds — -1 when nothing clips. Lets the caller map
  // the moment back onto "how many notes were sounding".
  firstClipS: number
  // RMS over [from, to) in dB, all channels pooled. -Infinity → -120 floor.
  rmsDb: number
  // peakDb − rmsDb. Very high crest with modest RMS says "limit the peaks";
  // low crest with high RMS says "turn the whole thing down".
  crestDb: number
}

export interface AnalyseOptions {
  // RMS window in seconds; defaults to the whole buffer. Peak/clip metrics
  // always cover the whole buffer.
  from?: number
  to?: number
}

const CLIP = 1.0
const DB_FLOOR = -120

function db(linear: number): number {
  return linear > 0 ? Math.max(DB_FLOOR, 20 * Math.log10(linear)) : DB_FLOOR
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000
}

export function analyseChannels(
  channels: readonly Float32Array[],
  sampleRate: number,
  opts: AnalyseOptions = {},
): HeadroomMetrics {
  const frames = channels[0]?.length ?? 0
  const rmsFrom = Math.max(0, Math.floor((opts.from ?? 0) * sampleRate))
  const rmsTo = Math.min(frames, Math.ceil((opts.to ?? frames / sampleRate) * sampleRate))

  let peak = 0
  let clipped = 0
  let run = 0
  let runMax = 0
  let firstClip = -1
  let sumSq = 0
  let rmsCount = 0

  for (let i = 0; i < frames; i++) {
    let frameMax = 0
    for (const ch of channels) {
      const v = ch[i] ?? 0
      const a = Math.abs(v)
      if (a > frameMax) frameMax = a
      if (i >= rmsFrom && i < rmsTo) {
        sumSq += v * v
        rmsCount++
      }
    }
    if (frameMax > peak) peak = frameMax
    if (frameMax >= CLIP) {
      clipped++
      run++
      if (run > runMax) runMax = run
      if (firstClip < 0) firstClip = i
    } else {
      run = 0
    }
  }

  const peakDb = db(peak)
  const rmsDb = db(rmsCount ? Math.sqrt(sumSq / rmsCount) : 0)
  return {
    peakDb: round(peakDb),
    clipPct: round(frames ? (clipped / frames) * 100 : 0),
    clipRunMaxMs: round((runMax / sampleRate) * 1000),
    firstClipS: firstClip < 0 ? -1 : round(firstClip / sampleRate),
    rmsDb: round(rmsDb),
    crestDb: round(peakDb - rmsDb),
  }
}

export function analyseBuffer(buffer: AudioBuffer, opts?: AnalyseOptions): HeadroomMetrics {
  const channels: Float32Array[] = []
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c))
  return analyseChannels(channels, buffer.sampleRate, opts)
}
