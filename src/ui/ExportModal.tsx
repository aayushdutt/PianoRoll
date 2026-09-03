import { createEffect, createSignal, For, on, onCleanup, Show } from 'solid-js'
import { createStore } from 'solid-js/store'
import { Portal, render } from 'solid-js/web'
import type { MidiFile } from '../core/midi/types'
import { overallProgress, type ProgressMode, stageEtaSeconds } from '../export/exportMath'
import type { ExportStage } from '../export/VideoExporter'
import { t } from '../i18n'
import {
  activityBuckets,
  type ExportDest,
  type ExportFormat,
  type ExportFps,
  type ExportQuality,
  type ExportUiState,
  estimateBytes,
  estimateSeconds,
  FORMATS,
  FPS_OPTIONS,
  LARGE_EXPORT_BYTES,
  previewDims,
  QUALITIES,
  resolutionFor,
  THROUGHPUT_KEY,
  toExportSettings,
} from './exportSettings'
import { icons } from './icons'

// The export dialog. Three destinations (Video · Audio · MIDI) as tabs; the
// Video tab shows a real rendered frame of the piece at the chosen format
// next to the settings, with the caption carrying the honest numbers
// (dimensions, fps, and — once this device has measured one export — how long
// it takes here). Audio and MIDI reuse the same two-column shape with a glyph
// on the stage, so switching tabs never resizes the card. Layout: two columns
// on desktop, one column under 760px, bottom sheet on phones — see .export-*
// in main.css.
//
// `ExportSettings` is the contract with App.startExport and is unchanged; the
// dialog's own state (`ExportUiState`) maps onto it in exportSettings.ts.

export type ExportResolution = 'match' | '720p' | '1080p' | '2k' | '4k' | 'vertical' | 'square'
export type ExportOutput = 'av' | 'video-only' | 'audio-only' | 'midi'
export type ExportFocus = 'fit' | 'all'
export type ExportSpeed = 'compact' | 'standard' | 'drama'
// Standalone audio export format. MP3 = compressed (~1/9th of WAV); WAV = lossless.
// Both are macOS-Gatekeeper-safe (unlike the MP4-container .m4a they replaced).
export type ExportAudioFormat = 'mp3' | 'wav'

export interface ExportSettings {
  fps: number
  resolution: ExportResolution
  output: ExportOutput
  focus: ExportFocus
  speed: ExportSpeed
  audioFormat: ExportAudioFormat
}

// What the dialog needs from the app to draw the preview and the caption.
export interface ExportModalDeps {
  pieceDuration: () => number
  canvasSize: () => { width: number; height: number }
  renderPreview: (settings: ExportSettings, maxWidth: number) => Promise<ImageBitmap | null>
  /** The loaded piece — drives the Audio/MIDI stage drawings and detail rows. */
  piece: () => MidiFile | null
  /** Display name of the voice the audio export will render with. */
  instrumentName: () => string
}

// Chrome caps `navigator.deviceMemory` at 8, so ≤4 reliably means a genuinely
// constrained device. 2K/4K previews allocate the full backing store for one
// frame; on these devices the preview renders at half size instead.
const LOW_MEMORY_DEVICE =
  ((navigator as unknown as { deviceMemory?: number }).deviceMemory ?? 8) <= 4

// Coarse-pointer devices are exactly where exports fail/crawl in the field
// (iOS 39% / Android 68% completion vs Mac 90%). Default them to 720p — the
// user can still pick anything.
function defaultQuality(): ExportQuality {
  return window.matchMedia?.('(pointer: coarse)').matches ? '720p' : '1080p'
}

const PREVIEW_MAX_WIDTH = 640
const PREVIEW_DEBOUNCE_MS = 120
const WAVEFORM_BARS = 56

type Phase = 'settings' | 'progress' | 'error'

interface ViewProps {
  container: HTMLElement
  deps: ExportModalDeps
  isOpen: () => boolean
  phase: () => Phase
  ui: ExportUiState
  set: <K extends keyof ExportUiState>(key: K, value: ExportUiState[K]) => void
  // Increments on open so the preview re-renders for a new piece.
  openCount: () => number
  stage: () => string
  pct: () => number
  eta: () => string
  indeterminate: () => boolean
  errorMessage: () => string
  canRetryLower: () => boolean
  onDismiss: () => void
  onStart: () => void
  onRetryLower: () => void
  onCancelProgress: () => void
}

function readThroughput(): number | null {
  try {
    const raw = localStorage.getItem(THROUGHPUT_KEY)
    const n = raw === null ? Number.NaN : Number(raw)
    return Number.isFinite(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

function formatDuration(sec: number): string {
  const total = Math.max(0, Math.round(sec))
  return `${Math.floor(total / 60)}:${(total % 60).toString().padStart(2, '0')}`
}

// Honest numbers for the Audio caption: lamejs runs CBR 192 (src/export/mp3.ts)
// and the offline render is 44.1 kHz, which audioBufferToWav writes as 16-bit.
const AUDIO_SPEC: Record<ExportAudioFormat, string> = {
  mp3: '192 kbps',
  wav: '16-bit 44.1 kHz',
}

// Stage size used before layout has measured the canvas (first paint of a tab).
const STAGE_FALLBACK = { width: 300, height: 169 }

/** Size the backing store to the laid-out box and return CSS-pixel dimensions. */
function fitCanvas(canvas: HTMLCanvasElement): { w: number; h: number; dpr: number } {
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const w = canvas.clientWidth || STAGE_FALLBACK.width
  const h = canvas.clientHeight || STAGE_FALLBACK.height
  canvas.width = Math.round(w * dpr)
  canvas.height = Math.round(h * dpr)
  return { w, h, dpr }
}

function readAccent(el: Element): string {
  return getComputedStyle(el).getPropertyValue('--accent').trim() || '#6366f1'
}

/** Two-column spec sheet shared by the Audio and MIDI tabs. */
function Details(props: { rows: readonly { k: string; v: string }[] }) {
  return (
    <dl class="export-kv">
      <For each={props.rows}>
        {(row) => (
          <div class="export-kv-row">
            <dt class="export-kv-k">{row.k}</dt>
            <dd class="export-kv-v">{row.v}</dd>
          </div>
        )}
      </For>
    </dl>
  )
}

function Segmented<T extends string | number>(props: {
  value: () => T
  options: readonly T[]
  label: (v: T) => string
  tip?: (v: T) => string | undefined
  disabled?: () => boolean
  onChange: (v: T) => void
}) {
  return (
    <div class="fps-group export-seg" aria-disabled={props.disabled?.()}>
      <For each={props.options}>
        {(v) => (
          <button
            type="button"
            class="fps-btn"
            aria-pressed={props.value() === v}
            classList={{ 'fps-btn--on': props.value() === v }}
            title={props.tip?.(v)}
            disabled={props.disabled?.()}
            onClick={() => props.onChange(v)}
          >
            {props.label(v)}
          </button>
        )}
      </For>
    </div>
  )
}

function ExportView(props: ViewProps) {
  const ui = props.ui
  const isSocial = (): boolean => ui.format !== 'landscape'
  const settings = (): ExportSettings => toExportSettings(ui)
  const dims = (): { width: number; height: number } => previewDims(ui, props.deps.canvasSize())

  // ── Preview ──────────────────────────────────────────────────────────────
  let stageCanvas: HTMLCanvasElement | undefined
  const [previewReady, setPreviewReady] = createSignal(false)
  let previewTimer: ReturnType<typeof setTimeout> | null = null
  let previewSeq = 0

  const drawPreview = async (): Promise<void> => {
    const seq = ++previewSeq
    const s = settings()
    const maxWidth = LOW_MEMORY_DEVICE ? PREVIEW_MAX_WIDTH / 2 : PREVIEW_MAX_WIDTH
    let bitmap: ImageBitmap | null = null
    try {
      bitmap = await props.deps.renderPreview(s, maxWidth)
    } catch (err) {
      console.warn('Export preview failed', err)
    }
    if (seq !== previewSeq || !stageCanvas) {
      bitmap?.close()
      return
    }
    if (!bitmap) {
      setPreviewReady(false)
      return
    }
    stageCanvas.width = bitmap.width
    stageCanvas.height = bitmap.height
    stageCanvas.getContext('2d')?.drawImage(bitmap, 0, 0)
    bitmap.close()
    setPreviewReady(true)
  }

  // Re-render on anything that changes the frame; debounced so a quick run
  // of clicks costs one render. Framing/fall only matter for social formats.
  createEffect(
    on(
      () => [
        props.isOpen(),
        props.openCount(),
        ui.dest,
        ui.format,
        ui.quality,
        isSocial() ? ui.focus : null,
        isSocial() ? ui.speed : null,
      ],
      () => {
        if (!props.isOpen() || ui.dest !== 'video') return
        if (previewTimer) clearTimeout(previewTimer)
        previewTimer = setTimeout(() => {
          previewTimer = null
          void drawPreview()
        }, PREVIEW_DEBOUNCE_MS)
      },
    ),
  )
  onCleanup(() => {
    if (previewTimer) clearTimeout(previewTimer)
  })

  // ── Audio / MIDI stage drawings ──────────────────────────────────────────
  // No frame to render for these two, so the stage shows the piece itself.
  // Geometry is pure (exportSettings.ts); here we only stroke it.
  let waveCanvas: HTMLCanvasElement | undefined

  const drawWaveform = (): void => {
    const canvas = waveCanvas
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    const { w, h, dpr } = fitCanvas(canvas)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    // ~56 bars across 300px: a bar every 5px reads as a waveform, not a
    // barcode. Values are compressed so one held chord doesn't dwarf the
    // rest, smoothed with their neighbours, then renormalised to the peak.
    const raw = activityBuckets(props.deps.piece(), WAVEFORM_BARS).map((v) => v ** 0.7)
    const smoothed = raw.map((v, i) => {
      const l = raw[i - 1] ?? v
      const r = raw[i + 1] ?? v
      return (l + 2 * v + r) / 4
    })
    const peak = Math.max(1e-6, ...smoothed)
    const bars = smoothed.map((v) => v / peak)
    const padX = 14
    const slot = (w - padX * 2) / bars.length
    const barW = Math.max(2, slot * 0.55)
    const mid = h / 2
    const reach = h / 2 - 22
    const accent = readAccent(canvas)
    // Faint centre line ties the bars together and reads as the baseline.
    ctx.fillStyle = accent
    ctx.globalAlpha = 0.14
    ctx.fillRect(padX, mid - 0.5, w - padX * 2, 1)
    for (let i = 0; i < bars.length; i++) {
      const v = bars[i] ?? 0
      const half = Math.max(barW / 2, v * reach)
      const x = padX + i * slot + (slot - barW) / 2
      ctx.globalAlpha = 0.28 + 0.62 * v
      ctx.beginPath()
      ctx.roundRect(x, mid - half, barW, half * 2, barW / 2)
      ctx.fill()
    }
    ctx.globalAlpha = 1
  }

  // Same open/dest/piece trigger the video preview uses. `queueMicrotask` lets
  // the <Show> swap land in the DOM (and get laid out) before we measure it.
  createEffect(
    on(
      () => [props.isOpen(), props.openCount(), ui.dest, props.deps.piece()],
      () => {
        if (!props.isOpen()) return
        if (ui.dest === 'audio') queueMicrotask(drawWaveform)
      },
    ),
  )

  const trackCount = (): string => String(props.deps.piece()?.tracks.length ?? 0)
  const noteCount = (): number =>
    (props.deps.piece()?.tracks ?? []).reduce((n, track) => n + track.notes.length, 0)

  // ── Caption ──────────────────────────────────────────────────────────────
  // Line 2 is empty until an export on this device has been timed — the
  // caption reserves its height in CSS so it never shifts when it appears.
  const caption = (): { specs: string; time: string; large: boolean } => {
    const d = dims()
    const duration = props.deps.pieceDuration()
    const secs = estimateSeconds(readThroughput(), d, ui.fps, duration)
    const bytes = estimateBytes(resolutionFor(ui.format, ui.quality), duration, ui.includeAudio)
    return {
      specs: [`${d.width} × ${d.height}`, t('export.fps.unit', { fps: ui.fps })].join(' · '),
      time:
        secs === null
          ? ''
          : secs < 50
            ? t('export.est.soon')
            : t('export.est.minutes', { min: Math.ceil(secs / 60) }),
      // The whole MP4 is assembled in memory before download; past ~1 GB
      // that is a real risk on a small machine, so say so.
      large: bytes > LARGE_EXPORT_BYTES,
    }
  }

  const tabs: readonly ExportDest[] = ['video', 'audio', 'midi']

  return (
    <Portal mount={props.container}>
      {/* biome-ignore-start lint/a11y/useKeyWithClickEvents: modal backdrop — Escape is wired at document level */}
      {/* biome-ignore-start lint/a11y/noStaticElementInteractions: modal backdrop, click dismisses */}
      <div
        id="export-modal"
        classList={{ open: props.isOpen() }}
        onClick={(e) => {
          if (e.target === e.currentTarget && props.phase() !== 'progress') props.onDismiss()
        }}
      >
        {/* biome-ignore-end lint/a11y/useKeyWithClickEvents: — */}
        {/* biome-ignore-end lint/a11y/noStaticElementInteractions: — */}
        <div class="export-card modal-scroll" data-phase={props.phase()} data-dest={ui.dest}>
          <div
            class="export-phase export-settings"
            classList={{ hidden: props.phase() !== 'settings' }}
          >
            <header class="export-head">
              <h2 class="export-card-title">{t('export.title')}</h2>
              <div class="export-tabs" role="tablist">
                <For each={tabs}>
                  {(d) => (
                    <button
                      type="button"
                      role="tab"
                      class="export-tab"
                      aria-selected={ui.dest === d}
                      classList={{ 'export-tab--on': ui.dest === d }}
                      onClick={() => props.set('dest', d)}
                    >
                      {t(`export.tab.${d}`)}
                    </button>
                  )}
                </For>
              </div>
              <button
                type="button"
                class="export-close"
                aria-label={t('export.cancel')}
                innerHTML={icons.close(14)}
                onClick={() => props.onDismiss()}
              />
            </header>

            <div class="export-body">
              {/* ── Video ── */}
              <Show when={ui.dest === 'video'}>
                <div class="export-preview">
                  <div class="export-stage" data-aspect={ui.format}>
                    <canvas
                      ref={stageCanvas}
                      class="export-stage-canvas"
                      classList={{ 'export-stage-canvas--ready': previewReady() }}
                      role="img"
                      aria-label={caption().specs}
                    />
                  </div>
                  <p class="export-caption">
                    <span>{caption().specs}</span>
                    <span
                      class="export-caption-time"
                      classList={{ 'export-caption-warn': caption().large }}
                    >
                      {caption().large ? t('export.warn.large') : caption().time}
                    </span>
                  </p>
                </div>

                <div class="export-rows">
                  <div class="export-row">
                    <span class="export-row-label">{t('export.format')}</span>
                    <Segmented<ExportFormat>
                      value={() => ui.format}
                      options={FORMATS}
                      label={(f) => t(`export.format.${f}`)}
                      tip={(f) => t(`export.format.${f}.tip`)}
                      onChange={(f) => props.set('format', f)}
                    />
                  </div>
                  <div class="export-row" classList={{ 'export-row--off': isSocial() }}>
                    <span class="export-row-label">{t('export.quality')}</span>
                    <Segmented<ExportQuality>
                      value={() => ui.quality}
                      options={QUALITIES}
                      label={(q) =>
                        q === 'match'
                          ? t('export.quality.window')
                          : q === '2k'
                            ? '2K'
                            : q === '4k'
                              ? '4K'
                              : q
                      }
                      tip={(q) =>
                        q === 'match'
                          ? t('export.quality.window.tip')
                          : q === '4k' && LOW_MEMORY_DEVICE
                            ? t('export.preset.lowMemory.hint')
                            : undefined
                      }
                      disabled={isSocial}
                      onChange={(q) => props.set('quality', q)}
                    />
                    <Show when={isSocial()}>
                      <span class="export-row-note">{t('export.quality.social')}</span>
                    </Show>
                  </div>
                  <div class="export-row">
                    <span class="export-row-label">{t('export.motion')}</span>
                    <Segmented<ExportFps>
                      value={() => ui.fps}
                      options={FPS_OPTIONS}
                      label={(f) => t('export.fps.unit', { fps: f })}
                      onChange={(f) => props.set('fps', f)}
                    />
                    <button
                      type="button"
                      class="export-toggle"
                      role="switch"
                      aria-checked={ui.includeAudio}
                      classList={{ 'export-toggle--on': ui.includeAudio }}
                      onClick={() => props.set('includeAudio', !ui.includeAudio)}
                    >
                      <span class="export-toggle-knob" />
                      {t('export.includeAudio')}
                    </button>
                  </div>
                  <div class="export-social" classList={{ 'export-social--open': isSocial() }}>
                    <div class="export-social-inner">
                      <div class="export-row">
                        <span class="export-row-label">{t('export.framing')}</span>
                        <Segmented<ExportFocus>
                          value={() => ui.focus}
                          options={['fit', 'all'] as const}
                          label={(f) => t(`export.focus.${f}`)}
                          tip={(f) => t(`export.focus.${f}.tip`)}
                          onChange={(f) => props.set('focus', f)}
                        />
                      </div>
                      <div class="export-row">
                        <span class="export-row-label">{t('export.fall')}</span>
                        <Segmented<ExportSpeed>
                          value={() => ui.speed}
                          options={['compact', 'standard', 'drama'] as const}
                          label={(s) => t(`export.speed.${s}`)}
                          tip={(s) => t(`export.speed.${s}.tip`)}
                          onChange={(s) => props.set('speed', s)}
                        />
                      </div>
                    </div>
                  </div>
                </div>
              </Show>

              {/* ── Audio ── */}
              <Show when={ui.dest === 'audio'}>
                <div class="export-preview">
                  <div class="export-stage">
                    <canvas
                      ref={(el) => {
                        waveCanvas = el
                        queueMicrotask(drawWaveform)
                      }}
                      class="export-stage-canvas export-stage-canvas--thumb"
                      role="img"
                      aria-label={t('export.tab.audio')}
                    />
                  </div>
                  <p class="export-caption">
                    <span>
                      {[
                        formatDuration(props.deps.pieceDuration()),
                        ui.audioFormat.toUpperCase(),
                        AUDIO_SPEC[ui.audioFormat],
                      ].join(' · ')}
                    </span>
                    <span class="export-caption-time" />
                  </p>
                </div>

                <div class="export-rows">
                  <div class="export-row">
                    <span class="export-row-label">{t('export.audioFormat')}</span>
                    <div class="export-choices">
                      <For each={['mp3', 'wav'] as const}>
                        {(f) => (
                          <button
                            type="button"
                            class="export-choice"
                            aria-pressed={ui.audioFormat === f}
                            classList={{ 'export-choice--on': ui.audioFormat === f }}
                            onClick={() => props.set('audioFormat', f)}
                          >
                            <span class="export-choice-title">{f.toUpperCase()}</span>
                            <span class="export-choice-hint">{t(`export.audio.${f}.hint`)}</span>
                          </button>
                        )}
                      </For>
                    </div>
                  </div>
                  <div class="export-row">
                    <span class="export-row-label">{t('export.details')}</span>
                    <Details
                      rows={[
                        {
                          k: t('export.kv.duration'),
                          v: formatDuration(props.deps.pieceDuration()),
                        },
                        { k: t('export.kv.instrument'), v: props.deps.instrumentName() },
                        { k: t('export.kv.tracks'), v: trackCount() },
                      ]}
                    />
                  </div>
                </div>
              </Show>

              {/* ── MIDI ── */}
              <Show when={ui.dest === 'midi'}>
                <div class="export-preview">
                  <div class="export-stage export-stage--file">
                    <span class="export-file-icon" innerHTML={icons.midi(30)} />
                    <span class="export-file-name">{`${props.deps.piece()?.name ?? ''}.mid`}</span>
                  </div>
                  <p class="export-caption">
                    <span class="export-caption-line">
                      <span class="export-caption-name">{props.deps.piece()?.name ?? ''}</span>
                      <span class="export-caption-sep">·</span>
                      <span>{formatDuration(props.deps.pieceDuration())}</span>
                    </span>
                    <span class="export-caption-time" />
                  </p>
                </div>

                <div class="export-rows">
                  <div class="export-row">
                    <span class="export-row-label">{t('export.details')}</span>
                    <Details
                      rows={[
                        { k: t('export.kv.file'), v: `${props.deps.piece()?.name ?? ''}.mid` },
                        {
                          k: t('export.kv.duration'),
                          v: formatDuration(props.deps.pieceDuration()),
                        },
                        { k: t('export.kv.tracks'), v: trackCount() },
                        { k: t('export.kv.notes'), v: String(noteCount()) },
                        {
                          k: t('export.kv.tempo'),
                          v: `${Math.round(props.deps.piece()?.bpm ?? 0)} bpm`,
                        },
                      ]}
                    />
                  </div>
                </div>
              </Show>
            </div>

            <footer class="export-actions">
              <button type="button" class="modal-btn" onClick={() => props.onDismiss()}>
                {t('export.cancel')}
              </button>
              <button
                type="button"
                class="modal-btn modal-btn--accent"
                onClick={() => props.onStart()}
              >
                <span innerHTML={icons.exportArrow()} />
                <span>{t('export.action')}</span>
              </button>
            </footer>
          </div>

          <div
            class="export-phase export-progress"
            classList={{
              hidden: props.phase() !== 'progress',
              indeterminate: props.indeterminate(),
            }}
          >
            <div class="export-spinner"></div>
            <div class="export-stage-label">{props.stage()}</div>
            <div class="export-progress-wrap">
              <div
                class="export-progress-bar"
                style={{ width: props.indeterminate() ? '' : `${Math.round(props.pct() * 100)}%` }}
              />
            </div>
            <div class="export-pct">
              {props.indeterminate() ? '' : `${Math.round(props.pct() * 100)}%`}
            </div>
            <Show when={props.eta()}>
              <div class="export-eta">{props.eta()}</div>
            </Show>
            <button type="button" class="modal-btn" onClick={() => props.onCancelProgress()}>
              {t('export.cancel')}
            </button>
          </div>

          <div
            class="export-phase export-progress"
            classList={{ hidden: props.phase() !== 'error' }}
          >
            <div class="export-error-icon" aria-hidden="true">
              !
            </div>
            <h2 class="export-card-title">{t('export.error.title')}</h2>
            <p class="export-error-msg">{props.errorMessage()}</p>
            <div class="export-actions export-actions--center">
              <button type="button" class="modal-btn" onClick={() => props.onDismiss()}>
                {t('export.error.close')}
              </button>
              <Show when={props.canRetryLower()}>
                <button
                  type="button"
                  class="modal-btn modal-btn--accent"
                  onClick={() => props.onRetryLower()}
                >
                  {t('export.error.retry720')}
                </button>
              </Show>
            </div>
          </div>
        </div>
      </div>
    </Portal>
  )
}

export class ExportModal {
  private disposeRoot: (() => void) | null = null
  private wrapper: HTMLDivElement | null = null

  private readonly setIsOpen: (v: boolean) => void
  private readonly readIsOpen: () => boolean
  private readonly setPhase: (v: Phase) => void
  private readonly readPhase: () => Phase
  private readonly bumpOpenCount: () => void
  private readonly ui: ExportUiState
  private readonly setUi: <K extends keyof ExportUiState>(key: K, value: ExportUiState[K]) => void
  private readonly setStage: (v: string) => void
  private readonly setPct: (v: number) => void
  private readonly readPct: () => number
  private readonly setEta: (v: string) => void
  private readonly setIndet: (v: boolean) => void
  private readonly setErrorMessage: (v: string) => void
  private readonly setCanRetryLower: (v: boolean) => void

  private onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return
    if (!this.readIsOpen()) return
    if (this.readPhase() === 'progress') return
    this.close()
  }

  onStart?: (settings: ExportSettings) => void
  onCancel?: () => void

  /** `null` until the offline render reports whether the browser can emit % progress. */
  private renderAudioProgressDeterminate: boolean | null = null

  // Staged-progress state. `progressMode` keys the stage→window mapping;
  // `currentStage`/`stageStartedAt` drive the ETA; the pct signal is clamped
  // monotonic so retries and stage flips never move the bar backwards.
  private progressMode: ProgressMode | null = null
  private currentStage: ExportStage | null = null
  private stageStartedAt = 0

  constructor(container: HTMLElement, deps: ExportModalDeps) {
    const [isOpen, setIsOpen] = createSignal(false)
    const [phase, setPhase] = createSignal<Phase>('settings')
    const [openCount, setOpenCount] = createSignal(0)
    const [ui, setUi] = createStore<ExportUiState>({
      dest: 'video',
      format: 'landscape',
      quality: defaultQuality(),
      fps: 30,
      includeAudio: true,
      focus: 'fit',
      speed: 'drama',
      audioFormat: 'mp3',
    })
    const [stage, setStage] = createSignal(t('export.preparing'))
    const [pct, setPct] = createSignal(0)
    const [eta, setEta] = createSignal('')
    const [indeterminate, setIndet] = createSignal(false)
    const [errorMessage, setErrorMessage] = createSignal('')
    const [canRetryLower, setCanRetryLower] = createSignal(false)

    this.setIsOpen = setIsOpen
    this.readIsOpen = isOpen
    this.setPhase = setPhase
    this.readPhase = phase
    this.bumpOpenCount = () => setOpenCount((n) => n + 1)
    this.ui = ui
    this.setUi = (key, value) => setUi(key, value)
    this.setStage = setStage
    this.setPct = setPct
    this.readPct = pct
    this.setEta = setEta
    this.setIndet = setIndet
    this.setErrorMessage = setErrorMessage
    this.setCanRetryLower = setCanRetryLower

    const wrapper = document.createElement('div')
    wrapper.style.display = 'contents'
    container.appendChild(wrapper)
    this.wrapper = wrapper
    this.disposeRoot = render(
      () => (
        <ExportView
          container={container}
          deps={deps}
          isOpen={isOpen}
          phase={phase}
          ui={ui}
          set={(key, value) => {
            this.setUi(key, value)
            // Vertical reads best with the slow "drama" fall; square with
            // standard. Applied when the format changes, never on every click,
            // so a deliberate choice sticks.
            if (key === 'format') {
              if (value === 'vertical') this.setUi('speed', 'drama')
              else if (value === 'square') this.setUi('speed', 'standard')
            }
          }}
          openCount={openCount}
          stage={stage}
          pct={pct}
          eta={eta}
          indeterminate={indeterminate}
          errorMessage={errorMessage}
          canRetryLower={canRetryLower}
          onDismiss={() => this.close()}
          onStart={() => this.startExport()}
          onRetryLower={() => {
            this.setUi('format', 'landscape')
            this.setUi('quality', '720p')
            if (this.ui.fps > 30) this.setUi('fps', 30)
            this.startExport()
          }}
          onCancelProgress={() => this.onCancel?.()}
        />
      ),
      wrapper,
    )

    // Attach Escape listener at construction, gated via isOpen + phase.
    // Mirrors the old Modal primitive behaviour.
    document.addEventListener('keydown', this.onKey)
  }

  open(): void {
    this.resetProgressState()
    this.setPhase('settings')
    this.bumpOpenCount()
    this.setIsOpen(true)
  }

  close(): void {
    this.setIsOpen(false)
  }

  /**
   * Failure endpoint: keeps the modal open on an error phase instead of the
   * old silent close+toast, and offers a one-click 720p retry when the failed
   * attempt was a video export at a higher resolution.
   */
  showFailure(message: string): void {
    const isVideo = this.ui.dest === 'video'
    this.setErrorMessage(message)
    this.setCanRetryLower(isVideo && resolutionFor(this.ui.format, this.ui.quality) !== '720p')
    this.setPhase('error')
  }

  /**
   * Called from `renderAudioOffline` after `OfflineAudioContext` is ready.
   * @param determinate false when the browser has no `suspend` hook — `onProgress` never runs.
   */
  setRenderAudioProgressMode(determinate: boolean): void {
    this.renderAudioProgressDeterminate = determinate
    this.setIndet(!determinate)
  }

  updateProgress(stage: ExportStage, pct: number): void {
    if (stage !== this.currentStage) {
      this.currentStage = stage
      this.stageStartedAt = performance.now()
    }
    this.setStage(`${stageLabel(stage)}…`)

    const mode = this.progressMode

    // Audio render without the suspend API can't report % — bar animates
    // indeterminate for that stage, then snaps determinate when video starts.
    const indet = stage === 'Rendering audio' && this.renderAudioProgressDeterminate !== true
    this.setIndet(indet)
    const stagePct = indet ? 0 : pct

    if (mode) {
      // Monotonic: a software-fallback retry restarts the encode stage at 0 -
      // the bar holds its high-water mark instead of jumping backwards.
      this.setPct(Math.max(this.readPct(), overallProgress(mode, stage, stagePct)))
    } else {
      this.setPct(Math.max(this.readPct(), stagePct))
    }

    // ETA only for the long stages, from the stage-local rate.
    const etaEligible = stage === 'Encoding' || (stage === 'Rendering audio' && !indet)
    const etaS = etaEligible ? stageEtaSeconds(performance.now() - this.stageStartedAt, pct) : null
    this.setEta(etaS === null ? '' : formatEta(etaS))
  }

  dispose(): void {
    document.removeEventListener('keydown', this.onKey)
    this.disposeRoot?.()
    this.disposeRoot = null
    this.wrapper?.remove()
    this.wrapper = null
  }

  private startExport(): void {
    const settings = toExportSettings(this.ui)
    this.resetProgressState()
    this.progressMode = settings.output === 'midi' ? null : settings.output
    this.setPhase('progress')
    this.onStart?.(settings)
  }

  private resetProgressState(): void {
    this.renderAudioProgressDeterminate = null
    this.progressMode = null
    this.currentStage = null
    this.stageStartedAt = 0
    this.setPct(0)
    this.setIndet(false)
    this.setEta('')
    this.setStage(t('export.preparing'))
    this.setErrorMessage('')
    this.setCanRetryLower(false)
  }
}

function formatEta(seconds: number): string {
  if (seconds < 50) return t('export.eta.soon')
  return t('export.eta.minutes', { min: Math.ceil(seconds / 60) })
}

// `ExportStage` values are the canonical English keys used by the encoder
// pipeline — translate them at the surface so the progress card reads in
// the active locale without leaking i18n into the encoder module.
function stageLabel(stage: ExportStage): string {
  switch (stage) {
    case 'Rendering audio':
      return t('export.stage.renderingAudio')
    case 'Encoding audio':
      return t('export.stage.encodingAudio')
    case 'Encoding':
      return t('export.stage.encoding')
    case 'Finalizing':
      return t('export.stage.finalizing')
    case 'Saving':
      return t('export.stage.saving')
    case 'Done':
      return t('export.stage.done')
  }
}
