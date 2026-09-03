// In-page bench runner — the measurement half of the perf harness.
// Driven by scripts/bench.mjs via URL params; see docs/BENCH_HARNESS_V2_2026-07-02.md.
//
// Protocol: `?bench=<suite>&fixture=<id>` runs one suite and publishes the
// result on `window.__BENCH_RESULT` (errors → `window.__BENCH_ERROR`).
// `?bench=list` publishes the fixture ids on `window.__BENCH_FIXTURES` so the
// driver discovers them from here — this file is the single source of truth.
//
// Measurement rules this file enforces (the v1 harness broke both):
//   · CPU suites drive `renderManualFrame` under `pauseAutoRender()` — the
//     exact export code path — so the app ticker can't interleave frames and
//     headless rAF throttling is irrelevant.
//   · Frames are timed in batches of 10: `performance.now()` quantizes to
//     ~0.1 ms without cross-origin isolation, so single sub-ms frames are
//     mostly timer noise. A batch gives 0.01 ms/frame resolution.

import { parseMidiFile } from '../core/midi/parser'
import type { MidiFile } from '../core/midi/types'
import type { AppCtxValue } from '../store/AppCtx'

export interface BenchFixture {
  id: string
  url: string
}

// Ordered sparse → dense. The /local pieces are the stress end: fantaisie is
// fast+dense, kunst-der-fuge maximizes simultaneously-active notes.
export const BENCH_FIXTURES: readonly BenchFixture[] = [
  { id: 'bach-prelude-c', url: `${import.meta.env.BASE_URL}samples/bach-prelude-in-c.mid` },
  { id: 'satie-gnossienne-1', url: `${import.meta.env.BASE_URL}samples/satie-gnossienne-1.mid` },
  {
    id: 'chopin-nocturne-op9-2',
    url: `${import.meta.env.BASE_URL}samples/chopin-nocturne-op9-2.mid`,
  },
  {
    id: 'fantaisie-impromptu',
    url: `${import.meta.env.BASE_URL}local/002_f-f-chopin_fantaisie-impromptu.mid`,
  },
  {
    id: 'kunst-der-fuge',
    url: `${import.meta.env.BASE_URL}local/011_j-s-bach_die-kunst-der-fuge-contrapunctus-xv-canon-per-augmentationem.mid`,
  },
]

export type BenchSuite =
  | 'frame'
  | 'attribution'
  | 'live'
  | 'idle'
  | 'pacing'
  | 'export'
  | 'exportlab'
  | 'audiorender'

export interface BenchEnv {
  ua: string
  cores: number
  dpr: number
  canvas: { width: number; height: number }
  webglRenderer: string
  automated: boolean
}

export interface BenchResult {
  schema: 2
  suite: BenchSuite
  fixture: string
  env: BenchEnv
  // Metric names/units are suite-specific; the driver treats them as an
  // opaque bag and formats/gates by key (see METRIC_GATES in bench.mjs).
  metrics: Record<string, number>
}

const DT = 1 / 60
const BATCH = 10
const WARMUP_BATCHES = 30

// ── stats helpers ─────────────────────────────────────────────────────────

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)
  return sorted[Math.max(0, idx)]!
}

function summarize(perFrameMs: number[]): Record<string, number> {
  const sorted = [...perFrameMs].sort((a, b) => a - b)
  const mean = sorted.reduce((a, b) => a + b, 0) / Math.max(1, sorted.length)
  return {
    medianFrameMs: round(quantile(sorted, 0.5)),
    p95FrameMs: round(quantile(sorted, 0.95)),
    p99FrameMs: round(quantile(sorted, 0.99)),
    meanFrameMs: round(mean),
    maxFrameMs: round(sorted[sorted.length - 1] ?? 0),
  }
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// Compositor-paced yield between samples. This is load-bearing, not
// politeness: driving `app.renderer.render()` in an unpaced tight loop
// overruns the (headless) compositor's pipeline — Chromium starts forcing
// synchronous GPU readbacks ("GPU stall due to ReadPixels") and batches
// intermittently crawl 100-1000× slower, which both poisons p95 and blows
// the driver timeout on long fixtures. One rAF per sample lets the
// compositor drain, keeps per-batch timing honest, and also flushes late
// async callbacks (GC, decode) outside the timed window.
function nextFrame(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => r()))
}

// Typed monkey-patch used by `attribution` and `idle`. Wraps a method with a
// timing/counting sink and returns an un-patch closure. Bench-only: product
// code is never shipped patched, and every patch is reverted in a finally.
type AnyMethod = (...args: unknown[]) => unknown
function patchMethod(obj: object, key: string, sink: (ms: number) => void): () => void {
  const target = obj as Record<string, AnyMethod>
  const orig = target[key]
  if (typeof orig !== 'function') throw new Error(`bench: cannot patch missing method ${key}`)
  target[key] = function (this: unknown, ...args: unknown[]) {
    const s = performance.now()
    const out = orig.apply(this, args)
    sink(performance.now() - s)
    return out
  }
  return () => {
    target[key] = orig
  }
}

// Renderer internals reached by the bench. Kept as a shape-cast (not `any`)
// so a rename in PianoRollRenderer fails the patch loudly at runtime here
// instead of silently timing nothing.
interface RendererInternals {
  noteRenderer: object
  liveNoteRenderer: object
  beatGrid: object
  keyboardRenderer: object
  particles: object
  app: { renderer: object }
}

function internals(renderer: object): RendererInternals {
  return renderer as unknown as RendererInternals
}

// ── environment capture ───────────────────────────────────────────────────

function captureEnv(ctx: AppCtxValue): BenchEnv {
  let webglRenderer = 'unknown'
  try {
    const probe = document.createElement('canvas')
    const gl = probe.getContext('webgl2') ?? probe.getContext('webgl')
    const dbg = gl?.getExtension('WEBGL_debug_renderer_info')
    if (gl && dbg) {
      webglRenderer = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL))
    }
  } catch {
    // leave 'unknown' — env capture must never fail a bench
  }
  const canvas = ctx.services.renderer.canvas
  return {
    ua: navigator.userAgent,
    cores: navigator.hardwareConcurrency ?? 0,
    dpr: window.devicePixelRatio || 1,
    canvas: { width: canvas.width, height: canvas.height },
    webglRenderer,
    automated: navigator.webdriver === true,
  }
}

// ── fixture loading ───────────────────────────────────────────────────────

async function loadFixture(ctx: AppCtxValue, id: string): Promise<MidiFile> {
  progress(`load:${id}`)
  const fixture = BENCH_FIXTURES.find((f) => f.id === id)
  if (!fixture) throw new Error(`unknown bench fixture: ${id}`)
  const res = await fetch(fixture.url)
  if (!res.ok) throw new Error(`fixture fetch failed: ${fixture.url} → ${res.status}`)
  const midi = await parseMidiFile(await res.arrayBuffer(), id)

  // Enter play mode through the store — <PlayMode/>'s effect then performs
  // the real surface side effects (renderer.loadMidi, trackPanel, title).
  // synth.load is deliberately NOT awaited/called: render benches must not
  // depend on instrument sample downloads.
  ctx.resetInteractionState()
  ctx.store.beginPlayLoad()
  ctx.services.renderer.clearMidi()
  ctx.store.completePlayLoad(midi)

  // Resume the AudioContext (no sound plays — no instrument is loaded). A
  // media-active page is exempt from browser backgrounding/throttling
  // heuristics in long headless runs, and it matches the app's state during
  // real playback. The driver passes --autoplay-policy=no-user-gesture-required.
  ctx.primeInteractiveAudio()

  // Let the app's idle-time warmups (piano-sample fetch + decode, modal chunk
  // prefetch, LearnController import) finish before measuring — they fire
  // ~200ms after boot and would otherwise land inside timed batches as
  // 100ms+ outliers that poison p95/max.
  progress(`settle:${id}`)
  await sleep(3000)
  return midi
}

function progress(phase: string): void {
  window.__BENCH_PROGRESS = phase
}

// Sweep positions across the meat of the piece — skip the sparse head and the
// fade-out tail so density reflects actual playback.
function sweepTimes(duration: number, samples: number): number[] {
  const start = duration * 0.25
  const end = duration * 0.95
  const step = (end - start) / Math.max(1, samples - 1)
  return Array.from({ length: samples }, (_, i) => start + i * step)
}

// ── suites ────────────────────────────────────────────────────────────────

// One timed batch: BATCH consecutive CPU scene updates from `t` (advancing by
// DT, the export call pattern) plus ONE real GPU present, timed separately.
// The split is deliberate: update cost is deterministic, app-controlled CPU
// work — the gated regression metric. Present cost is compositor/GPU-pipeline
// dependent (and pathological under headless GL when over-driven: full-rate
// presents intermittently stall 100-1000× on "GPU stall due to ReadPixels"),
// so it's reported as environment info, one present per batch.
interface BatchSample {
  updateMs: number
  presentMs: number
}
function timeBatch(ctx: AppCtxValue, t: number): BatchSample {
  const renderer = ctx.services.renderer
  const s0 = performance.now()
  for (let f = 0; f < BATCH; f++) {
    renderer.renderManualFrame(t + f * DT, DT, false)
  }
  const s1 = performance.now()
  renderer.renderManualFrame(t + BATCH * DT, DT)
  const s2 = performance.now()
  return { updateMs: (s1 - s0) / BATCH, presentMs: s2 - s1 }
}

function summarizeBatches(samples: BatchSample[]): Record<string, number> {
  const presents = samples.map((s) => s.presentMs).sort((a, b) => a - b)
  return {
    ...summarize(samples.map((s) => s.updateMs)),
    medianPresentMs: round(quantile(presents, 0.5)),
    p95PresentMs: round(quantile(presents, 0.95)),
  }
}

async function suiteFrame(ctx: AppCtxValue, fixtureId: string): Promise<Record<string, number>> {
  const midi = await loadFixture(ctx, fixtureId)
  const renderer = ctx.services.renderer
  renderer.pauseAutoRender()
  try {
    progress(`frame:warmup:${fixtureId}`)
    const times = sweepTimes(midi.duration, 300)
    for (const t of sweepTimes(midi.duration, WARMUP_BATCHES)) {
      timeBatch(ctx, t)
      await nextFrame()
    }

    progress(`frame:measure:${fixtureId}`)
    const heap0 = heapMB()
    const samples: BatchSample[] = []
    for (let i = 0; i < times.length; i++) {
      progress(`frame:measure:${fixtureId}:${i}/${times.length}:t=${times[i]!.toFixed(2)}`)
      samples.push(timeBatch(ctx, times[i]!))
      await nextFrame()
    }
    const heap1 = heapMB()
    return {
      ...summarizeBatches(samples),
      frames: times.length * BATCH,
      heapGrowthMB: round(Math.max(0, heap1 - heap0)),
      noteCount: midi.tracks.reduce((n, tr) => n + tr.notes.length, 0),
    }
  } finally {
    renderer.resumeAutoRender()
  }
}

const ATTRIBUTION_PARTS = [
  ['notes', 'noteRenderer', 'draw'],
  ['liveNotes', 'liveNoteRenderer', 'draw'],
  ['beatGrid', 'beatGrid', 'draw'],
  ['keyboard', 'keyboardRenderer', 'drawActiveKeys'],
  ['particles', 'particles', 'update'],
] as const

async function suiteAttribution(
  ctx: AppCtxValue,
  fixtureId: string,
): Promise<Record<string, number>> {
  const midi = await loadFixture(ctx, fixtureId)
  const renderer = ctx.services.renderer
  const inner = internals(renderer)
  renderer.pauseAutoRender()

  const acc = new Map<string, number>()
  const bump = (key: string) => (ms: number) => acc.set(key, (acc.get(key) ?? 0) + ms)
  const unpatch: Array<() => void> = []
  try {
    for (const [label, objKey, method] of ATTRIBUTION_PARTS) {
      unpatch.push(patchMethod(inner[objKey], method, bump(label)))
    }

    progress(`attribution:warmup:${fixtureId}`)
    for (const t of sweepTimes(midi.duration, WARMUP_BATCHES)) {
      timeBatch(ctx, t)
      await nextFrame()
    }
    acc.clear()

    progress(`attribution:measure:${fixtureId}`)
    const SAMPLES = 150
    const samples: BatchSample[] = []
    for (const t of sweepTimes(midi.duration, SAMPLES)) {
      samples.push(timeBatch(ctx, t))
      await nextFrame()
    }
    // Parts run once per scene update: BATCH no-present updates + the one
    // present (which also updates) per batch.
    const frames = SAMPLES * (BATCH + 1)

    const metrics: Record<string, number> = summarizeBatches(samples)
    let partsTotal = 0
    for (const [label] of ATTRIBUTION_PARTS) {
      const ms = (acc.get(label) ?? 0) / frames
      metrics[`${label}MsPerFrame`] = round(ms)
      partsTotal += ms
    }
    metrics.otherMsPerFrame = round(Math.max(0, metrics.meanFrameMs! - partsTotal))
    return metrics
  } finally {
    for (const u of unpatch) u()
    renderer.resumeAutoRender()
  }
}

// Live-performance frame cost: scheduled MIDI + a rolling held chord fed
// through the real InputBus (trails + keyboard highlights) + particle bursts.
// Pitch cycle is deterministic — no RNG anywhere in the harness.
async function suiteLive(ctx: AppCtxValue, fixtureId: string): Promise<Record<string, number>> {
  const midi = await loadFixture(ctx, fixtureId)
  const { renderer, clock, input } = ctx.services
  renderer.pauseAutoRender()

  const HELD = 6
  let nextPitch = 48
  const held: number[] = []
  const press = (t: number) => {
    const pitch = 48 + ((nextPitch++ - 48) % 36)
    held.push(pitch)
    input.emitNoteOn({ pitch, velocity: 0.8, clockTime: t }, 'midi')
    if (held.length > HELD) {
      const oldest = held.shift()!
      input.emitNoteOff({ pitch: oldest, velocity: 0, clockTime: t }, 'midi')
    }
  }

  try {
    const times = sweepTimes(midi.duration, 200)
    for (const t of sweepTimes(midi.duration, WARMUP_BATCHES)) {
      clock.seek(t)
      press(t)
      timeBatch(ctx, t)
      await nextFrame()
    }

    progress(`live:measure:${fixtureId}`)
    const samples: BatchSample[] = []
    for (const t of times) {
      // Anchor the clock so trail geometry (startTime vs render time) is
      // realistic, churn the chord, and burst particles like a real note-on.
      clock.seek(t)
      press(t)
      press(t)
      renderer.burstParticleAt(held[held.length - 1]!)
      samples.push(timeBatch(ctx, t))
      await nextFrame()
    }
    return { ...summarizeBatches(samples), frames: times.length * BATCH }
  } finally {
    for (const pitch of held) {
      input.emitNoteOff({ pitch, velocity: 0, clockTime: clock.currentTime }, 'midi')
    }
    renderer.resumeAutoRender()
  }
}

// Idle regression guard: counts REAL renders (app.renderer.render calls) per
// second in three app states. home/paused must converge to ~0 after the
// idle-stop grace window; playing is the sanity control.
async function suiteIdle(ctx: AppCtxValue, fixtureId: string): Promise<Record<string, number>> {
  const renderer = ctx.services.renderer
  const inner = internals(renderer)
  const SETTLE_MS = 3000
  const WINDOW_MS = 4000

  let renders = 0
  const unpatch = patchMethod(inner.app.renderer, 'render', () => renders++)

  // Fixed wall-clock settles kept tripping the paused gate: IDLE_GRACE_FRAMES
  // (30) is frame-counted, and throttled rAF (headless ~15Hz, worse under
  // --cpu) stretches it past any constant we pick. Wait for quiescence
  // instead — 1s with zero renders. The cap keeps a real regression (renders
  // that never stop) from hanging; the window then counts it and fails the gate.
  const settleUntilQuiet = async (maxMs = 15000): Promise<void> => {
    const start = performance.now()
    let seen = renders
    let quietSince = performance.now()
    while (performance.now() - start < maxMs) {
      await sleep(250)
      if (renders !== seen) {
        seen = renders
        quietSince = performance.now()
      } else if (performance.now() - quietSince >= 1000) {
        return
      }
    }
  }

  const countWindow = async (): Promise<number> => {
    await settleUntilQuiet()
    renders = 0
    const s = performance.now()
    await sleep(WINDOW_MS)
    return renders / ((performance.now() - s) / 1000)
  }

  try {
    ctx.store.enterHome()
    const homeRendersPerSec = await countWindow()

    await loadFixture(ctx, fixtureId)
    ctx.services.clock.seek(30)
    const pausedRendersPerSec = await countWindow()

    ctx.services.clock.play()
    ctx.store.setState('status', 'playing')
    await sleep(SETTLE_MS)
    renders = 0
    const s = performance.now()
    await sleep(WINDOW_MS)
    const playingRendersPerSec = renders / ((performance.now() - s) / 1000)
    ctx.services.clock.pause()
    ctx.store.setState('status', 'paused')

    return {
      homeRendersPerSec: round(homeRendersPerSec),
      pausedRendersPerSec: round(pausedRendersPerSec),
      playingRendersPerSec: round(playingRendersPerSec),
    }
  } finally {
    unpatch()
  }
}

// Real-world pacing: rAF interval distribution + long tasks during actual
// playback. Only meaningful headed — the driver refuses to schedule it
// headless, where compositor scheduling makes rAF cadence fiction.
async function suitePacing(ctx: AppCtxValue, fixtureId: string): Promise<Record<string, number>> {
  await loadFixture(ctx, fixtureId)
  const WINDOW_MS = 8000

  let longTasks = 0
  let longTaskMs = 0
  let observer: PerformanceObserver | null = null
  try {
    observer = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        longTasks++
        longTaskMs += e.duration
      }
    })
    observer.observe({ type: 'longtask', buffered: false })
  } catch {
    observer = null // longtask unsupported — report -1 below
  }

  ctx.services.clock.play()
  ctx.store.setState('status', 'playing')
  await sleep(500) // settle into steady state

  const deltas: number[] = []
  await new Promise<void>((done) => {
    let prev = performance.now()
    const start = prev
    const tick = (now: number) => {
      deltas.push(now - prev)
      prev = now
      if (now - start < WINDOW_MS) requestAnimationFrame(tick)
      else done()
    }
    requestAnimationFrame(tick)
  })

  ctx.services.clock.pause()
  ctx.store.setState('status', 'paused')
  observer?.disconnect()

  const sorted = [...deltas].sort((a, b) => a - b)
  const median = quantile(sorted, 0.5)
  const dropped = deltas.filter((d) => d > median * 1.5).length
  return {
    fps: round(1000 / Math.max(0.001, median)),
    medianIntervalMs: round(median),
    p95IntervalMs: round(quantile(sorted, 0.95)),
    worstIntervalMs: round(sorted[sorted.length - 1] ?? 0),
    droppedFramePct: round((dropped / Math.max(1, deltas.length)) * 100),
    longTasks: observer ? longTasks : -1,
    longTaskMs: observer ? round(longTaskMs) : -1,
  }
}

// Export-loop cost: the REAL pipeline VideoExporter runs per frame -
// seek → scene update + GPU present → VideoFrame(canvas) capture →
// encoder.encode — including its backpressure strategy. This is the suite
// that answers "how fast does an export run on this device", which the
// frame suite (CPU update only) deliberately does not.
async function suiteExport(ctx: AppCtxValue, fixtureId: string): Promise<Record<string, number>> {
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
    throw new Error('WebCodecs unavailable - export suite cannot run in this browser')
  }
  const midi = await loadFixture(ctx, fixtureId)
  const { renderer, clock } = ctx.services
  const canvas = renderer.canvas

  const FPS = 30
  const EXPORT_DT = 1 / FPS
  const FRAMES = 450 // 15 s of output video
  const BITRATE = 8_000_000
  const MAX_QUEUE = 20 // mirrors VideoExporter's backpressure constant
  const width = canvas.width & ~1
  const height = canvas.height & ~1

  // Same two-pass probe order as VideoExporter: hardware first, software next.
  let hwAccel = 1
  const config: VideoEncoderConfig = {
    codec: 'avc1.640028', // High 4.0 — comfortably covers any window-size canvas
    width,
    height,
    bitrate: BITRATE,
    framerate: FPS,
    hardwareAcceleration: 'prefer-hardware',
    latencyMode: 'realtime',
  }
  if (!(await VideoEncoder.isConfigSupported(config)).supported) {
    hwAccel = 0
    config.hardwareAcceleration = 'prefer-software'
    if (!(await VideoEncoder.isConfigSupported(config)).supported) {
      throw new Error('no H.264 encoder accepted by this browser for the export suite')
    }
  }

  let encoderError: Error | null = null
  const encoder = new VideoEncoder({
    output: () => {}, // chunks discarded — muxing isn't what we're measuring
    error: (e) => {
      encoderError ??= e as Error
    },
  })
  encoder.configure(config)

  renderer.pauseAutoRender()
  const renderMs: number[] = []
  const captureMs: number[] = []
  let stallMs = 0
  try {
    progress(`export:encode:${fixtureId}`)
    const t0 = midi.duration * 0.25 // skip the sparse head, like sweepTimes
    const keyEvery = FPS * 2
    const wallStart = performance.now()
    for (let i = 0; i < FRAMES; i++) {
      if (encoderError) throw encoderError
      const t = t0 + i * EXPORT_DT

      const r0 = performance.now()
      clock.seek(t)
      renderer.renderManualFrame(t, EXPORT_DT)
      const r1 = performance.now()
      const frame = new VideoFrame(canvas, {
        timestamp: Math.round((i * 1_000_000) / FPS),
        visibleRect: { x: 0, y: 0, width, height },
        displayWidth: width,
        displayHeight: height,
      })
      const r2 = performance.now()
      encoder.encode(frame, { keyFrame: i % keyEvery === 0 })
      frame.close()
      renderMs.push(r1 - r0)
      captureMs.push(r2 - r1)

      if (encoder.encodeQueueSize > MAX_QUEUE) {
        const s0 = performance.now()
        while (encoder.encodeQueueSize > MAX_QUEUE / 2) {
          if (encoderError) throw encoderError
          await sleep(0)
        }
        stallMs += performance.now() - s0
      }
      if (i % 30 === 29) progress(`export:encode:${fixtureId}:${i + 1}/${FRAMES}`)
    }
    await encoder.flush()
    if (encoderError) throw encoderError
    const wallMs = performance.now() - wallStart

    const renders = [...renderMs].sort((a, b) => a - b)
    const captures = [...captureMs].sort((a, b) => a - b)
    return {
      medianRenderMs: round(quantile(renders, 0.5)),
      p95RenderMs: round(quantile(renders, 0.95)),
      medianCaptureMs: round(quantile(captures, 0.5)),
      p95CaptureMs: round(quantile(captures, 0.95)),
      encodeFps: round(FRAMES / (wallMs / 1000)),
      stallMs: round(stallMs),
      hwAccel,
      frames: FRAMES,
    }
  } finally {
    if (encoder.state !== 'closed') encoder.close()
    renderer.resumeAutoRender()
  }
}

// ── exportlab: variant sweep for the export loop ───────────────────────────
// Answers "which knob moves encode throughput on THIS machine": capture path
// (VideoFrame(canvas) vs readPixels vs 2D copy vs ImageBitmap), encoder
// latencyMode / hardware preference, and backpressure strategy. Each variant
// runs the same frames on a fresh encoder; chunks are discarded.

interface LabVariant {
  name: string
  latencyMode?: 'quality' | 'realtime'
  hw?: 'prefer-hardware' | 'prefer-software' | 'no-preference'
  capture: 'canvas' | 'canvas-discard' | 'readpixels' | '2d' | 'bitmap'
  maxQueue: number
  wait: 'timeout' | 'dequeue' | 'yield'
  bitrateMode?: 'constant' | 'variable'
}

const LAB_VARIANTS: LabVariant[] = [
  { name: 'base', capture: 'canvas', maxQueue: 20, wait: 'timeout' },
  { name: 'dequeue', capture: 'canvas', maxQueue: 20, wait: 'dequeue' },
  { name: 'yield', capture: 'canvas', maxQueue: 20, wait: 'yield' },
  { name: 'q4', capture: 'canvas', maxQueue: 4, wait: 'dequeue' },
  { name: 'q60', capture: 'canvas', maxQueue: 60, wait: 'dequeue' },
  { name: 'quality', capture: 'canvas', maxQueue: 20, wait: 'dequeue', latencyMode: 'quality' },
  { name: 'nopref', capture: 'canvas', maxQueue: 20, wait: 'dequeue', hw: 'no-preference' },
  { name: 'sw', capture: 'canvas', maxQueue: 20, wait: 'dequeue', hw: 'prefer-software' },
  { name: 'cbr', capture: 'canvas', maxQueue: 20, wait: 'dequeue', bitrateMode: 'constant' },
  { name: 'discard', capture: 'canvas-discard', maxQueue: 20, wait: 'dequeue' },
  { name: 'readpx', capture: 'readpixels', maxQueue: 20, wait: 'dequeue' },
  { name: 'copy2d', capture: '2d', maxQueue: 20, wait: 'dequeue' },
  { name: 'bitmap', capture: 'bitmap', maxQueue: 20, wait: 'dequeue' },
]

async function suiteExportLab(
  ctx: AppCtxValue,
  fixtureId: string,
): Promise<Record<string, number>> {
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
    throw new Error('WebCodecs unavailable - exportlab cannot run in this browser')
  }
  const midi = await loadFixture(ctx, fixtureId)
  const { renderer, clock } = ctx.services
  const canvas = renderer.canvas
  const FPS = 30
  const DT = 1 / FPS
  const FRAMES = 300
  const width = canvas.width & ~1
  const height = canvas.height & ~1
  const t0 = midi.duration * 0.25
  const keyEvery = FPS * 2
  const out: Record<string, number> = {}

  const gl = (renderer as unknown as { app: { renderer: { gl?: WebGL2RenderingContext } } }).app
    .renderer.gl
  const pixelBuf = new Uint8Array(width * height * 4)
  const off = new OffscreenCanvas(width, height)
  const ctx2d = off.getContext('2d')!

  renderer.pauseAutoRender()
  try {
    for (const v of LAB_VARIANTS) {
      progress(`exportlab:${v.name}`)
      const config: VideoEncoderConfig = {
        codec: 'avc1.640028',
        width,
        height,
        bitrate: 8_000_000,
        framerate: FPS,
        hardwareAcceleration: v.hw ?? 'prefer-hardware',
        latencyMode: v.latencyMode ?? 'realtime',
        ...(v.bitrateMode ? { bitrateMode: v.bitrateMode } : {}),
      }
      if (!(await VideoEncoder.isConfigSupported(config)).supported) {
        out[`${v.name}_fps`] = -1
        continue
      }
      let encoderError: Error | null = null
      let wake: (() => void) | null = null
      const encoder = new VideoEncoder({
        output: () => {},
        error: (e) => {
          encoderError ??= e as Error
        },
      })
      encoder.ondequeue = () => {
        wake?.()
      }
      encoder.configure(config)
      let stallMs = 0
      const wallStart = performance.now()
      try {
        for (let i = 0; i < FRAMES; i++) {
          if (encoderError) throw encoderError
          const t = t0 + i * DT
          clock.seek(t)
          renderer.renderManualFrame(t, DT)
          const timestamp = Math.round((i * 1_000_000) / FPS)
          let frame: VideoFrame
          switch (v.capture) {
            case 'canvas':
              frame = new VideoFrame(canvas, {
                timestamp,
                visibleRect: { x: 0, y: 0, width, height },
              })
              break
            case 'canvas-discard':
              frame = new VideoFrame(canvas, {
                timestamp,
                alpha: 'discard',
                visibleRect: { x: 0, y: 0, width, height },
              })
              break
            case 'readpixels': {
              if (!gl) throw new Error('no gl')
              gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixelBuf)
              frame = new VideoFrame(pixelBuf, {
                format: 'RGBA',
                codedWidth: width,
                codedHeight: height,
                timestamp,
              })
              break
            }
            case '2d':
              ctx2d.drawImage(canvas, 0, 0)
              frame = new VideoFrame(off, { timestamp })
              break
            case 'bitmap': {
              const bmp = await createImageBitmap(canvas)
              frame = new VideoFrame(bmp, { timestamp })
              bmp.close()
              break
            }
          }
          encoder.encode(frame, { keyFrame: i % keyEvery === 0 })
          frame.close()

          if (encoder.encodeQueueSize > v.maxQueue) {
            const s0 = performance.now()
            while (encoder.encodeQueueSize > v.maxQueue / 2) {
              if (encoderError) throw encoderError
              if (v.wait === 'timeout') await sleep(0)
              else if (v.wait === 'yield') await yieldNow()
              else {
                // dequeue can be coalesced/missed; a short timer bounds the wait.
                await new Promise<void>((r) => {
                  const timer = setTimeout(r, 20)
                  wake = () => {
                    clearTimeout(timer)
                    r()
                  }
                })
              }
            }
            stallMs += performance.now() - s0
          }
        }
        await encoder.flush()
        if (encoderError) throw encoderError
        const wallMs = performance.now() - wallStart
        out[`${v.name}_fps`] = round(FRAMES / (wallMs / 1000))
        out[`${v.name}_stall`] = round(stallMs)
      } catch (err) {
        console.warn(`[exportlab] ${v.name} failed`, err)
        out[`${v.name}_fps`] = -2
      } finally {
        if (encoder.state !== 'closed') encoder.close()
      }
    }
  } finally {
    renderer.resumeAutoRender()
  }
  return out
}

function yieldNow(): Promise<void> {
  const s = (globalThis as unknown as { scheduler?: { yield?: () => Promise<void> } }).scheduler
  return s?.yield ? s.yield() : new Promise((r) => setTimeout(r, 0))
}

// ── audiorender: offline audio render cost per instrument ─────────────────
// How long the "Rendering audio" export stage takes relative to the piece
// (realtime factor), for a sampled instrument and a convolution-reverb synth.
async function suiteAudioRender(
  ctx: AppCtxValue,
  fixtureId: string,
): Promise<Record<string, number>> {
  const midi = await loadFixture(ctx, fixtureId)
  const { renderAudioOffline } = await import('../audio/OfflineAudioRenderer')
  const out: Record<string, number> = { durationS: round(midi.duration) }
  for (const id of ['piano', 'upright', 'bells', 'digital'] as const) {
    progress(`audiorender:${id}`)
    // Warm the sample cache so the number is the render, not the download.
    await renderAudioOffline({ midi: { ...midi, duration: 2 }, instrumentId: id, volume: 0.8 })
    const t0 = performance.now()
    await renderAudioOffline({ midi, instrumentId: id, volume: 0.8 })
    const ms = performance.now() - t0
    out[`${id}_ms`] = round(ms)
    out[`${id}_xRealtime`] = round(midi.duration / (ms / 1000))
  }
  return out
}

function heapMB(): number {
  const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
  return mem ? mem.usedJSHeapSize / (1024 * 1024) : 0
}

// ── entry point (called from main.tsx behind VITE_ENABLE_BENCH) ───────────

const SUITES: Record<
  BenchSuite,
  (ctx: AppCtxValue, fixture: string) => Promise<Record<string, number>>
> = {
  frame: suiteFrame,
  attribution: suiteAttribution,
  live: suiteLive,
  idle: suiteIdle,
  pacing: suitePacing,
  export: suiteExport,
  exportlab: suiteExportLab,
  audiorender: suiteAudioRender,
}

export async function maybeRunBench(ctx: AppCtxValue): Promise<void> {
  const params = new URLSearchParams(window.location.search)
  const suiteParam = params.get('bench')
  if (!suiteParam) return

  if (suiteParam === 'list') {
    window.__BENCH_FIXTURES = BENCH_FIXTURES.map((f) => f.id)
    return
  }

  try {
    const suite = suiteParam as BenchSuite
    const run = SUITES[suite]
    if (!run) throw new Error(`unknown bench suite: ${suiteParam}`)
    const fixture = params.get('fixture') ?? BENCH_FIXTURES[0]!.id
    const metrics = await run(ctx, fixture)
    window.__BENCH_RESULT = {
      schema: 2,
      suite,
      fixture,
      env: captureEnv(ctx),
      metrics,
    }
  } catch (err) {
    window.__BENCH_ERROR = err instanceof Error ? err.message : String(err)
    console.error('[bench]', err)
  }
}
