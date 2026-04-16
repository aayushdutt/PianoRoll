import type { appState, AppMode } from '../store/state'
import type { MasterClock } from '../core/clock/MasterClock'
import type { MidiDeviceStatus } from '../midi/MidiInputManager'

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
  onOpenFile?: () => void
  onModeRequest?: (mode: Exclude<AppMode, 'home'>) => void
}

export class Controls {
  private topStrip!: HTMLElement
  private hud!: HTMLElement
  private keyHint!: HTMLElement
  private playBtn!: HTMLButtonElement
  private scrubber!: HTMLInputElement
  private timeDisplay!: HTMLElement
  private durationEl!: HTMLElement
  private midiBtn!: HTMLButtonElement
  private midiLabelEl!: HTMLElement
  private titleEl!: HTMLElement
  private kickerEl!: HTMLElement
  private openBtn!: HTMLButtonElement
  private tracksBtn!: HTMLButtonElement
  private recordBtn!: HTMLButtonElement
  private fileModeBtn!: HTMLButtonElement
  private liveModeBtn!: HTMLButtonElement
  private hudDragHandle!: HTMLButtonElement
  private themeBtn!: HTMLButtonElement
  private themeLabelEl!: HTMLElement
  private octaveEl!: HTMLElement
  private isScrubbing = false
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private currentMidiStatus: MidiDeviceStatus = 'disconnected'
  private currentMidiDeviceName = ''
  private hudOffsetX = 0
  private hudOffsetY = 0
  private isDraggingHud = false
  private hudDragStartX = 0
  private hudDragStartY = 0
  private hudDragOriginX = 0
  private hudDragOriginY = 0
  private onMouseMoveDoc = (): void => {
    if (this.hud.classList.contains('hud--active')) this.wakeUp()
  }
  private onKeyDownDoc = (e: KeyboardEvent): void => this.handleKey(e)
  private onPointerMoveDoc = (e: PointerEvent): void => this.handleHudDragMove(e)
  private onPointerUpDoc = (): void => this.stopHudDrag()
  private onWindowResize = (): void => this.clampHudOffset()

  constructor(private opts: ControlsOptions) {
    this.buildTopStrip()
    this.buildHud()
    this.buildKeyHint()
    this.bindEvents()
    this.bindState()
    document.addEventListener('mousemove', this.onMouseMoveDoc)
    document.addEventListener('keydown', this.onKeyDownDoc)
    window.addEventListener('resize', this.onWindowResize)
  }

  private buildTopStrip(): void {
    const el = document.createElement('div')
    el.id = 'top-strip'
    el.innerHTML = `
      <div class="ts-left">
        <div class="mode-switch" aria-label="Mode">
          <button class="mode-btn" id="ts-mode-file" type="button">File</button>
          <button class="mode-btn" id="ts-mode-live" type="button">Live</button>
        </div>
        <button class="ts-action-btn" id="ts-open" type="button">Open MIDI</button>
        <button class="ts-btn" id="ts-tracks" title="Tracks" aria-label="Open track list">
          ${ICON_TRACKS}
        </button>
      </div>

      <div class="ts-center">
        <div class="ts-kicker" id="ts-kicker">Choose a mode</div>
        <div class="ts-title-row">
          <span class="ts-title" id="ts-title">
            <span class="ts-placeholder">Open MIDI or play live</span>
          </span>
          <div class="ts-bars" aria-hidden="true">
            <span></span><span></span><span></span><span></span>
          </div>
        </div>
      </div>

      <div class="ts-end">
        <button class="midi-chip" id="ts-midi" type="button" aria-label="Enable MIDI">
          ${ICON_MIDI}
          <span id="ts-midi-label">Enable MIDI</span>
        </button>
        <button class="ts-theme-btn" id="ts-theme" title="Cycle theme" aria-label="Cycle theme">
          <span class="theme-dot" id="ts-theme-dot"></span>
          <span class="theme-label" id="ts-theme-label">Theme</span>
        </button>
        <button class="ts-record-btn" id="ts-record" type="button" aria-label="Record MP4">
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
        <button class="hud-drag-handle" id="hud-drag" type="button" aria-label="Move controls">
          ${ICON_GRIP}
        </button>
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

  private buildKeyHint(): void {
    const el = document.createElement('div')
    el.id = 'key-hint'
    el.innerHTML = `
      <div class="kh-body">
        <div class="kh-row">
          <span class="kh-section">Keys</span>
          <span class="kh-map">
            <kbd>A</kbd><kbd>W</kbd><kbd>S</kbd><kbd>E</kbd><kbd>D</kbd>
            <span class="kh-dots">· · ·</span>
          </span>
          <span class="kh-section kh-section--muted">or plug in MIDI</span>
        </div>
        <div class="kh-row">
          <span class="kh-section">Octave</span>
          <span class="kh-map">
            <kbd>↓</kbd><kbd>↑</kbd>
            <span class="kh-current" id="kh-octave">C4</span>
          </span>
        </div>
      </div>
    `
    this.opts.container.appendChild(el)
    this.keyHint = el
    this.octaveEl = el.querySelector<HTMLElement>('#kh-octave')!
  }

  private bindEvents(): void {
    const { state, clock, onSeek, onZoom } = this.opts

    this.playBtn = this.hud.querySelector<HTMLButtonElement>('#hud-play')!
    this.scrubber = this.hud.querySelector<HTMLInputElement>('#hud-scrubber')!
    this.timeDisplay = this.hud.querySelector<HTMLElement>('#hud-time')!
    this.durationEl = this.hud.querySelector<HTMLElement>('#hud-duration')!
    this.midiBtn = this.topStrip.querySelector<HTMLButtonElement>('#ts-midi')!
    this.midiLabelEl = this.topStrip.querySelector<HTMLElement>('#ts-midi-label')!
    this.titleEl = this.topStrip.querySelector<HTMLElement>('#ts-title')!
    this.kickerEl = this.topStrip.querySelector<HTMLElement>('#ts-kicker')!
    this.openBtn = this.topStrip.querySelector<HTMLButtonElement>('#ts-open')!
    this.tracksBtn = this.topStrip.querySelector<HTMLButtonElement>('#ts-tracks')!
    this.recordBtn = this.topStrip.querySelector<HTMLButtonElement>('#ts-record')!
    this.fileModeBtn = this.topStrip.querySelector<HTMLButtonElement>('#ts-mode-file')!
    this.liveModeBtn = this.topStrip.querySelector<HTMLButtonElement>('#ts-mode-live')!
    this.hudDragHandle = this.hud.querySelector<HTMLButtonElement>('#hud-drag')!
    this.themeBtn = this.topStrip.querySelector<HTMLButtonElement>('#ts-theme')!
    this.themeLabelEl = this.topStrip.querySelector<HTMLElement>('#ts-theme-label')!

    this.playBtn.addEventListener('click', () => {
      if (state.mode.value !== 'file') return
      const s = state.status.value
      if (s === 'playing') {
        clock.pause()
        state.pausePlayback()
      } else if (s === 'paused' || s === 'ready') {
        clock.play()
        state.startPlaying()
      }
    })

    this.hud.querySelector('#hud-skip-back')!.addEventListener('click', () => {
      if (state.mode.value !== 'file') return
      const t = Math.max(0, clock.currentTime - SKIP_SECONDS)
      clock.seek(t)
      onSeek?.(t)
    })
    this.hud.querySelector('#hud-skip-fwd')!.addEventListener('click', () => {
      if (state.mode.value !== 'file') return
      const t = Math.min(state.duration.value, clock.currentTime + SKIP_SECONDS)
      clock.seek(t)
      onSeek?.(t)
    })

    this.scrubber.addEventListener('mousedown', () => {
      this.isScrubbing = true
      this.wakeUp()
    })
    this.scrubber.addEventListener('touchstart', () => {
      this.isScrubbing = true
    }, { passive: true })
    this.scrubber.addEventListener('input', () => {
      const t = parseFloat(this.scrubber.value)
      this.timeDisplay.textContent = formatTime(t)
      this.updateFill(t)
    })
    this.scrubber.addEventListener('change', () => {
      this.isScrubbing = false
      const t = parseFloat(this.scrubber.value)
      clock.seek(t)
      onSeek?.(t)
    })

    this.hud.querySelector<HTMLInputElement>('#hud-volume')!.addEventListener('input', (e) => {
      state.setVolume(parseFloat((e.target as HTMLInputElement).value))
    })

    const speedSlider = this.hud.querySelector<HTMLInputElement>('#hud-speed')!
    const speedVal = this.hud.querySelector<HTMLElement>('#hud-speed-val')!
    speedSlider.addEventListener('input', () => {
      const s = parseFloat(speedSlider.value)
      speedVal.textContent = formatSpeed(s)
      state.setSpeed(s)
    })

    this.hud.querySelector<HTMLInputElement>('#hud-zoom')!.addEventListener('input', (e) => {
      onZoom?.(parseFloat((e.target as HTMLInputElement).value))
    })

    this.topStrip.querySelector('#ts-theme')!.addEventListener('click', () => this.opts.onThemeCycle?.())
    this.midiBtn.addEventListener('click', () => this.opts.onMidiConnect?.())
    this.tracksBtn.addEventListener('click', () => this.opts.onOpenTracks?.())
    this.recordBtn.addEventListener('click', () => this.opts.onRecord?.())
    this.openBtn.addEventListener('click', () => this.opts.onOpenFile?.())
    this.fileModeBtn.addEventListener('click', () => this.opts.onModeRequest?.('file'))
    this.liveModeBtn.addEventListener('click', () => this.opts.onModeRequest?.('live'))
    this.hudDragHandle.addEventListener('pointerdown', (e) => this.startHudDrag(e))
  }

  private handleKey(e: KeyboardEvent): void {
    if ((e.target as HTMLElement).tagName === 'INPUT') return
    if (this.opts.state.mode.value !== 'file') return

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
      this.opts.onOpenTracks?.()
    } else if (e.code === 'KeyR') {
      if (!this.hud.classList.contains('hud--exporting')) {
        this.opts.onRecord?.()
      }
    }
  }

  private bindState(): void {
    const { state, clock } = this.opts

    clock.subscribe((t) => {
      if (state.mode.value !== 'file' || this.isScrubbing) return
      const dur = state.duration.value
      this.scrubber.value = String(t)
      this.timeDisplay.textContent = formatTime(t)
      this.updateFill(t)

      if (dur > 0 && t >= dur) {
        clock.pause()
        clock.seek(0)
        state.setReady()
      }
    })

    state.duration.subscribe((d) => {
      this.scrubber.max = String(d)
      this.durationEl.textContent = formatTime(d)
    })

    state.mode.subscribe(() => this.refreshUi())
    state.status.subscribe(() => this.refreshUi())
    state.loadedMidi.subscribe(() => this.refreshUi())

    this.refreshUi()
  }

  updateThemeDot(color: string): void {
    const dot = this.topStrip.querySelector<HTMLElement>('#ts-theme-dot')
    if (dot) dot.style.background = color
  }

  updateThemeLabel(name: string): void {
    this.themeLabelEl.textContent = name
    this.themeBtn.title = `Theme: ${name} — click to cycle`
    this.themeBtn.setAttribute('aria-label', `Theme: ${name}. Click to cycle themes.`)
  }

  updateOctave(octave: number): void {
    this.octaveEl.textContent = `C${octave}`
  }

  updateMidiStatus(status: MidiDeviceStatus, deviceName: string): void {
    this.currentMidiStatus = status
    this.currentMidiDeviceName = deviceName
    this.midiBtn.dataset['midiStatus'] = status
    this.midiBtn.classList.toggle('midi-connected', status === 'connected')
    this.midiBtn.classList.toggle('midi-blocked', status === 'blocked')
    this.midiBtn.classList.toggle('midi-unavailable', status === 'unavailable')

    const label = getMidiLabel(status, deviceName)
    this.midiBtn.title = label
    this.midiBtn.setAttribute('aria-label', label)
    this.midiLabelEl.textContent = label
    this.refreshUi()
  }

  dispose(): void {
    document.removeEventListener('mousemove', this.onMouseMoveDoc)
    document.removeEventListener('keydown', this.onKeyDownDoc)
    document.removeEventListener('pointermove', this.onPointerMoveDoc)
    document.removeEventListener('pointerup', this.onPointerUpDoc)
    window.removeEventListener('resize', this.onWindowResize)
    this.clearIdle()
  }

  private refreshUi(): void {
    const { state } = this.opts
    const mode = state.mode.value
    const status = state.status.value
    const midi = state.loadedMidi.value
    const hasFile = midi !== null
    const isFileMode = mode === 'file'
    const isLoadingFile = isFileMode && status === 'loading'
    const showHud = isFileMode && hasFile && !isLoadingFile

    this.topStrip.classList.add('strip--active')
    this.topStrip.classList.toggle('strip--playing', isFileMode && status === 'playing')
    this.topStrip.classList.toggle('strip--exporting', status === 'exporting')
    this.topStrip.dataset['mode'] = mode

    this.fileModeBtn.classList.toggle('mode-btn--active', mode === 'file')
    this.liveModeBtn.classList.toggle('mode-btn--active', mode === 'live')

    this.tracksBtn.classList.toggle('hidden', !isFileMode || !hasFile || isLoadingFile)
    this.recordBtn.classList.toggle('hidden', !isFileMode || !hasFile || isLoadingFile)

    this.hud.classList.toggle('hud--active', showHud)
    this.hud.classList.toggle('hud--playing', isFileMode && status === 'playing')
    this.hud.classList.toggle('hud--exporting', status === 'exporting')
    this.applyHudOffset()
    this.playBtn.innerHTML = status === 'playing' ? ICON_PAUSE : ICON_PLAY

    this.keyHint.classList.toggle('kh--visible', mode === 'live')

    this.renderHeader(mode, midi?.name ?? null)

    if (isFileMode && status === 'playing') {
      this.scheduleIdle()
    } else {
      this.clearIdle()
    }
  }

  private renderHeader(mode: AppMode, fileName: string | null): void {
    if (mode === 'file' && this.opts.state.status.value === 'loading') {
      this.kickerEl.textContent = 'Loading'
      this.titleEl.textContent = 'Opening MIDI'
      return
    }

    if (mode === 'live') {
      this.kickerEl.textContent = 'Live'
      this.titleEl.textContent = this.currentMidiStatus === 'connected'
        ? (this.currentMidiDeviceName || 'MIDI ready')
        : 'Play live'
      return
    }

    if (mode === 'file') {
      this.kickerEl.textContent = 'File'
      this.titleEl.textContent = fileName ?? 'Open MIDI'
      return
    }

    this.kickerEl.textContent = 'Ready'
    this.titleEl.textContent = 'Open MIDI or play live'
  }

  private wakeUp(): void {
    this.topStrip.classList.remove('strip--dim')
    this.hud.classList.remove('hud--idle')
    this.scheduleIdle()
  }

  private scheduleIdle(): void {
    this.clearIdle()
    if (this.opts.state.mode.value !== 'file' || this.opts.state.status.value !== 'playing') return
    this.idleTimer = setTimeout(() => {
      if (!this.isScrubbing) {
        this.topStrip.classList.add('strip--dim')
        this.hud.classList.add('hud--idle')
      }
    }, IDLE_MS)
  }

  private clearIdle(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
    this.topStrip.classList.remove('strip--dim')
    this.hud.classList.remove('hud--idle')
  }

  private startHudDrag(e: PointerEvent): void {
    e.preventDefault()
    this.isDraggingHud = true
    this.hudDragStartX = e.clientX
    this.hudDragStartY = e.clientY
    this.hudDragOriginX = this.hudOffsetX
    this.hudDragOriginY = this.hudOffsetY
    this.hud.classList.add('hud--dragging')
    document.addEventListener('pointermove', this.onPointerMoveDoc)
    document.addEventListener('pointerup', this.onPointerUpDoc)
  }

  private handleHudDragMove(e: PointerEvent): void {
    if (!this.isDraggingHud) return
    this.hudOffsetX = this.hudDragOriginX + (e.clientX - this.hudDragStartX)
    this.hudOffsetY = this.hudDragOriginY + (e.clientY - this.hudDragStartY)
    this.clampHudOffset()
  }

  private stopHudDrag(): void {
    if (!this.isDraggingHud) return
    this.isDraggingHud = false
    this.hud.classList.remove('hud--dragging')
    document.removeEventListener('pointermove', this.onPointerMoveDoc)
    document.removeEventListener('pointerup', this.onPointerUpDoc)
  }

  private applyHudOffset(): void {
    this.hud.style.setProperty('--hud-dx', `${this.hudOffsetX}px`)
    this.hud.style.setProperty('--hud-dy', `${this.hudOffsetY}px`)
  }

  private clampHudOffset(): void {
    const hudRect = this.hud.getBoundingClientRect()
    if (hudRect.width === 0 || hudRect.height === 0) {
      this.applyHudOffset()
      return
    }

    const rootStyles = getComputedStyle(document.documentElement)
    const keyboardHeight = parseFloat(rootStyles.getPropertyValue('--keyboard-h')) || 120
    const hudGap = parseFloat(rootStyles.getPropertyValue('--hud-gap')) || 14
    const defaultLeft = (window.innerWidth - hudRect.width) / 2
    const defaultTop = window.innerHeight - keyboardHeight - hudGap - hudRect.height
    const topStripBottom = this.topStrip.getBoundingClientRect().bottom
    const minLeft = 12
    const maxLeft = Math.max(minLeft, window.innerWidth - hudRect.width - 12)
    const minTop = Math.max(topStripBottom + 12, 12)
    const maxTop = Math.max(minTop, window.innerHeight - keyboardHeight - hudRect.height - 12)
    const nextLeft = clamp(defaultLeft + this.hudOffsetX, minLeft, maxLeft)
    const nextTop = clamp(defaultTop + this.hudOffsetY, minTop, maxTop)

    this.hudOffsetX = nextLeft - defaultLeft
    this.hudOffsetY = nextTop - defaultTop
    this.applyHudOffset()
  }

  private updateFill(t: number): void {
    const dur = this.opts.state.duration.value
    const pct = dur > 0 ? Math.min((t / dur) * 100, 100) : 0
    this.scrubber.style.setProperty('--pct', `${pct}%`)
  }
}

function getMidiLabel(status: MidiDeviceStatus, deviceName: string): string {
  if (status === 'connected') return deviceName || 'MIDI connected'
  if (status === 'blocked') return 'Enable MIDI'
  if (status === 'unavailable') return 'MIDI unavailable'
  return 'No MIDI device'
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

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

const ICON_GRIP = `<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
  <circle cx="9" cy="6" r="1.6"/>
  <circle cx="15" cy="6" r="1.6"/>
  <circle cx="9" cy="12" r="1.6"/>
  <circle cx="15" cy="12" r="1.6"/>
  <circle cx="9" cy="18" r="1.6"/>
  <circle cx="15" cy="18" r="1.6"/>
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
