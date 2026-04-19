import type { ExportStage } from '../export/VideoExporter'
import { icons } from './icons'
import { Modal } from './primitives/Modal'

// Supported export resolution presets. `match` keeps the current canvas size
// (whatever the user's window is) — useful for already-well-sized displays or
// for users who've tuned the window to look exactly how they want. `vertical`
// (1080×1920) and `square` (1080×1080) target TikTok/Reels/Shorts and
// Instagram feed respectively.
export type ExportResolution = 'match' | '720p' | '1080p' | 'vertical' | 'square'
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

// Ordered so the default (1080p) is first and the social formats cluster
// together — matches how users scan the card grid.
const PRESETS: readonly PresetCard[] = [
  { id: '1080p', label: '1080p', dim: '1920 × 1080', aspect: 'landscape' },
  { id: '720p', label: '720p', dim: '1280 × 720', aspect: 'landscape' },
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

export class ExportModal {
  private modal: Modal
  private get el(): HTMLElement {
    return this.modal.el
  }
  private settingsPhase!: HTMLElement
  private progressPhase!: HTMLElement
  private progressBar!: HTMLElement
  private stageEl!: HTMLElement
  private pctEl!: HTMLElement
  private phase: 'settings' | 'progress' = 'settings'
  private selectedFps = 30
  private selectedResolution: ExportResolution = '1080p'
  private selectedOutput: ExportOutput = 'av'
  private selectedFocus: ExportFocus = 'fit'
  private selectedSpeed: ExportSpeed = 'drama'

  onStart?: (settings: ExportSettings) => void
  onCancel?: () => void

  constructor(container: HTMLElement) {
    const innerHTML = `
      <div class="export-card">

        <div class="export-phase" id="ep-settings">
          <header class="export-header">
            <div class="export-card-icon">${icons.film()}</div>
            <div class="export-header-text">
              <h2 class="export-card-title">Export MP4</h2>
              <p class="export-card-sub">Frame-accurate · audio baked in · fully offline</p>
            </div>
          </header>

          <section class="export-section">
            <span class="export-section-label">Output</span>
            <div class="fps-group out-group" id="out-group">
              <button class="fps-btn fps-btn--on" data-out="av">Video + audio</button>
              <button class="fps-btn" data-out="video-only">Video only</button>
              <button class="fps-btn" data-out="audio-only">Audio only</button>
              <button class="fps-btn" data-out="midi" title="Save the source .mid">MIDI</button>
            </div>
          </section>

          <section class="export-section" id="res-section">
            <span class="export-section-label">Resolution</span>
            <div class="res-grid" id="res-group">
              ${PRESETS.map(
                (p) => `
                <button class="res-card${p.id === '1080p' ? ' res-card--on' : ''}"
                        data-res="${p.id}"
                        ${p.hint ? `title="${p.hint}"` : ''}>
                  <div class="res-preview res-preview--${p.aspect}" aria-hidden="true"></div>
                  <div class="res-card-label">${p.label}</div>
                  <div class="res-card-dim">${p.dim}</div>
                </button>
              `,
              ).join('')}
            </div>
          </section>

          <section class="export-section" id="fps-section">
            <span class="export-section-label">Frame rate</span>
            <div class="fps-group" id="fps-group">
              <button class="fps-btn" data-fps="24">24 fps</button>
              <button class="fps-btn fps-btn--on" data-fps="30">30 fps</button>
              <button class="fps-btn" data-fps="60">60 fps</button>
            </div>
          </section>

          <section class="export-section" id="focus-section">
            <span class="export-section-label">Focus</span>
            <div class="fps-group" id="focus-group">
              <button class="fps-btn fps-btn--on" data-focus="fit" title="Zoom onto the piece's actual range">Fit to piece</button>
              <button class="fps-btn" data-focus="all" title="Show the full 88 keys">All 88 keys</button>
            </div>
          </section>

          <section class="export-section" id="speed-section">
            <span class="export-section-label">Speed</span>
            <div class="fps-group" id="speed-group">
              <button class="fps-btn" data-speed="compact" title="Tight — more notes on screen at once">Compact</button>
              <button class="fps-btn" data-speed="standard" title="Default pace">Standard</button>
              <button class="fps-btn fps-btn--on" data-speed="drama" title="Slower fall — cinematic">Drama</button>
            </div>
          </section>

          <div class="export-actions">
            <button class="modal-btn" id="ep-cancel-settings">Cancel</button>
            <button class="modal-btn modal-btn--accent" id="ep-start">
              ${icons.exportArrow()}
              <span>Export</span>
            </button>
          </div>
        </div>

        <div class="export-phase hidden" id="ep-progress">
          <div class="export-spinner"></div>
          <div class="export-stage" id="ep-stage">Preparing…</div>
          <div class="export-progress-wrap">
            <div class="export-progress-bar" id="ep-bar"></div>
          </div>
          <div class="export-pct" id="ep-pct">0%</div>
          <button class="modal-btn" id="ep-cancel-progress">Cancel</button>
        </div>

      </div>
    `
    // Escape / backdrop only dismiss during settings — mid-export use the
    // Cancel button so users don't lose work from a stray keystroke.
    this.modal = new Modal(container, 'export-modal', innerHTML, {
      onDismiss: () => {
        if (this.phase === 'settings') this.close()
      },
    })
    this.bindEvents()
  }

  private bindEvents(): void {
    this.settingsPhase = this.el.querySelector('#ep-settings')!
    this.progressPhase = this.el.querySelector('#ep-progress')!
    this.progressBar = this.el.querySelector('#ep-bar')!
    this.stageEl = this.el.querySelector('#ep-stage')!
    this.pctEl = this.el.querySelector('#ep-pct')!

    this.el.querySelectorAll<HTMLButtonElement>('#fps-group .fps-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.el.querySelectorAll('#fps-group .fps-btn').forEach((b) => {
          b.classList.remove('fps-btn--on')
        })
        btn.classList.add('fps-btn--on')
        this.selectedFps = parseInt(btn.dataset['fps']!, 10)
      })
    })

    this.el.querySelectorAll<HTMLButtonElement>('#res-group .res-card').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.el.querySelectorAll('#res-group .res-card').forEach((b) => {
          b.classList.remove('res-card--on')
        })
        btn.classList.add('res-card--on')
        this.selectedResolution = btn.dataset['res'] as ExportResolution
        this.applyResolutionDefaults()
      })
    })

    // Output selector — disables resolution + frame rate when audio-only.
    this.el.querySelectorAll<HTMLButtonElement>('#out-group .fps-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.el.querySelectorAll('#out-group .fps-btn').forEach((b) => {
          b.classList.remove('fps-btn--on')
        })
        btn.classList.add('fps-btn--on')
        this.selectedOutput = btn.dataset['out'] as ExportOutput
        this.applyOutputMode()
      })
    })

    this.el.querySelectorAll<HTMLButtonElement>('#focus-group .fps-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.el.querySelectorAll('#focus-group .fps-btn').forEach((b) => {
          b.classList.remove('fps-btn--on')
        })
        btn.classList.add('fps-btn--on')
        this.selectedFocus = btn.dataset['focus'] as ExportFocus
      })
    })

    this.el.querySelectorAll<HTMLButtonElement>('#speed-group .fps-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.el.querySelectorAll('#speed-group .fps-btn').forEach((b) => {
          b.classList.remove('fps-btn--on')
        })
        btn.classList.add('fps-btn--on')
        this.selectedSpeed = btn.dataset['speed'] as ExportSpeed
      })
    })

    this.el.querySelector('#ep-start')!.addEventListener('click', () => {
      this.showPhase('progress')
      this.onStart?.({
        fps: this.selectedFps,
        resolution: this.selectedResolution,
        output: this.selectedOutput,
        focus: this.selectedFocus,
        speed: this.selectedSpeed,
      })
    })

    this.el.querySelector('#ep-cancel-settings')!.addEventListener('click', () => this.close())
    this.el.querySelector('#ep-cancel-progress')!.addEventListener('click', () => this.onCancel?.())

    // Initial visibility — default 1080p hides Focus/Speed rows.
    this.applyResolutionDefaults()
  }

  open(): void {
    this.showPhase('settings')
    this.progressBar.style.width = '0%'
    this.pctEl.textContent = '0%'
    this.stageEl.textContent = 'Preparing…'
    this.modal.open()
  }

  close(): void {
    this.modal.close()
  }

  dispose(): void {
    this.modal.dispose()
  }

  updateProgress(stage: ExportStage, pct: number): void {
    this.stageEl.textContent = `${stage}…`
    // Rendering audio happens inside Tone.Offline with no progress hook we can
    // tap, so show an indeterminate shimmer instead of a misleading percent.
    const indeterminate = stage === 'Rendering audio'
    this.progressPhase.classList.toggle('indeterminate', indeterminate)
    if (indeterminate) {
      this.progressBar.style.width = ''
      this.pctEl.textContent = ''
    } else {
      this.progressBar.style.width = `${Math.round(pct * 100)}%`
      this.pctEl.textContent = `${Math.round(pct * 100)}%`
    }
  }

  private showPhase(phase: 'settings' | 'progress'): void {
    this.phase = phase
    this.settingsPhase.classList.toggle('hidden', phase !== 'settings')
    this.progressPhase.classList.toggle('hidden', phase !== 'progress')
  }

  // Toggles visual disable on resolution + frame rate for output modes that
  // don't use them (audio-only, midi). Encoder behavior is driven by
  // `selectedOutput`; this is purely UX feedback.
  private applyOutputMode(): void {
    const noVideo = this.selectedOutput === 'audio-only' || this.selectedOutput === 'midi'
    this.el.querySelector('#res-section')?.classList.toggle('export-section--disabled', noVideo)
    this.el.querySelector('#fps-section')?.classList.toggle('export-section--disabled', noVideo)
    this.applyResolutionDefaults()
  }

  // Focus + Speed only apply to the two social formats (vertical + square).
  // Hide them for landscape / match / audio / midi to keep the modal clean.
  private applyResolutionDefaults(): void {
    const noVideo = this.selectedOutput === 'audio-only' || this.selectedOutput === 'midi'
    const isSocial =
      !noVideo && (this.selectedResolution === 'vertical' || this.selectedResolution === 'square')
    this.el.querySelector('#focus-section')?.classList.toggle('hidden', !isSocial)
    this.el.querySelector('#speed-section')?.classList.toggle('hidden', !isSocial)

    // Per-resolution default: vertical leans dramatic, square leans standard.
    // Only flip when the user hasn't expressed a preference (we don't overwrite
    // on every click — just when the section re-appears).
    if (isSocial) {
      const desiredSpeed: ExportSpeed =
        this.selectedResolution === 'vertical' ? 'drama' : 'standard'
      this.setSpeed(desiredSpeed)
    }
  }

  private setSpeed(speed: ExportSpeed): void {
    this.selectedSpeed = speed
    this.el.querySelectorAll<HTMLButtonElement>('#speed-group .fps-btn').forEach((btn) => {
      btn.classList.toggle('fps-btn--on', btn.dataset['speed'] === speed)
    })
  }
}
