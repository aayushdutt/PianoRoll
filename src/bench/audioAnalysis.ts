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
  // Share (0–100) of frames above the soft-clip knee (0.8 linear). On a raw
  // render this is exactly how much of the signal the ceiling would alter —
  // the "saturation exposure" of a setting. 0 = bit-identical output.
  aboveKneePct: number
}

const SOFT_CLIP_KNEE = 0.8

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
  let aboveKnee = 0
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
    if (frameMax > SOFT_CLIP_KNEE) aboveKnee++
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
    aboveKneePct: round(frames ? (aboveKnee / frames) * 100 : 0),
  }
}

export function analyseBuffer(buffer: AudioBuffer, opts?: AnalyseOptions): HeadroomMetrics {
  const channels: Float32Array[] = []
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c))
  return analyseChannels(channels, buffer.sampleRate, opts)
}

// ── Loudness (ITU-R BS.1770-4, K-weighted) ────────────────────────────────
// Peak and RMS don't track what the ear calls "loud"; K-weighting does, to
// within a dB or two, and it's the standard every broadcaster balances to.
// Two filters: a +4 dB high shelf (head diffraction) and a 38 Hz high-pass
// (RLB). Coefficients from the standard's analogue prototypes via the audio
// EQ cookbook so any sample rate works, not just 48 kHz.
//
//   integratedLufs   whole-file loudness with the standard's absolute gate
//                    (-70 LUFS) and relative gate (-10 LU). Sustained material.
//   maxMomentaryLufs loudest 400 ms window. What a percussive patch "feels"
//                    like — a marimba hit is judged by its strike, not by the
//                    silence after it.

export interface Loudness {
  integratedLufs: number
  maxMomentaryLufs: number
}

interface Biquad {
  b0: number
  b1: number
  b2: number
  a1: number
  a2: number
}

function highShelf(sampleRate: number, f0: number, gainDb: number, q: number): Biquad {
  const A = 10 ** (gainDb / 40)
  const w0 = (2 * Math.PI * f0) / sampleRate
  const cosw = Math.cos(w0)
  const alpha = Math.sin(w0) / (2 * q)
  const s = 2 * Math.sqrt(A) * alpha
  const a0 = A + 1 - (A - 1) * cosw + s
  return {
    b0: (A * (A + 1 + (A - 1) * cosw + s)) / a0,
    b1: (-2 * A * (A - 1 + (A + 1) * cosw)) / a0,
    b2: (A * (A + 1 + (A - 1) * cosw - s)) / a0,
    a1: (2 * (A - 1 - (A + 1) * cosw)) / a0,
    a2: (A + 1 - (A - 1) * cosw - s) / a0,
  }
}

function highPass(sampleRate: number, f0: number, q: number): Biquad {
  const w0 = (2 * Math.PI * f0) / sampleRate
  const cosw = Math.cos(w0)
  const alpha = Math.sin(w0) / (2 * q)
  const a0 = 1 + alpha
  return {
    b0: (1 + cosw) / 2 / a0,
    b1: -(1 + cosw) / a0,
    b2: (1 + cosw) / 2 / a0,
    a1: (-2 * cosw) / a0,
    a2: (1 - alpha) / a0,
  }
}

function runBiquad(x: Float32Array, c: Biquad): Float32Array {
  const y = new Float32Array(x.length)
  let x1 = 0
  let x2 = 0
  let y1 = 0
  let y2 = 0
  for (let i = 0; i < x.length; i++) {
    const xi = x[i] ?? 0
    const yi = c.b0 * xi + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2
    x2 = x1
    x1 = xi
    y2 = y1
    y1 = yi
    y[i] = yi
  }
  return y
}

const LUFS_OFFSET = -0.691
const ABSOLUTE_GATE_LUFS = -70
const RELATIVE_GATE_LU = -10
const BLOCK_S = 0.4
const BLOCK_HOP_S = 0.1

function lufs(meanSquare: number): number {
  return meanSquare > 0 ? LUFS_OFFSET + 10 * Math.log10(meanSquare) : DB_FLOOR
}

export function measureLoudness(channels: readonly Float32Array[], sampleRate: number): Loudness {
  // BS.1770-4 prototype parameters, valid at any rate via the cookbook.
  const shelf = highShelf(sampleRate, 1681.974, 3.99984, 0.7071752)
  const rlb = highPass(sampleRate, 38.13547, 0.5003271)
  const weighted = channels.map((ch) => runBiquad(runBiquad(ch, shelf), rlb))

  const frames = weighted[0]?.length ?? 0
  const block = Math.round(BLOCK_S * sampleRate)
  const hop = Math.round(BLOCK_HOP_S * sampleRate)
  if (frames < block) return { integratedLufs: DB_FLOOR, maxMomentaryLufs: DB_FLOOR }

  // Per-block mean square summed over channels (mono/stereo weights are 1).
  const blocks: number[] = []
  for (let start = 0; start + block <= frames; start += hop) {
    let sum = 0
    for (const ch of weighted) {
      for (let i = start; i < start + block; i++) {
        const v = ch[i] ?? 0
        sum += v * v
      }
    }
    blocks.push(sum / block)
  }

  let maxMomentary = DB_FLOOR
  for (const ms of blocks) maxMomentary = Math.max(maxMomentary, lufs(ms))

  const gated = (threshold: number): number[] => blocks.filter((ms) => lufs(ms) > threshold)
  const pass1 = gated(ABSOLUTE_GATE_LUFS)
  if (pass1.length === 0) return { integratedLufs: DB_FLOOR, maxMomentaryLufs: round(maxMomentary) }
  const relThreshold = lufs(pass1.reduce((a, b) => a + b, 0) / pass1.length) + RELATIVE_GATE_LU
  const pass2 = gated(Math.max(ABSOLUTE_GATE_LUFS, relThreshold))
  const integrated = pass2.length ? lufs(pass2.reduce((a, b) => a + b, 0) / pass2.length) : DB_FLOOR
  return { integratedLufs: round(integrated), maxMomentaryLufs: round(maxMomentary) }
}
