import { beforeEach, describe, expect, it, vi } from 'vitest'

// Minimal Tone stand-ins: enough graph to assert wiring and per-context
// caching. Everything the mock factory touches lives in the hoisted block.
const h = vi.hoisted(() => {
  const state = {
    ctx: {} as object,
    destination: { id: 'destination' },
    volumes: [] as FakeVolume[],
    shapers: [] as FakeShaper[],
  }
  class FakeVolume {
    volume = { value: 0 }
    connections: unknown[] = []
    constructor(db: number) {
      this.volume.value = db
      state.volumes.push(this)
    }
    chain(...nodes: unknown[]): this {
      this.connections = nodes
      return this
    }
    connect(node: unknown): this {
      this.connections.push(node)
      return this
    }
    disconnect(): this {
      this.connections = []
      return this
    }
  }
  class FakeShaper {
    oversample = 'none'
    constructor(
      public curve: (x: number) => number,
      public resolution: number,
    ) {
      state.shapers.push(this)
    }
  }
  return { state, FakeVolume, FakeShaper }
})

vi.mock('tone', () => ({
  Volume: h.FakeVolume,
  WaveShaper: h.FakeShaper,
  getContext: () => h.state.ctx,
  getDestination: () => h.state.destination,
  gainToDb: (v: number) => (v > 0 ? 20 * Math.log10(v) : -Infinity),
}))

import {
  getMasterBus,
  getMasterBusRouting,
  SOFT_CLIP_KNEE,
  setMasterBusRouting,
  setMasterVolume,
  softClip,
} from './masterBus'

const s = h.state

beforeEach(() => {
  // Reset routing on the previous context first — it builds a bus there,
  // which must not leak into the fresh context's node lists.
  setMasterBusRouting('protected')
  s.ctx = {}
  s.volumes = []
  s.shapers = []
})

describe('masterBus', () => {
  it('builds volume → soft-clip → destination once per context', () => {
    const a = getMasterBus()
    const b = getMasterBus()
    expect(a).toBe(b)
    expect(s.volumes).toHaveLength(1)
    expect(s.shapers).toHaveLength(1)
    expect(s.volumes[0]!.connections).toEqual([s.shapers[0], s.destination])
    expect(s.shapers[0]!.curve).toBe(softClip)
    expect(s.shapers[0]!.oversample).toBe('none') // '2x' measured at +1.45 ms latency
  })

  it('rebuilds for a new context (export swaps in an OfflineContext)', () => {
    const online = getMasterBus()
    s.ctx = {}
    const offline = getMasterBus()
    expect(offline).not.toBe(online)
    expect(s.volumes).toHaveLength(2)
  })

  it('applies the slider in dB and carries it to buses built later', () => {
    setMasterVolume(0.5)
    expect(s.volumes[0]!.volume.value).toBeCloseTo(-6.02, 2)
    s.ctx = {}
    getMasterBus()
    expect(s.volumes[1]!.volume.value).toBeCloseTo(-6.02, 2)
  })

  it('soft clip is identity below the knee and never reaches full scale', () => {
    expect(softClip(0)).toBe(0)
    expect(softClip(0.5)).toBe(0.5)
    expect(softClip(-SOFT_CLIP_KNEE)).toBe(-SOFT_CLIP_KNEE)
    expect(softClip(1)).toBeLessThan(1)
    expect(softClip(1)).toBeGreaterThan(0.94) // ≤ 0.5 dB of rounding at 0 dBFS
    expect(softClip(4)).toBeLessThan(1)
    expect(softClip(-4)).toBeGreaterThan(-1)
    // Continuous across the knee.
    expect(softClip(SOFT_CLIP_KNEE + 1e-6)).toBeGreaterThan(SOFT_CLIP_KNEE)
    expect(softClip(SOFT_CLIP_KNEE + 1e-6) - SOFT_CLIP_KNEE).toBeLessThan(1e-5)
  })

  it("'raw' routing bypasses the ceiling and 'protected' restores it", () => {
    getMasterBus()
    const vol = s.volumes[0]!
    setMasterBusRouting('raw')
    expect(getMasterBusRouting()).toBe('raw')
    expect(vol.connections).toEqual([s.destination])
    setMasterBusRouting('protected')
    expect(vol.connections).toEqual([s.shapers[0]])
  })

  it('a bus built while raw is set starts raw', () => {
    setMasterBusRouting('raw')
    getMasterBus()
    expect(s.volumes[0]!.connections).toEqual([s.destination])
  })
})
