import type { appState } from '../store/state'
import type { MasterClock } from '../core/clock/MasterClock'
import type { MidiDeviceStatus } from '../midi/MidiInputManager'
import { escHtml } from './utils'

type State = typeof appState

const SKIP_SECONDS = 10
export const ZOOM_MIN = 80
export const ZOOM_MAX = 600
export const ZOOM_DEFAULT = 200
const IDLE_MS = 2500

export interface ControlsOptions {
  container: HTMLElement
  state: State
  clock: MasterClock
  onSeek?: (t: number) => void
  onZoom?: (pps: number) => void
  onThemeCycle?: () => void
  onMidiConnect?: () => void
  onOpenTracks?: () => void
  onRecord?: () => void
}

export class Controls {
  private topStrip!: HTMLElement
  private hud!: HTMLElement
  private playBtn!: HTMLButtonElement
  private scrubber!: HTMLInputElement
  private timeDisplay!: HTMLElement
  private midiBtn!: HTMLButtonElement
  private isScrubbing = false
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private onMouseMoveDoc = (): void => { if (this.hud.classList.contains('hud--active')) this.wakeUp() }
  private onKeyDownDoc  = (e: KeyboardEvent): void => this.handleKey(e)

  constructor(private opts: ControlsOptions) {
    this.buildTopStrip()
    this.buildHud()
    this.bindEvents()
    this.bindState()
    document.addEventListener('mousemove', this.onMouseMoveDoc)
    document.addEventListener('keydown', this.onKeyDownDoc)
  }

  // ── Build ──────────────────────────────────────────────────────────────────

  private buildTopStrip(): void {
    const el = document.createElement('div')
    el.id = 'top-strip'
    el.innerHTML = `
      <button class="ts-btn" id="ts-tracks" title="Tracks" aria-label="Open track list">
        ${ICON_TRACKS}
      </button>
      <div class="ts-center">
        <span class="ts-title" id="ts-title">
          <span class="ts-placeholder">No file loaded</span>
        </span>
        <div class="ts-bars" aria-hidden="true">
          <span></span><span></span><span></span><span></span>
        </div>
      </div>
      <div class="ts-end">
        <button class="ts-btn midi-btn" id="ts-midi" title="Connect MIDI keyboard" aria-label="Connect MIDI keyboard">
          ${ICON_MIDI}
        </button>
        <button class="ts-btn ts-theme-btn" id="ts-theme" title="Cycle theme" aria-label="Cycle theme">
          <span class="theme-dot" id="ts-theme-dot"></span>
        </button>
        <button class="ts-record-btn" id="ts-record" aria-label="Record MP4">
          ${ICON_RECORD}
          <span>Record</span>
        </button>
      </div>
    `
    this.opts.container.appendChild(el)
    this.topStrip = el
  }

  private buildHud(): void {
    const el = document.createElement('div')
    el.id = 'hud'
    el.innerHTML = `
      <div class="hud-bar">
        <button class="btn-skip" id="hud-skip-back" title="Back 10s">${ICON_SKIP_BACK}</button>
        <button class="btn-play" id="hud-play" aria-label="Play">${ICON_PLAY}</button>
        <button class="btn-skip" id="hud-skip-fwd" title="Forward 10s">${ICON_SKIP_FWD}</button>

        <div class="hud-divider"></div>

        <div class="scrubber-wrap">
          <span class="time-display" id="hud-time">0:00</span>
          <input type="range" id="hud-scrubber" class="scrubber"
            min="0" max="100" step="0.1" value="0" />
          <span class="time-display dim" id="hud-duration">0:00</span>
        </div>

        <div class="hud-divider"></div>

        <div class="ctrl-group">
          <span class="ctrl-icon">${ICON_VOLUME}</span>
          <input type="range" id="hud-volume" class="mini-slider"
            min="0" max="1" step="0.02" value="0.8" />
        </div>

        <div class="ctrl-group">
          <span class="speed-val" id="hud-speed-val">1x</span>
          <input type="range" id="hud-speed" class="mini-slider"
            min="0.25" max="2" step="0.05" value="1" />
        </div>

        <div class="hud-divider"></div>

        <div class="ctrl-group">
          <span class="ctrl-icon">${ICON_ZOOM}</span>
          <input type="range" id="hud-zoom" class="mini-slider mini-slider--zoom"
            min="${ZOOM_MIN}" max="${ZOOM_MAX}" step="10" value="${ZOOM_DEFAULT}" />
        </div>
      </div>
    `
    this.opts.container.appendChild(el)
    this.hud = el
  }

  // ── Events ────────────────────────────────────────────────────────────────

  private bindEvents(): void {
    const { state, clock, onSeek, onZoom } = this.opts

    this.playBtn     = this.hud.querySelector<HTMLButtonElement>('#hud-play')!
    this.scrubber    = this.hud.querySelector<HTMLInputElement>('#hud-scrubber')!
    this.timeDisplay = this.hud.querySelector<HTMLElement>('#hud-time')!
    this.midiBtn     = this.topStrip.querySelector<HTMLButtonElement>('#ts-midi')!

    // Play / pause
    this.playBtn.addEventListener('click', () => {
      const s = state.status.value
      if (s === 'playing') {
        clock.pause(); state.status.set('paused')
      } else if (s === 'paused' || s === 'ready') {
        clock.play(); state.status.set('playing')
      }
    })

    // Skip
    this.hud.querySelector('#hud-skip-back')!.addEventListener('click', () => {
      const t = Math.max(0, clock.currentTime - SKIP_SECONDS)
      clock.seek(t); onSeek?.(t)
    })
    this.hud.querySelector('#hud-skip-fwd')!.addEventListener('click', () => {
      const t = Math.min(state.duration.value, clock.currentTime + SKIP_SECONDS)
      clock.seek(t); onSeek?.(t)
    })

    // Scrubber
    this.scrubber.addEventListener('mousedown', () => {
      this.isScrubbing = true
      this.wakeUp()  // ensure HUD visible while scrubbing even if it auto-hid
    })
    this.scrubber.addEventListener('touchstart', () => { this.isScrubbing = true }, { passive: true })
    this.scrubber.addEventListener('input', () => {
      const t = parseFloat(this.scrubber.value)
      this.timeDisplay.textContent = formatTime(t)
      this.updateFill(t)
    })
    this.scrubber.addEventListener('change', () => {
      this.isScrubbing = false
      const t = parseFloat(this.scrubber.value)
      clock.seek(t); onSeek?.(t)
    })

    // Volume
    this.hud.querySelector<HTMLInputElement>('#hud-volume')!.addEventListener('input', (e) => {
      state.volume.set(parseFloat((e.target as HTMLInputElement).value))
    })

    // Speed
    const speedSlider = this.hud.querySelector<HTMLInputElement>('#hud-speed')!
    const speedVal    = this.hud.querySelector<HTMLElement>('#hud-speed-val')!
    speedSlider.addEventListener('input', () => {
      const s = parseFloat(speedSlider.value)
      speedVal.textContent = formatSpeed(s)
      state.speed.set(s)
    })

    // Zoom
    this.hud.querySelector<HTMLInputElement>('#hud-zoom')!.addEventListener('input', (e) => {
      onZoom?.(parseFloat((e.target as HTMLInputElement).value))
    })

    // Top strip
    this.topStrip.querySelector('#ts-theme')!.addEventListener('click', () => this.opts.onThemeCycle?.())
    this.midiBtn.addEventListener('click', () => this.opts.onMidiConnect?.())
    this.topStrip.querySelector('#ts-tracks')!.addEventListener('click', () => this.opts.onOpenTracks?.())
    this.topStrip.querySelector('#ts-record')!.addEventListener('click', () => this.opts.onRecord?.())
  }

  private handleKey(e: KeyboardEvent): void {
    if ((e.target as HTMLElement).tagName === 'INPUT') return
    if (e.code === 'Space') {
      e.preventDefault()
      this.playBtn.click()
    } else if (e.code === 'ArrowLeft') {
      e.preventDefault()
      this.hud.querySelector<HTMLButtonElement>('#hud-skip-back')!.click()
    } else if (e.code === 'ArrowRight') {
      e.preventDefault()
      this.hud.querySelector<HTMLButtonElement>('#hud-skip-fwd')!.click()
    } else if (e.code === 'KeyT') {
      if (this.hud.classList.contains('hud--active')) this.opts.onOpenTracks?.()
    } else if (e.code === 'KeyR') {
      if (this.hud.classList.contains('hud--active') && !this.hud.classList.contains('hud--exporting')) {
        this.opts.onRecord?.()
      }
    }
  }

  // ── State ─────────────────────────────────────────────────────────────────

  private bindState(): void {
    const { state, clock } = this.opts

    clock.subscribe((t) => {
      if (this.isScrubbing) return
      const dur = state.duration.value
      this.scrubber.value = String(t)
      this.timeDisplay.textContent = formatTime(t)
      this.updateFill(t)

      if (dur > 0 && t >= dur) {
        clock.pause()
        clock.seek(0)
        state.status.set('ready')
      }
    })

    state.duration.subscribe((d) => {
      this.scrubber.max = String(d)
      this.hud.querySelector<HTMLElement>('#hud-duration')!.textContent = formatTime(d)
    })

    state.status.subscribe((s) => {
      // Visibility: show controls whenever something is loaded or live; hide on idle/loading
      const active = s !== 'idle' && s !== 'loading'
      this.topStrip.classList.toggle('strip--active', active)
      this.hud.classList.toggle('hud--active', active)

      this.playBtn.innerHTML = s === 'playing' ? ICON_PAUSE : ICON_PLAY
      this.hud.classList.toggle('hud--playing',       s === 'playing')
      this.hud.classList.toggle('hud--exporting',     s === 'exporting')
      this.topStrip.classList.toggle('strip--playing',   s === 'playing')
      this.topStrip.classList.toggle('strip--exporting', s === 'exporting')
      if (s === 'playing') {
        this.scheduleIdle()
      } else {
        this.clearIdle()
      }
    })
  }

  // ── Auto-hide ─────────────────────────────────────────────────────────────

  private wakeUp(): void {
    this.topStrip.classList.remove('strip--dim')
    this.hud.classList.remove('hud--idle')
    this.scheduleIdle()
  }

  private scheduleIdle(): void {
    this.clearIdle()
    if (this.opts.state.status.value !== 'playing') return
    this.idleTimer = setTimeout(() => {
      if (!this.isScrubbing) {
        this.topStrip.classList.add('strip--dim')
        this.hud.classList.add('hud--idle')
      }
    }, IDLE_MS)
  }

  private clearIdle(): void {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null }
    this.topStrip.classList.remove('strip--dim')
    this.hud.classList.remove('hud--idle')
  }

  // ── Public API ────────────────────────────────────────────────────────────

  setFileName(name: string): void {
    const titleEl = this.topStrip.querySelector<HTMLElement>('#ts-title')!
    titleEl.innerHTML = `<strong>${escHtml(name)}</strong>`
  }

  setLiveTitle(): void {
    const titleEl = this.topStrip.querySelector<HTMLElement>('#ts-title')!
    titleEl.innerHTML = `<span class="ts-live-badge">Live</span>`
  }

  updateThemeDot(color: string): void {
    const dot = this.topStrip.querySelector<HTMLElement>('#ts-theme-dot')
    if (dot) dot.style.background = color
  }

  updateMidiStatus(status: MidiDeviceStatus, deviceName: string): void {
    this.midiBtn.dataset['midiStatus'] = status
    const label = status === 'connected'
      ? `MIDI: ${deviceName || 'Connected'}`
      : status === 'unavailable'
        ? 'Web MIDI not supported'
        : 'Connect MIDI keyboard'
    this.midiBtn.title = label
    this.midiBtn.setAttribute('aria-label', label)
    this.midiBtn.classList.toggle('midi-unavailable', status === 'unavailable')
    this.midiBtn.classList.toggle('midi-connected',   status === 'connected')
  }

  dispose(): void {
    document.removeEventListener('mousemove', this.onMouseMoveDoc)
    document.removeEventListener('keydown', this.onKeyDownDoc)
    this.clearIdle()
  }

  private updateFill(t: number): void {
    const dur = this.opts.state.duration.value
    const pct = dur > 0 ? Math.min((t / dur) * 100, 100) : 0
    this.scrubber.style.setProperty('--pct', `${pct}%`)
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function formatTime(s: number): string {
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${sec.toString().padStart(2, '0')}`
}

function formatSpeed(s: number): string {
  if (s === 1) return '1x'
  return `${s % 1 === 0 ? s : s.toFixed(2).replace(/0+$/, '')}x`
}

// ── Icons ──────────────────────────────────────────────────────────────────

const ICON_TRACKS = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
  <line x1="4" y1="6" x2="20" y2="6"/>
  <line x1="4" y1="12" x2="20" y2="12"/>
  <line x1="4" y1="18" x2="20" y2="18"/>
</svg>`

const ICON_MIDI = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <rect x="2" y="4" width="20" height="16" rx="2"/>
  <line x1="2" y1="14" x2="22" y2="14"/>
  <line x1="7" y1="4"  x2="7"  y2="14"/>
  <line x1="12" y1="4" x2="12" y2="14"/>
  <line x1="17" y1="4" x2="17" y2="14"/>
  <rect x="5"  y="4" width="3" height="6" rx="1" fill="currentColor" stroke="none"/>
  <rect x="10" y="4" width="3" height="6" rx="1" fill="currentColor" stroke="none"/>
  <rect x="15" y="4" width="3" height="6" rx="1" fill="currentColor" stroke="none"/>
</svg>`

const ICON_RECORD = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <circle cx="12" cy="12" r="4" fill="currentColor" stroke="none"/>
  <circle cx="12" cy="12" r="9"/>
</svg>`

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
