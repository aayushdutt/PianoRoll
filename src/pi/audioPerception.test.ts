import { describe, expect, it } from 'vitest'
import { compareMonoAudio } from './audioPerception'

describe('canonical audio perception', () => {
  it('scores identical renders as zero severity', () => {
    const samples = new Float32Array(8192)
    for (let index = 0; index < samples.length; index++) {
      samples[index] = Math.sin((2 * Math.PI * 440 * index) / 16_000)
    }
    const result = compareMonoAudio(samples, samples.slice(), 16_000)
    expect(result.meanSeverity).toBeCloseTo(0, 8)
    expect(result.p90Severity).toBeCloseTo(0, 8)
  })

  it('flags a displaced transient', () => {
    const reference = new Float32Array(8192)
    const delayed = new Float32Array(8192)
    reference[2048] = 1
    delayed[3072] = 1
    const result = compareMonoAudio(reference, delayed, 16_000)
    expect(result.p90Severity).toBeGreaterThan(0)
    expect(result.frames.some((frame) => frame.severity > 0.5)).toBe(true)
  })
})
