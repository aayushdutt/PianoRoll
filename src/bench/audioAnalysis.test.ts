import { describe, expect, it } from 'vitest'
import { analyseChannels, measureLoudness } from './audioAnalysis'

const SR = 1000 // 1 kHz keeps frame↔ms arithmetic trivial

function sine(amplitude: number, frames: number): Float32Array {
  const out = new Float32Array(frames)
  for (let i = 0; i < frames; i++) out[i] = amplitude * Math.sin((2 * Math.PI * 10 * i) / SR)
  return out
}

describe('analyseChannels', () => {
  it('reports peak/rms for a clean signal and no clipping', () => {
    const m = analyseChannels([sine(0.5, SR)], SR)
    expect(m.peakDb).toBeCloseTo(-6.02, 1)
    // sine RMS = A/√2 → 0.354 → -9.03 dB
    expect(m.rmsDb).toBeCloseTo(-9.03, 1)
    expect(m.crestDb).toBeCloseTo(3.01, 1)
    expect(m.clipPct).toBe(0)
    expect(m.clipRunMaxMs).toBe(0)
    expect(m.firstClipS).toBe(-1)
  })

  it('measures overshoot above full scale (offline buffers are unclamped)', () => {
    const m = analyseChannels([sine(2, SR)], SR)
    expect(m.peakDb).toBeCloseTo(6.02, 1)
    expect(m.clipPct).toBeGreaterThan(30)
    expect(m.firstClipS).toBeGreaterThanOrEqual(0)
  })

  it('finds the longest clipped run and the first clipped frame', () => {
    const ch = new Float32Array(SR)
    ch.fill(1.2, 200, 250) // 50 ms run at t=0.2
    ch.fill(-1.0, 600, 720) // 120 ms run at t=0.6 (negative side counts too)
    const m = analyseChannels([ch], SR)
    expect(m.clipRunMaxMs).toBe(120)
    expect(m.firstClipS).toBe(0.2)
    expect(m.clipPct).toBeCloseTo(17, 0)
  })

  it('takes the per-frame max across channels', () => {
    const left = new Float32Array(SR)
    const right = new Float32Array(SR)
    right.fill(1.5, 10, 20)
    const m = analyseChannels([left, right], SR)
    expect(m.peakDb).toBeCloseTo(3.52, 1)
    expect(m.clipRunMaxMs).toBe(10)
  })

  it('restricts RMS to the requested window but keeps peak global', () => {
    const ch = new Float32Array(2 * SR)
    ch.fill(0.5, 0, SR) // loud first second
    ch[1500] = 1.0 // lone clipped sample in the quiet second
    const m = analyseChannels([ch], SR, { from: 0, to: 1 })
    expect(m.rmsDb).toBeCloseTo(-6.02, 1)
    expect(m.peakDb).toBe(0)
    expect(m.firstClipS).toBe(1.5)
  })

  it('handles an empty buffer without NaN', () => {
    const m = analyseChannels([new Float32Array(0)], SR)
    expect(m.peakDb).toBe(-120)
    expect(m.rmsDb).toBe(-120)
    expect(m.clipPct).toBe(0)
  })
})

describe('measureLoudness (BS.1770 K-weighted)', () => {
  const sr = 48_000
  const tone = (hz: number, amp: number, secs: number): Float32Array => {
    const out = new Float32Array(Math.round(sr * secs))
    for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * hz * i) / sr)
    return out
  }

  it('reads a 1 kHz sine at -20 dBFS as about -23.7 LUFS (single channel)', () => {
    // K-weighting is ~0 dB at 1 kHz; mean square of a sine at 0.1 is 0.005 →
    // -0.691 + 10·log10(0.005) = -23.7. Standard's reference behaviour.
    const l = measureLoudness([tone(1000, 0.1, 3)], sr)
    expect(l.integratedLufs).toBeCloseTo(-23.7, 0)
    expect(l.maxMomentaryLufs).toBeCloseTo(-23.7, 0)
  })

  it('tracks gain: +6 dB in → +6 LU out', () => {
    const a = measureLoudness([tone(1000, 0.1, 3)], sr).integratedLufs
    const b = measureLoudness([tone(1000, 0.2, 3)], sr).integratedLufs
    expect(b - a).toBeCloseTo(6.02, 1)
  })

  it('weights high frequencies up and sub-bass down, as the ear does', () => {
    const mid = measureLoudness([tone(1000, 0.1, 3)], sr).integratedLufs
    const high = measureLoudness([tone(6000, 0.1, 3)], sr).integratedLufs
    const low = measureLoudness([tone(30, 0.1, 3)], sr).integratedLufs
    expect(high).toBeGreaterThan(mid + 2)
    expect(low).toBeLessThan(mid - 6)
  })

  it('momentary max captures a short burst that integrated loudness gates out', () => {
    const x = new Float32Array(sr * 4)
    x.set(tone(1000, 0.5, 0.5), sr) // half-second burst in four seconds of silence
    const l = measureLoudness([x], sr)
    expect(l.maxMomentaryLufs).toBeGreaterThan(-12)
    // Integrated is gated to the loud blocks only, so it stays near the burst level too.
    expect(l.integratedLufs).toBeGreaterThan(-15)
  })
})
