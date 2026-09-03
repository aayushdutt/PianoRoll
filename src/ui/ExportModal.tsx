import { createSignal, For, Show } from 'solid-js'
import { Portal, render } from 'solid-js/web'
import { overallProgress, type ProgressMode, stageEtaSeconds } from '../export/exportMath'
import type { ExportStage } from '../export/VideoExporter'
import { t } from '../i18n'
import { icons } from './icons'

// Supported export resolution presets. `match` keeps the current canvas size
// (whatever the user's window is) — useful for already-well-sized displays or
// for users who've tuned the window to look exactly how they want. `vertical`
// (1080×1920) and `square` (1080×1080) target TikTok/Reels/Shorts and
// Instagram feed respectively.
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

// Built lazily inside the view so each `t()` call is reactive — flipping
// locale at runtime swaps the labels/hints without remounting the modal.
interface PresetCard {
  id: ExportResolution
  label: string
  dim: string
  aspect: 'landscape' | 'vertical' | 'square' | 'match'
  hint?: string
}

// Chrome caps `navigator.deviceMemory` at 8, so ≤4 reliably means a genuinely
// constrained device. 2K/4K exports build the whole MP4 in memory — on these
// devices that's the top OOM suspect (PostHog: ~7% of exports die silently).
const LOW_MEMORY_DEVICE =
  ((navigator as unknown as { deviceMemory?: number }).deviceMemory ?? 8) <= 4

function buildPresets(): readonly PresetCard[] {
  const heavyHint = (base: string): string =>
    LOW_MEMORY_DEVICE ? `${base} · ${t('export.preset.lowMemory.hint')}` : base
  return [
    { id: '1080p', label: '1080p', dim: '1920 × 1080', aspect: 'landscape' },
    { id: '720p', label: '720p', dim: '1280 × 720', aspect: 'landscape' },
    {
      id: '2k',
      label: '2K',
      dim: '2560 × 1440',
      aspect: 'landscape',
      hint: heavyHint(t('export.preset.2k.hint')),
    },
    {
      id: '4k',
      label: '4K',
      dim: '3840 × 2160',
      aspect: 'landscape',
      hint: heavyHint(t('export.preset.4k.hint')),
    },
    {
      id: 'vertical',
      label: t('export.preset.vertical'),
      dim: '1080 × 1920',
      aspect: 'vertical',
      hint: t('export.preset.vertical.hint'),
    },
    {
      id: 'square',
      label: t('export.preset.square'),
      dim: '1080 × 1080',
      aspect: 'square',
      hint: t('export.preset.square.hint'),
    },
    {
      id: 'match',
      label: t('export.preset.match'),
      dim: t('export.preset.match.dim'),
      aspect: 'match',
    },
  ]
}

const FPS_OPTIONS = [24, 30, 60] as const

// Coarse-pointer devices are exactly where exports fail/crawl in the field
// (iOS 39% / Android 68% completion vs Mac 90%). Default them to 720p — the
// user can still pick anything.
function defaultResolution(): ExportResolution {
  return window.matchMedia?.('(pointer: coarse)').matches ? '720p' : '1080p'
}

type Phase = 'settings' | 'progress' | 'error'

interface ViewProps {
  container: HTMLElement
  isOpen: () => boolean
  phase: () => Phase
  fps: () => number
  setFps: (v: number) => void
  resolution: () => ExportResolution
  setResolution: (v: ExportResolution) => void
  output: () => ExportOutput
  setOutput: (v: ExportOutput) => void
  audioFormat: () => ExportAudioFormat
  setAudioFormat: (v: ExportAudioFormat) => void
  focus: () => ExportFocus
  setFocus: (v: ExportFocus) => void
  speed: () => ExportSpeed
  setSpeed: (v: ExportSpeed) => void
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

function ExportView(props: ViewProps) {
  const noVideo = (): boolean => props.output() === 'audio-only' || props.output() === 'midi'
  const isSocial = (): boolean =>
    !noVideo() && (props.resolution() === 'vertical' || props.resolution() === 'square')

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
        <div class="export-card modal-scroll">
          <div class="export-phase" classList={{ hidden: props.phase() !== 'settings' }}>
            <header class="export-header">
              <div class="export-card-icon" innerHTML={icons.film()} />
              <div class="export-header-text">
                <h2 class="export-card-title">{t('export.title')}</h2>
                <p class="export-card-sub">{t('export.sub')}</p>
              </div>
            </header>

            <section class="export-section">
              <span class="export-section-label">{t('export.outputLabel')}</span>
              <div class="fps-group out-group">
                <button
                  type="button"
                  class="fps-btn"
                  classList={{ 'fps-btn--on': props.output() === 'av' }}
                  onClick={() => props.setOutput('av')}
                >
                  {t('export.output.av')}
                </button>
                <button
                  type="button"
                  class="fps-btn"
                  classList={{ 'fps-btn--on': props.output() === 'video-only' }}
                  onClick={() => props.setOutput('video-only')}
                >
                  {t('export.output.video')}
                </button>
                <button
                  type="button"
                  class="fps-btn"
                  classList={{ 'fps-btn--on': props.output() === 'audio-only' }}
                  onClick={() => props.setOutput('audio-only')}
                >
                  {t('export.output.audio')}
                </button>
                <button
                  type="button"
                  class="fps-btn"
                  classList={{ 'fps-btn--on': props.output() === 'midi' }}
                  title={t('export.output.midi.tip')}
                  onClick={() => props.setOutput('midi')}
                >
                  {t('export.output.midi')}
                </button>
              </div>
            </section>

            <Show when={props.output() === 'audio-only'}>
              <section class="export-section">
                <span class="export-section-label">{t('export.formatLabel')}</span>
                <div class="fps-group">
                  <button
                    type="button"
                    class="fps-btn"
                    classList={{ 'fps-btn--on': props.audioFormat() === 'mp3' }}
                    onClick={() => props.setAudioFormat('mp3')}
                  >
                    MP3
                  </button>
                  <button
                    type="button"
                    class="fps-btn"
                    classList={{ 'fps-btn--on': props.audioFormat() === 'wav' }}
                    onClick={() => props.setAudioFormat('wav')}
                  >
                    WAV
                  </button>
                </div>
              </section>
            </Show>

            <section class="export-section" classList={{ 'export-section--disabled': noVideo() }}>
              <span class="export-section-label">{t('export.resolutionLabel')}</span>
              <div class="res-grid">
                <For each={buildPresets()}>
                  {(p) => (
                    <button
                      type="button"
                      class="res-card"
                      classList={{ 'res-card--on': props.resolution() === p.id }}
                      title={p.hint}
                      onClick={() => props.setResolution(p.id)}
                    >
                      <div class={`res-preview res-preview--${p.aspect}`} aria-hidden="true" />
                      <div class="res-card-label">{p.label}</div>
                      <div class="res-card-dim">{p.dim}</div>
                    </button>
                  )}
                </For>
              </div>
            </section>

            <section class="export-section" classList={{ 'export-section--disabled': noVideo() }}>
              <span class="export-section-label">{t('export.fpsLabel')}</span>
              <div class="fps-group">
                <For each={FPS_OPTIONS}>
                  {(fps) => (
                    <button
                      type="button"
                      class="fps-btn"
                      classList={{ 'fps-btn--on': props.fps() === fps }}
                      onClick={() => props.setFps(fps)}
                    >
                      {t('export.fps.unit', { fps })}
                    </button>
                  )}
                </For>
              </div>
            </section>

            <Show when={isSocial()}>
              <section class="export-section">
                <span class="export-section-label">{t('export.focusLabel')}</span>
                <div class="fps-group">
                  <button
                    type="button"
                    class="fps-btn"
                    classList={{ 'fps-btn--on': props.focus() === 'fit' }}
                    title={t('export.focus.fit.tip')}
                    onClick={() => props.setFocus('fit')}
                  >
                    {t('export.focus.fit')}
                  </button>
                  <button
                    type="button"
                    class="fps-btn"
                    classList={{ 'fps-btn--on': props.focus() === 'all' }}
                    title={t('export.focus.all.tip')}
                    onClick={() => props.setFocus('all')}
                  >
                    {t('export.focus.all')}
                  </button>
                </div>
              </section>

              <section class="export-section">
                <span class="export-section-label">{t('export.speedLabel')}</span>
                <div class="fps-group">
                  <button
                    type="button"
                    class="fps-btn"
                    classList={{ 'fps-btn--on': props.speed() === 'compact' }}
                    title={t('export.speed.compact.tip')}
                    onClick={() => props.setSpeed('compact')}
                  >
                    {t('export.speed.compact')}
                  </button>
                  <button
                    type="button"
                    class="fps-btn"
                    classList={{ 'fps-btn--on': props.speed() === 'standard' }}
                    title={t('export.speed.standard.tip')}
                    onClick={() => props.setSpeed('standard')}
                  >
                    {t('export.speed.standard')}
                  </button>
                  <button
                    type="button"
                    class="fps-btn"
                    classList={{ 'fps-btn--on': props.speed() === 'drama' }}
                    title={t('export.speed.drama.tip')}
                    onClick={() => props.setSpeed('drama')}
                  >
                    {t('export.speed.drama')}
                  </button>
                </div>
              </section>
            </Show>

            <div class="export-actions">
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
            </div>
          </div>

          <div
            class="export-phase"
            classList={{
              hidden: props.phase() !== 'progress',
              indeterminate: props.indeterminate(),
            }}
          >
            <div class="export-spinner"></div>
            <div class="export-stage">{props.stage()}</div>
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

          <div class="export-phase" classList={{ hidden: props.phase() !== 'error' }}>
            <div class="export-error-icon" aria-hidden="true">
              !
            </div>
            <h2 class="export-card-title">{t('export.error.title')}</h2>
            <p class="export-error-msg">{props.errorMessage()}</p>
            <div class="export-actions">
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
  private readonly setFps: (v: number) => void
  private readonly readFps: () => number
  private readonly setResolution: (v: ExportResolution) => void
  private readonly readResolution: () => ExportResolution
  private readonly setOutput: (v: ExportOutput) => void
  private readonly readOutput: () => ExportOutput
  private readonly setAudioFormat: (v: ExportAudioFormat) => void
  private readonly readAudioFormat: () => ExportAudioFormat
  private readonly setFocus: (v: ExportFocus) => void
  private readonly readFocus: () => ExportFocus
  private readonly setSpeed: (v: ExportSpeed) => void
  private readonly readSpeed: () => ExportSpeed
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

  constructor(container: HTMLElement) {
    const [isOpen, setIsOpen] = createSignal(false)
    const [phase, setPhase] = createSignal<Phase>('settings')
    const [fps, setFps] = createSignal(30)
    const [resolution, setResolution] = createSignal<ExportResolution>(defaultResolution())
    const [output, setOutput] = createSignal<ExportOutput>('av')
    const [audioFormat, setAudioFormat] = createSignal<ExportAudioFormat>('mp3')
    const [focus, setFocus] = createSignal<ExportFocus>('fit')
    const [speed, setSpeed] = createSignal<ExportSpeed>('drama')
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
    this.setFps = setFps
    this.readFps = fps
    this.setResolution = setResolution
    this.readResolution = resolution
    this.setOutput = setOutput
    this.readOutput = output
    this.setAudioFormat = setAudioFormat
    this.readAudioFormat = audioFormat
    this.setFocus = setFocus
    this.readFocus = focus
    this.setSpeed = setSpeed
    this.readSpeed = speed
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
          isOpen={isOpen}
          phase={phase}
          fps={fps}
          setFps={(v) => this.setFps(v)}
          resolution={resolution}
          setResolution={(v) => {
            this.setResolution(v)
            this.applyResolutionDefaults()
          }}
          output={output}
          setOutput={(v) => {
            this.setOutput(v)
            this.applyResolutionDefaults()
          }}
          audioFormat={audioFormat}
          setAudioFormat={(v) => this.setAudioFormat(v)}
          focus={focus}
          setFocus={(v) => this.setFocus(v)}
          speed={speed}
          setSpeed={(v) => this.setSpeed(v)}
          stage={stage}
          pct={pct}
          eta={eta}
          indeterminate={indeterminate}
          errorMessage={errorMessage}
          canRetryLower={canRetryLower}
          onDismiss={() => this.close()}
          onStart={() => this.startExport()}
          onRetryLower={() => {
            this.setResolution('720p')
            if (this.readFps() > 30) this.setFps(30)
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
    const output = this.readOutput()
    const isVideo = output === 'av' || output === 'video-only'
    this.setErrorMessage(message)
    this.setCanRetryLower(isVideo && this.readResolution() !== '720p')
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
    const settings: ExportSettings = {
      fps: this.readFps(),
      resolution: this.readResolution(),
      output: this.readOutput(),
      audioFormat: this.readAudioFormat(),
      focus: this.readFocus(),
      speed: this.readSpeed(),
    }
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

  // Only auto-applies a per-resolution default speed when the Focus/Speed
  // rows become visible — matches the pre-port behaviour where user choices
  // weren't overwritten on every click.
  private applyResolutionDefaults(): void {
    const noVideo = this.readOutput() === 'audio-only' || this.readOutput() === 'midi'
    const isSocial =
      !noVideo && (this.readResolution() === 'vertical' || this.readResolution() === 'square')
    if (isSocial) {
      const desiredSpeed: ExportSpeed = this.readResolution() === 'vertical' ? 'drama' : 'standard'
      this.setSpeed(desiredSpeed)
    }
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
