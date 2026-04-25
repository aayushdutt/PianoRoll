import { createSignal, For, Show } from 'solid-js'
import { Portal, render } from 'solid-js/web'
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

export interface ExportSettings {
  fps: number
  resolution: ExportResolution
  output: ExportOutput
  focus: ExportFocus
  speed: ExportSpeed
}

interface PresetCard {
  id: ExportResolution
  label: string
  dim: string
  aspect: 'landscape' | 'vertical' | 'square' | 'match'
  hint?: string
}

const PRESETS: readonly PresetCard[] = [
  { id: '1080p', label: '1080p', dim: '1920 × 1080', aspect: 'landscape' },
  { id: '720p', label: '720p', dim: '1280 × 720', aspect: 'landscape' },
  { id: '2k', label: '2K', dim: '2560 × 1440', aspect: 'landscape', hint: 'YouTube QHD' },
  { id: '4k', label: '4K', dim: '3840 × 2160', aspect: 'landscape', hint: 'slow · big file' },
  {
    id: 'vertical',
    label: 'Vertical',
    dim: '1080 × 1920',
    aspect: 'vertical',
    hint: 'TikTok / Reels / Shorts',
  },
  { id: 'square', label: 'Square', dim: '1080 × 1080', aspect: 'square', hint: 'Instagram feed' },
  { id: 'match', label: 'Match', dim: 'Current size', aspect: 'match' },
]

const FPS_OPTIONS = [24, 30, 60] as const

type Phase = 'settings' | 'progress'

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
  focus: () => ExportFocus
  setFocus: (v: ExportFocus) => void
  speed: () => ExportSpeed
  setSpeed: (v: ExportSpeed) => void
  stage: () => string
  pct: () => number
  indeterminate: () => boolean
  onDismiss: () => void
  onStart: () => void
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
          if (e.target === e.currentTarget && props.phase() === 'settings') props.onDismiss()
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

            <section class="export-section" classList={{ 'export-section--disabled': noVideo() }}>
              <span class="export-section-label">{t('export.resolutionLabel')}</span>
              <div class="res-grid">
                <For each={PRESETS}>
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
                      {fps} fps
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
            <button type="button" class="modal-btn" onClick={() => props.onCancelProgress()}>
              {t('export.cancel')}
            </button>
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
  private readonly setFocus: (v: ExportFocus) => void
  private readonly readFocus: () => ExportFocus
  private readonly setSpeed: (v: ExportSpeed) => void
  private readonly readSpeed: () => ExportSpeed
  private readonly setStage: (v: string) => void
  private readonly setPct: (v: number) => void
  private readonly setIndet: (v: boolean) => void

  private onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return
    if (!this.readIsOpen()) return
    if (this.readPhase() !== 'settings') return
    this.close()
  }

  onStart?: (settings: ExportSettings) => void
  onCancel?: () => void

  /** `null` until the offline render reports whether the browser can emit % progress. */
  private renderAudioProgressDeterminate: boolean | null = null

  constructor(container: HTMLElement) {
    const [isOpen, setIsOpen] = createSignal(false)
    const [phase, setPhase] = createSignal<Phase>('settings')
    const [fps, setFps] = createSignal(30)
    const [resolution, setResolution] = createSignal<ExportResolution>('1080p')
    const [output, setOutput] = createSignal<ExportOutput>('av')
    const [focus, setFocus] = createSignal<ExportFocus>('fit')
    const [speed, setSpeed] = createSignal<ExportSpeed>('drama')
    const [stage, setStage] = createSignal(t('export.preparing'))
    const [pct, setPct] = createSignal(0)
    const [indeterminate, setIndet] = createSignal(false)

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
    this.setFocus = setFocus
    this.readFocus = focus
    this.setSpeed = setSpeed
    this.readSpeed = speed
    this.setStage = setStage
    this.setPct = setPct
    this.setIndet = setIndet

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
          focus={focus}
          setFocus={(v) => this.setFocus(v)}
          speed={speed}
          setSpeed={(v) => this.setSpeed(v)}
          stage={stage}
          pct={pct}
          indeterminate={indeterminate}
          onDismiss={() => this.close()}
          onStart={() => {
            this.setPhase('progress')
            this.onStart?.({
              fps: this.readFps(),
              resolution: this.readResolution(),
              output: this.readOutput(),
              focus: this.readFocus(),
              speed: this.readSpeed(),
            })
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
    this.renderAudioProgressDeterminate = null
    this.setPhase('settings')
    this.setPct(0)
    this.setIndet(false)
    this.setStage(t('export.preparing'))
    this.setIsOpen(true)
  }

  close(): void {
    this.setIsOpen(false)
  }

  /**
   * Called from `renderAudioOffline` after `OfflineAudioContext` is ready.
   * @param determinate false when the browser has no `suspend` hook — `onProgress` never runs.
   */
  setRenderAudioProgressMode(determinate: boolean): void {
    this.renderAudioProgressDeterminate = determinate
    this.setIndet(!determinate)
    if (determinate) this.setPct(0)
  }

  updateProgress(stage: ExportStage, pct: number): void {
    this.setStage(`${stage}…`)
    if (stage === 'Rendering audio') {
      if (this.renderAudioProgressDeterminate === true) {
        this.setIndet(false)
        this.setPct(pct)
        return
      }
      this.setIndet(true)
      this.setPct(0)
      return
    }
    this.setIndet(false)
    this.setPct(pct)
  }

  dispose(): void {
    document.removeEventListener('keydown', this.onKey)
    this.disposeRoot?.()
    this.disposeRoot = null
    this.wrapper?.remove()
    this.wrapper = null
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
