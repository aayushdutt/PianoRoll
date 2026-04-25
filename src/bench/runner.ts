import { fetchSampleMidi, getSample } from '../core/samples'
import type { AppCtxValue } from '../store/AppCtx'

/** Must match `FIXTURES` in `scripts/bench.mjs`. */
export const BENCH_FIXTURE_IDS = [
  'chopin-nocturne-op9-2',
  'bach-prelude-c',
  'satie-gnossienne-1',
] as const

export type BenchFixtureId = (typeof BENCH_FIXTURE_IDS)[number]

export interface BenchResult {
  fixture: string
  medianFrameMs: number
  p95FrameMs: number
  loadMs: number
}

export function benchFixtureFromUrl(): string | null {
  const id = new URLSearchParams(window.location.search).get('bench')
  if (!id) return null
  return (BENCH_FIXTURE_IDS as readonly string[]).includes(id) ? id : null
}

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 !== 0 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

function p95(sorted: number[]): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)
  return sorted[idx]!
}

function rafNow(): Promise<number> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      resolve(performance.now())
    })
  })
}

/** Collect `count` consecutive `requestAnimationFrame` intervals (ms). */
async function sampleRafIntervals(count: number): Promise<number[]> {
  const deltas: number[] = []
  let prev = await rafNow()
  for (let i = 0; i < count; i++) {
    const now = await rafNow()
    deltas.push(now - prev)
    prev = now
  }
  return deltas
}

/**
 * Load the sample MIDI into Play, start transport + clock, then measure main-thread
 * frame pacing via `requestAnimationFrame` (correlates with Pixi work while playing).
 */
export async function runBench(fixture: string, ctx: AppCtxValue): Promise<BenchResult> {
  const sample = getSample(fixture)
  if (!sample) throw new Error(`unknown bench fixture: ${fixture}`)

  const t0 = performance.now()
  const midi = await fetchSampleMidi(sample)
  const loadMs = performance.now() - t0

  const { store, renderer, synth, clock } = ctx.services

  ctx.resetInteractionState()
  store.beginPlayLoad()
  renderer.clearMidi()
  await synth.load(midi)
  store.completePlayLoad(midi)
  renderer.loadMidi(midi)
  ctx.trackPanel.render(midi)
  ctx.dropzone.hide()

  ctx.primeInteractiveAudio()
  clock.play()
  store.setState('status', 'playing')

  await sampleRafIntervals(45)
  const deltas = await sampleRafIntervals(180)
  const sorted = [...deltas].sort((a, b) => a - b)

  return {
    fixture,
    medianFrameMs: median(sorted),
    p95FrameMs: p95(sorted),
    loadMs,
  }
}
