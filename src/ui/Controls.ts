import type { appState } from '../store/state'
import type { MasterClock } from '../core/clock/MasterClock'
import type { Theme } from '../renderer/theme'
import { escHtml } from './utils'

type State = typeof appState

const SKIP_SECONDS = 10
export const ZOOM_MIN = 80
export const ZOOM_MAX = 600
export const ZOOM_DEFAULT = 200

export interface ControlsOptions {
  container: HTMLElement
  state: State
  clock: MasterClock
  onSeek?: (t: number) => void
  onLoadNew?: () => void
  onZoom?: (pixelsPerSecond: number) => void
  onThemeCycle?: () => void
  onExport?: () => void
}

export class Controls {
  private el: HTMLElement
  private scrubber!: HTMLInputElement
  private playBtn!: HTMLButtonElement
  private timeDisplay!: HTMLElement
  private npTitle!: HTMLElement
  private themeBtn!: HTMLButtonElement
  private isScrubbing = false

  private state: State
  private clock: MasterClock
  private opts: ControlsOptions

  constructor(opts: ControlsOptions) {
    this.opts = opts
    this.state = opts.state
    this.clock = opts.clock

    this.el = this.build()
    opts.container.appendChild(this.el)
    this.bindEvents()
    this.bindState()
  }

  private build(): HTMLElement {
    const el = document.createElement('div')
    el.id = 'controls'
    el.innerHTML = `
      <div class="controls-card">
        <div class="controls-header">
          <span class="np-title" id="ctrl-title">
            <span class="np-placeholder">No file loaded</span>
          </span>
          <div class="controls-header-actions">
            <button class="ctrl-icon-btn" id="ctrl-theme" title="Cycle theme">
              <span class="theme-dot" id="ctrl-theme-dot"></span>
            </button>
            <button class="ctrl-btn ctrl-btn--accent" id="ctrl-export">
              ${ICON_VIDEO}
              Record MP4
            </button>
            <button class="ctrl-btn" id="ctrl-load-new">
              ${ICON_UPLOAD}
              Load new
            </button>
          </div>
        </div>

        <div class="controls-body">
          <button class="btn-skip" id="ctrl-skip-back" title="Back 10s">
            ${ICON_SKIP_BACK}
          </button>

          <button class="btn-play" id="ctrl-play" aria-label="Play">
            ${ICON_PLAY}
          </button>

          <button class="btn-skip" id="ctrl-skip-fwd" title="Forward 10s">
            ${ICON_SKIP_FWD}
          </button>

          <div class="ctrl-divider"></div>

          <div class="scrubber-wrap">
            <span class="time-display" id="ctrl-time">0:00</span>
            <input type="range" id="ctrl-scrubber" class="scrubber"
              min="0" max="100" step="0.1" value="0" />
            <span class="time-display dim" id="ctrl-duration">0:00</span>
          </div>

          <div class="ctrl-divider"></div>

          <div class="ctrl-group">
            <span class="ctrl-icon">${ICON_VOLUME}</span>
            <input type="range" id="ctrl-volume" class="mini-slider"
              min="0" max="1" step="0.02" value="0.8" />
          </div>

          <div class="ctrl-group">
            <span class="speed-val" id="ctrl-speed-val">1x</span>
            <input type="range" id="ctrl-speed" class="mini-slider"
              min="0.25" max="2" step="0.05" value="1" />
          </div>

          <div class="ctrl-divider"></div>

          <div class="ctrl-group">
            <span class="ctrl-icon">${ICON_ZOOM}</span>
            <input type="range" id="ctrl-zoom" class="mini-slider mini-slider--zoom"
              min="${ZOOM_MIN}" max="${ZOOM_MAX}" step="10" value="${ZOOM_DEFAULT}" />
          </div>
        </div>
      </div>
    `
    return el
  }

  private bindEvents(): void {
    this.playBtn    = this.el.querySelector<HTMLButtonElement>('#ctrl-play')!
    this.scrubber   = this.el.querySelector<HTMLInputElement>('#ctrl-scrubber')!
    this.timeDisplay = this.el.querySelector<HTMLElement>('#ctrl-time')!
    this.npTitle     = this.el.querySelector<HTMLElement>('#ctrl-title')!
    this.themeBtn    = this.el.querySelector<HTMLButtonElement>('#ctrl-theme')!

    // Play / pause
    this.playBtn.addEventListener('click', () => {
      const s = this.state.status.value
      if (s === 'playing') {
        this.clock.pause()
        this.state.status.set('paused')
      } else if (s === 'paused' || s === 'ready') {
        this.clock.play()
        this.state.status.set('playing')
      }
    })

    // Skip
    this.el.querySelector('#ctrl-skip-back')!.addEventListener('click', () => {
      const t = Math.max(0, this.clock.currentTime - SKIP_SECONDS)
      this.clock.seek(t)
      this.opts.onSeek?.(t)
    })

    this.el.querySelector('#ctrl-skip-fwd')!.addEventListener('click', () => {
      const t = Math.min(this.state.duration.value, this.clock.currentTime + SKIP_SECONDS)
      this.clock.seek(t)
      this.opts.onSeek?.(t)
    })

    // Scrubber
    this.scrubber.addEventListener('mousedown', () => { this.isScrubbing = true })
    this.scrubber.addEventListener('touchstart', () => { this.isScrubbing = true }, { passive: true })

    this.scrubber.addEventListener('input', () => {
      const t = parseFloat(this.scrubber.value)
      this.timeDisplay.textContent = formatTime(t)
      this.updateFill(t)
    })

    this.scrubber.addEventListener('change', () => {
      this.isScrubbing = false
      const t = parseFloat(this.scrubber.value)
      this.clock.seek(t)
      this.opts.onSeek?.(t)
    })

    // Volume
    this.el.querySelector<HTMLInputElement>('#ctrl-volume')!.addEventListener('input', (e) => {
      this.state.volume.set(parseFloat((e.target as HTMLInputElement).value))
    })

    // Speed
    const speedSlider = this.el.querySelector<HTMLInputElement>('#ctrl-speed')!
    const speedVal    = this.el.querySelector<HTMLElement>('#ctrl-speed-val')!
    speedSlider.addEventListener('input', () => {
      const s = parseFloat(speedSlider.value)
      speedVal.textContent = formatSpeed(s)
      this.state.speed.set(s)
    })

    // Zoom
    this.el.querySelector<HTMLInputElement>('#ctrl-zoom')!.addEventListener('input', (e) => {
      const pps = parseFloat((e.target as HTMLInputElement).value)
      this.opts.onZoom?.(pps)
    })

    // Theme cycle
    this.themeBtn.addEventListener('click', () => {
      this.opts.onThemeCycle?.()
    })

    // Export
    this.el.querySelector('#ctrl-export')!.addEventListener('click', () => {
      this.opts.onExport?.()
    })

    // Load new
    this.el.querySelector('#ctrl-load-new')!.addEventListener('click', () => {
      this.opts.onLoadNew?.()
    })

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return
      if (e.code === 'Space') {
        e.preventDefault()
        this.playBtn.click()
      }
      if (e.code === 'ArrowLeft') {
        e.preventDefault()
        this.el.querySelector<HTMLButtonElement>('#ctrl-skip-back')!.click()
      }
      if (e.code === 'ArrowRight') {
        e.preventDefault()
        this.el.querySelector<HTMLButtonElement>('#ctrl-skip-fwd')!.click()
      }
    })
  }

  private bindState(): void {
    this.clock.subscribe((t) => {
      if (this.isScrubbing) return
      const dur = this.state.duration.value

      this.scrubber.value = String(t)
      this.timeDisplay.textContent = formatTime(t)
      this.updateFill(t)

      if (dur > 0 && t >= dur) {
        this.clock.pause()
        this.clock.seek(0)
        this.state.status.set('ready')
      }
    })

    this.state.duration.subscribe((d) => {
      this.scrubber.max = String(d)
      this.el.querySelector<HTMLElement>('#ctrl-duration')!.textContent = formatTime(d)
    })

    this.state.status.subscribe((s) => {
      this.playBtn.innerHTML = s === 'playing' ? ICON_PAUSE : ICON_PLAY
      this.el.classList.toggle('is-ready', s !== 'idle' && s !== 'loading')
      this.el.classList.toggle('is-playing', s === 'playing')
      this.el.classList.toggle('is-exporting', s === 'exporting')
    })
  }

  setFileName(name: string): void {
    this.npTitle.innerHTML = `<strong>${escHtml(name)}</strong>`
  }

  updateThemeDot(color: string): void {
    const dot = this.el.querySelector<HTMLElement>('#ctrl-theme-dot')
    if (dot) dot.style.background = color
  }

  private updateFill(t: number): void {
    const dur = this.state.duration.value
    const pct = dur > 0 ? Math.min((t / dur) * 100, 100) : 0
    this.scrubber.style.setProperty('--pct', `${pct}%`)
  }

  show(): void { this.el.classList.remove('hidden') }
  hide(): void { this.el.classList.add('hidden') }
}

function formatTime(s: number): string {
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${sec.toString().padStart(2, '0')}`
}

function formatSpeed(s: number): string {
  if (s === 1) return '1x'
  return `${s % 1 === 0 ? s : s.toFixed(2).replace(/0+$/, '')}x`
}

const ICON_PLAY = `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
  <polygon points="6 3 20 12 6 21 6 3"/>
</svg>`

const ICON_PAUSE = `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
  <rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>
</svg>`

const ICON_SKIP_BACK = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <polygon points="19 20 9 12 19 4 19 20"/>
  <line x1="5" y1="19" x2="5" y2="5"/>
</svg>`

const ICON_SKIP_FWD = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <polygon points="5 4 15 12 5 20 5 4"/>
  <line x1="19" y1="5" x2="19" y2="19"/>
</svg>`

const ICON_UPLOAD = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
  <polyline points="17 8 12 3 7 8"/>
  <line x1="12" y1="3" x2="12" y2="15"/>
</svg>`

const ICON_VOLUME = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
  <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
</svg>`

const ICON_ZOOM = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <circle cx="11" cy="11" r="8"/>
  <line x1="21" y1="21" x2="16.65" y2="16.65"/>
  <line x1="11" y1="8" x2="11" y2="14"/>
  <line x1="8" y1="11" x2="14" y2="11"/>
</svg>`

const ICON_VIDEO = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <polygon points="23 7 16 12 23 17 23 7"/>
  <rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
</svg>`
