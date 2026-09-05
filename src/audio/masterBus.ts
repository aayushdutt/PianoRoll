// Master output bus — the single path from every sound source to the speakers.
//
//   instruments ─┐
//   metronome  ──┼─► Volume (slider) ─► soft-clip ceiling ─► Destination (0 dB)
//                │
//
// Why it exists (docs/AUDIO_CLIP_FIX_2026-09-05.md): instruments used to
// connect straight to `Tone.Destination`, which has no ceiling, so a handful
// of loud held notes summed past full scale and the hardware hard-clipped
// them into crunch. Measured pre-fix: Grand +13 dB over on an eight-note ff
// cluster, Bass +10 dB. Per-instrument level trims in `instruments.ts` keep
// ordinary playing under the ceiling; the soft clip here is the guarantee.
//
// Why a wave-shaper and not a limiter: a look-ahead limiter (Chromium's
// DynamicsCompressor) was measured at 6 ms of added latency on the live path
// and altered 62 % of a loud chord's samples via its release tail. The
// soft clip is zero-latency, bit-identical below its knee, and touches only
// the samples that would have clipped (< 1 % on the loudest fixture).
//
// One bus per Tone context. Export swaps an `OfflineContext` in via
// `setContext()` and rebuilds instruments inside it; the bus is rebuilt the
// same way, so exports render through the identical volume + ceiling path.
// Cached in a WeakMap keyed by the context object so a disposed context
// doesn't pin its nodes.

import { gainToDb, getContext, getDestination, type InputNode, Volume, WaveShaper } from 'tone'

// Soft-clip ceiling. Identity up to SOFT_CLIP_KNEE (linear, -1.9 dB), then a
// tanh curve that approaches but never reaches ±1. At most 0.4 dB of rounding
// at 0 dBFS; anything below the knee is untouched.
export const SOFT_CLIP_KNEE = 0.8
const SOFT_CLIP_RESOLUTION = 4096

export function softClip(x: number): number {
  const a = Math.abs(x)
  if (a <= SOFT_CLIP_KNEE) return x
  const over = (a - SOFT_CLIP_KNEE) / (1 - SOFT_CLIP_KNEE)
  return Math.sign(x) * (SOFT_CLIP_KNEE + (1 - SOFT_CLIP_KNEE) * Math.tanh(over))
}

interface Bus {
  volume: Volume
  clipper: WaveShaper
}

const buses = new WeakMap<object, Bus>()
// Last slider value, applied to any bus built later (e.g. the export bus).
let masterVolume = 1

// 'protected' is the shipped chain. 'raw' skips the ceiling so the bench can
// read unprotected instrument levels; product code never sets it.
export type MasterBusRouting = 'protected' | 'raw'
let routing: MasterBusRouting = 'protected'

function applyRouting(bus: Bus): void {
  bus.volume.disconnect()
  bus.volume.connect(routing === 'protected' ? bus.clipper : getDestination())
}

function busFor(ctx: object): Bus {
  let bus = buses.get(ctx)
  if (!bus) {
    const volume = new Volume(gainToDb(masterVolume))
    // WaveShaper samples the curve over [-1, 1]; input beyond ±1 clamps to the
    // end values, which are < 1 by construction, so nothing can exceed full
    // scale. No oversampling: measured, '2x' adds 1.45 ms of latency for
    // aliasing that only exists in the rare curved region.
    const clipper = new WaveShaper(softClip, SOFT_CLIP_RESOLUTION)
    clipper.oversample = 'none'
    volume.chain(clipper, getDestination())
    bus = { volume, clipper }
    buses.set(ctx, bus)
    if (routing !== 'protected') applyRouting(bus)
  }
  return bus
}

/** Input node every sound source connects to, for the current Tone context. */
export function getMasterBus(): InputNode {
  return busFor(getContext()).volume
}

/** User volume 0–1, applied to the current context's bus and remembered for
 *  buses built afterwards. */
export function setMasterVolume(v: number): void {
  masterVolume = v
  busFor(getContext()).volume.volume.value = gainToDb(v)
}

export function getMasterBusRouting(): MasterBusRouting {
  return routing
}

/** Bench only. Rewire the current context's bus; remembered for buses built
 *  afterwards, so callers must restore the previous value. */
export function setMasterBusRouting(next: MasterBusRouting): void {
  routing = next
  applyRouting(busFor(getContext()))
}
