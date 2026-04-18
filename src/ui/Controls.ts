import type { appState, AppMode } from '../store/state'
import type { MasterClock } from '../core/clock/MasterClock'
import type { MidiDeviceStatus } from '../midi/MidiInputManager'
import type { LoopState } from '../midi/LoopEngine'

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
  onHome?: () => void
  onInstrumentCycle?: () => void
  onParticleCycle?: () => void
  onLoopToggle?: () => void
  onLoopClear?: () => void
  onLoopSave?: () => void
  onLoopUndo?: () => void
  onMetronomeToggle?: () => void
  onMetronomeBpmChange?: (bpm: number) => void
  onSessionToggle?: () => void
  onHudPinChange?: (pinned: boolean) => void
}

export class Controls {
  private topStrip!: HTMLElement
  private hud!: HTMLElement
  private keyHint!: HTMLElement
  private playBtn!: HTMLButtonElement
  private scrubber!: HTMLInputElement
  private timeDisplay!: HTMLElement
  private durationEl!: HTMLElement
  private homeBtn!: HTMLButtonElement
  private statusEl!: HTMLElement
  private contextKickerEl!: HTMLElement
  private contextTitleEl!: HTMLElement
  private openBtn!: HTMLButtonElement
  private modeSwitchEl!: HTMLElement
  private modeFileBtn!: HTMLButtonElement
  private modeLiveBtn!: HTMLButtonElement
  private tracksBtn!: HTMLButtonElement
  private midiBtn!: HTMLButtonElement
  private midiLabelEl!: HTMLElement
  private recordBtn!: HTMLButtonElement
  private hudDragHandle!: HTMLButtonElement
  private hudPinBtn!: HTMLButtonElement
  private hudPinned = false
  // Mirrors "something important is happening" — session recording, loop
  // recording/playing, metronome running. While true we suppress auto-hide
  // so the user doesn't lose sight of transport controls mid-take.
  private hudActivityLock = false
  private themeBtn!: HTMLButtonElement
  private themeLabelEl!: HTMLElement
  private particleBtn!: HTMLButtonElement
  private particleLabelEl!: HTMLElement
  private loopBtn!: HTMLButtonElement
  private loopLabelEl!: HTMLElement
  private loopClearBtn!: HTMLButtonElement
  private loopSaveBtn!: HTMLButtonElement
  private loopUndoBtn!: HTMLButtonElement
  private sessionBtn!: HTMLButtonElement
  private sessionLabelEl!: HTMLElement
  private metroBtn!: HTMLButtonElement
  private metroGroupEl!: HTMLElement
  private metroBpmEl!: HTMLElement
  private metroBeatEl!: HTMLElement
  private metroDecBtn!: HTMLButtonElement
  private metroIncBtn!: HTMLButtonElement
  private octaveEl!: HTMLElement
  private isScrubbing = false
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private currentMidiStatus: MidiDeviceStatus = 'disconnected'
  private currentMidiDeviceName = ''
  // Cached values for throttling DOM writes — only update when the user would
  // actually see a difference. Cuts ~180 DOM writes/sec during playback.
  private lastDisplaySec = -1
  private lastFillPct = -1
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
      <button class="ts-home" id="ts-home" type="button" aria-label="midee home">
        ${ICON_WORDMARK}
        <span class="ts-home-name">midee</span>
      </button>

      <div class="ts-mode-switch" role="tablist" aria-label="App mode">
        <button class="ts-mode-seg" id="ts-mode-file" type="button"
                role="tab" aria-selected="false">
          <span class="ts-mode-icon" aria-hidden="true">${ICON_MODE_FILE}</span>
          <span class="ts-mode-label">File</span>
        </button>
        <button class="ts-mode-seg" id="ts-mode-live" type="button"
                role="tab" aria-selected="false">
          <span class="ts-mode-icon" aria-hidden="true">${ICON_MODE_LIVE}</span>
          <span class="ts-mode-label">Live</span>
        </button>
        <span class="ts-mode-thumb" aria-hidden="true"></span>
      </div>

      <div class="ts-status" id="ts-status" aria-live="polite">
        <span class="ts-status-dot" aria-hidden="true"></span>
        <span class="ts-status-main">
          <span class="ts-status-kicker" id="ts-context-kicker">Ready</span>
          <span class="ts-status-title" id="ts-context-title">Open MIDI or play live</span>
        </span>
        <span class="ts-bars" aria-hidden="true">
          <span></span><span></span><span></span><span></span>
        </span>
      </div>

      <div class="ts-end">
        <button class="ts-pill" id="ts-open" type="button" aria-label="Open MIDI file">
          ${ICON_UPLOAD}<span>Open MIDI</span>
        </button>
        <button class="ts-pill ts-pill--file" id="ts-tracks" type="button" aria-label="Tracks">
          ${ICON_TRACKS}<span>Tracks</span>
        </button>
        <span id="ts-instrument-slot"></span>
        <div class="ts-sep" aria-hidden="true"></div>
        <button class="ts-pill ts-pill--midi" id="ts-midi" type="button"
                aria-label="MIDI device" title="MIDI device">
          ${ICON_MIDI}
          <span id="ts-menu-midi-label" class="ts-midi-label">MIDI</span>
        </button>
        <button class="ts-theme-btn ts-particle-btn" id="ts-particle" type="button"
                aria-label="Cycle particle style" title="Cycle particle style">
          <span class="ts-particle-icon" aria-hidden="true">${ICON_SPARKLES}</span>
          <span class="theme-label" id="ts-particle-label">Sparks</span>
        </button>
        <button class="ts-theme-btn" id="ts-theme" type="button"
                aria-label="Cycle theme" title="Cycle theme">
          <span class="theme-dot" id="ts-theme-dot"></span>
          <span class="theme-label" id="ts-theme-label">Theme</span>
        </button>
        <button class="ts-record-btn" id="ts-record" type="button" aria-label="Export MP4">
          ${ICON_EXPORT}
          <span>Export</span>
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
        <button class="hud-pin-btn" id="hud-pin" type="button"
                title="Pin controls — prevents auto-hide" aria-label="Pin controls">
          ${ICON_PIN}
        </button>

        <div class="hud-group hud-group--transport">
          <button class="btn-skip" id="hud-skip-back" title="Back 10s" aria-label="Back 10 seconds">${ICON_SKIP_BACK}</button>
          <button class="btn-play" id="hud-play" aria-label="Play">${ICON_PLAY}</button>
          <button class="btn-skip" id="hud-skip-fwd" title="Forward 10s" aria-label="Forward 10 seconds">${ICON_SKIP_FWD}</button>
        </div>

        <div class="hud-divider hud-group--transport"></div>

        <div class="scrubber-wrap hud-group--transport">
          <span class="time-display" id="hud-time">0:00</span>
          <input type="range" id="hud-scrubber" class="scrubber"
            min="0" max="100" step="0.1" value="0" aria-label="Seek" />
          <span class="time-display dim" id="hud-duration">0:00</span>
        </div>

        <div class="hud-divider hud-group--transport"></div>

        <div class="ctrl-group" title="Volume">
          <span class="ctrl-icon">${ICON_VOLUME}</span>
          <input type="range" id="hud-volume" class="mini-slider"
            min="0" max="1" step="0.02" value="0.8" aria-label="Volume" />
        </div>

        <div class="ctrl-group hud-group--transport" title="Speed">
          <span class="speed-val" id="hud-speed-val">1x</span>
          <input type="range" id="hud-speed" class="mini-slider"
            min="0.25" max="2" step="0.05" value="1" aria-label="Speed" />
        </div>

        <div class="hud-divider"></div>

        <div class="ctrl-group" title="Zoom">
          <span class="ctrl-icon">${ICON_ZOOM}</span>
          <input type="range" id="hud-zoom" class="mini-slider mini-slider--zoom"
            min="${ZOOM_MIN}" max="${ZOOM_MAX}" step="10" value="${ZOOM_DEFAULT}" aria-label="Zoom" />
        </div>

        <div class="hud-divider hud-group--live"></div>

        <div class="hud-metro hud-group--live" id="hud-metro-group" title="Scroll on BPM to adjust">
          <button class="hud-metro-toggle" id="hud-metro" type="button"
                  aria-label="Toggle metronome">
            <span class="hud-metro-icon">${ICON_METRONOME}</span>
            <span class="hud-metro-beat" aria-hidden="true"></span>
          </button>
          <button class="hud-metro-step" id="hud-metro-dec" type="button"
                  aria-label="Decrease BPM">−</button>
          <span class="hud-metro-bpm" id="hud-metro-bpm">120</span>
          <button class="hud-metro-step" id="hud-metro-inc" type="button"
                  aria-label="Increase BPM">+</button>
        </div>

        <button class="hud-session-btn hud-group--live" id="hud-session"
                type="button" title="Record everything you play to MIDI"
                aria-label="Record session">
          <span class="hud-session-dot" aria-hidden="true"></span>
          <span class="hud-session-label" id="hud-session-label">Record</span>
        </button>

        <button class="hud-loop-btn hud-group--live" id="hud-loop"
                type="button" title="Play a phrase then loop it" aria-label="Looper">
          <span class="hud-loop-icon">${ICON_LOOP}</span>
          <span class="hud-loop-label" id="hud-loop-label">Loop</span>
        </button>
        <button class="hud-loop-undo hud-group--live hidden" id="hud-loop-undo"
                type="button" title="Undo last layer" aria-label="Undo last layer">
          ${ICON_UNDO}
        </button>
        <button class="hud-loop-save hud-group--live hidden" id="hud-loop-save"
                type="button" title="Download loop as MIDI" aria-label="Download loop as MIDI">
          ${ICON_DOWNLOAD}
        </button>
        <button class="hud-loop-clear hud-group--live hidden" id="hud-loop-clear"
                type="button" title="Clear loop" aria-label="Clear loop">
          ${ICON_CLOSE}
        </button>
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
          <span class="kh-section">Play</span>
          <span class="kh-map">
            <kbd>Z</kbd><kbd>X</kbd><kbd>C</kbd><kbd>V</kbd>
            <span class="kh-dots">· · ·</span>
            <kbd>Q</kbd><kbd>W</kbd><kbd>E</kbd><kbd>R</kbd>
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
        <div class="kh-row kh-row--shortcuts">
          <span class="kh-section">Live</span>
          <span class="kh-map kh-map--wrap">
            <span class="kh-combo"><kbd>Tab</kbd> record</span>
            <span class="kh-combo"><kbd>⇧L</kbd> loop</span>
            <span class="kh-combo"><kbd>⇧U</kbd> undo</span>
            <span class="kh-combo"><kbd>⇧C</kbd> clear</span>
            <span class="kh-combo"><kbd>\`</kbd> click</span>
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
    this.homeBtn = this.topStrip.querySelector<HTMLButtonElement>('#ts-home')!
    this.statusEl = this.topStrip.querySelector<HTMLElement>('#ts-status')!
    this.contextKickerEl = this.topStrip.querySelector<HTMLElement>('#ts-context-kicker')!
    this.contextTitleEl = this.topStrip.querySelector<HTMLElement>('#ts-context-title')!
    this.openBtn = this.topStrip.querySelector<HTMLButtonElement>('#ts-open')!
    this.modeSwitchEl = this.topStrip.querySelector<HTMLElement>('.ts-mode-switch')!
    this.modeFileBtn = this.topStrip.querySelector<HTMLButtonElement>('#ts-mode-file')!
    this.modeLiveBtn = this.topStrip.querySelector<HTMLButtonElement>('#ts-mode-live')!
    this.tracksBtn = this.topStrip.querySelector<HTMLButtonElement>('#ts-tracks')!
    this.midiBtn = this.topStrip.querySelector<HTMLButtonElement>('#ts-midi')!
    this.midiLabelEl = this.topStrip.querySelector<HTMLElement>('#ts-menu-midi-label')!
    this.recordBtn = this.topStrip.querySelector<HTMLButtonElement>('#ts-record')!
    this.hudDragHandle = this.hud.querySelector<HTMLButtonElement>('#hud-drag')!
    this.hudPinBtn = this.hud.querySelector<HTMLButtonElement>('#hud-pin')!
    this.themeBtn = this.topStrip.querySelector<HTMLButtonElement>('#ts-theme')!
    this.themeLabelEl = this.topStrip.querySelector<HTMLElement>('#ts-theme-label')!
    this.particleBtn = this.topStrip.querySelector<HTMLButtonElement>('#ts-particle')!
    this.particleLabelEl = this.topStrip.querySelector<HTMLElement>('#ts-particle-label')!
    this.loopBtn = this.hud.querySelector<HTMLButtonElement>('#hud-loop')!
    this.loopLabelEl = this.hud.querySelector<HTMLElement>('#hud-loop-label')!
    this.loopClearBtn = this.hud.querySelector<HTMLButtonElement>('#hud-loop-clear')!
    this.loopSaveBtn = this.hud.querySelector<HTMLButtonElement>('#hud-loop-save')!
    this.loopUndoBtn = this.hud.querySelector<HTMLButtonElement>('#hud-loop-undo')!
    this.sessionBtn = this.hud.querySelector<HTMLButtonElement>('#hud-session')!
    this.sessionLabelEl = this.hud.querySelector<HTMLElement>('#hud-session-label')!
    this.metroBtn = this.hud.querySelector<HTMLButtonElement>('#hud-metro')!
    this.metroGroupEl = this.hud.querySelector<HTMLElement>('#hud-metro-group')!
    this.metroBpmEl = this.hud.querySelector<HTMLElement>('#hud-metro-bpm')!
    this.metroBeatEl = this.hud.querySelector<HTMLElement>('.hud-metro-beat')!
    this.metroDecBtn = this.hud.querySelector<HTMLButtonElement>('#hud-metro-dec')!
    this.metroIncBtn = this.hud.querySelector<HTMLButtonElement>('#hud-metro-inc')!

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
      this.invalidateTimeCache()
      clock.seek(t)
      onSeek?.(t)
    })
    this.hud.querySelector('#hud-skip-fwd')!.addEventListener('click', () => {
      if (state.mode.value !== 'file') return
      const t = Math.min(state.duration.value, clock.currentTime + SKIP_SECONDS)
      this.invalidateTimeCache()
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
      this.invalidateTimeCache()
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

    this.themeBtn.addEventListener('click', () => this.opts.onThemeCycle?.())
    this.particleBtn.addEventListener('click', () => this.opts.onParticleCycle?.())
    this.recordBtn.addEventListener('click', () => this.opts.onRecord?.())
    this.homeBtn.addEventListener('click', () => this.opts.onHome?.())
    this.openBtn.addEventListener('click', () => this.opts.onOpenFile?.())
    this.tracksBtn.addEventListener('click', () => this.opts.onOpenTracks?.())
    this.midiBtn.addEventListener('click', () => this.opts.onMidiConnect?.())
    this.modeFileBtn.addEventListener('click', () => {
      this.opts.onModeRequest?.('file')
    })
    this.modeLiveBtn.addEventListener('click', () => {
      this.opts.onModeRequest?.('live')
    })
    this.loopBtn.addEventListener('click', () => this.opts.onLoopToggle?.())
    this.loopClearBtn.addEventListener('click', () => this.opts.onLoopClear?.())
    this.loopSaveBtn.addEventListener('click', () => this.opts.onLoopSave?.())
    this.loopUndoBtn.addEventListener('click', () => this.opts.onLoopUndo?.())
    this.sessionBtn.addEventListener('click', () => this.opts.onSessionToggle?.())
    this.metroBtn.addEventListener('click', () => this.opts.onMetronomeToggle?.())
    this.metroDecBtn.addEventListener('click', () => this.bumpBpm(-1))
    this.metroIncBtn.addEventListener('click', () => this.bumpBpm(+1))
    this.metroGroupEl.addEventListener('wheel', (e) => {
      e.preventDefault()
      const dir = e.deltaY < 0 ? 1 : -1
      const step = e.shiftKey ? 10 : 1
      this.bumpBpm(dir * step)
    }, { passive: false })

    this.hudDragHandle.addEventListener('pointerdown', (e) => this.startHudDrag(e))
    this.hudPinBtn.addEventListener('click', () => this.togglePin())
  }

  private handleKey(e: KeyboardEvent): void {
    const target = e.target as HTMLElement
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return
    const mode = this.opts.state.mode.value

    // Shift+P toggles the pin anywhere the HUD is visible.
    if (e.shiftKey && e.code === 'KeyP') {
      e.preventDefault()
      this.togglePin()
      return
    }

    if (mode === 'file') {
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
      return
    }

    if (mode === 'live') {
      // Single-key alternates for the two most-used actions while playing —
      // both keys sit outside the FL note map and are reachable by the left
      // hand without lifting off the note keys.
      if (e.code === 'Tab') {
        e.preventDefault()
        this.opts.onSessionToggle?.()
        return
      }
      if (e.code === 'Backquote') {
        e.preventDefault()
        this.opts.onMetronomeToggle?.()
        return
      }

      // Shift-letter hotkeys for the rest — gated on Shift so they can't
      // collide with the FL note map.
      if (e.shiftKey) {
        switch (e.code) {
          case 'KeyR': e.preventDefault(); this.opts.onSessionToggle?.(); break
          case 'KeyL': e.preventDefault(); this.opts.onLoopToggle?.(); break
          case 'KeyU': e.preventDefault(); this.opts.onLoopUndo?.(); break
          case 'KeyC': e.preventDefault(); this.opts.onLoopClear?.(); break
          case 'KeyM': e.preventDefault(); this.opts.onMetronomeToggle?.(); break
        }
      }
    }
  }

  private bindState(): void {
    const { state, clock } = this.opts

    clock.subscribe((t) => {
      if (state.mode.value !== 'file' || this.isScrubbing) return
      // Skip UI updates during export — frame-by-frame seeks would thrash the
      // scrubber behind the export modal and compete with the encoder for cycles.
      if (state.status.value === 'exporting') return
      const dur = state.duration.value

      // Scrubber knob moves every frame for smooth tracking
      this.scrubber.value = String(t)

      // Time display changes at second resolution
      const sec = Math.floor(t)
      if (sec !== this.lastDisplaySec) {
        this.timeDisplay.textContent = formatTime(t)
        this.lastDisplaySec = sec
      }

      // Fill gradient — 0.1% resolution is indistinguishable from 60fps
      const pct = dur > 0 ? Math.min((t / dur) * 100, 100) : 0
      if (Math.abs(pct - this.lastFillPct) >= 0.1) {
        this.scrubber.style.setProperty('--pct', `${pct.toFixed(1)}%`)
        this.lastFillPct = pct
      }

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

  // Legacy shim — the instrument label now lives in the topbar dropdown, and
  // app.ts drives it directly through the InstrumentMenu instance. Kept so
  // older call sites don't break; no-op until fully migrated off.
  updateInstrument(_name: string): void {}

  get tracksButton(): HTMLElement { return this.tracksBtn }
  get instrumentSlot(): HTMLElement {
    return this.topStrip.querySelector<HTMLElement>('#ts-instrument-slot')!
  }

  updateParticleStyle(name: string): void {
    this.particleLabelEl.textContent = name
    this.particleBtn.title = `Particles: ${name} — click to cycle`
    this.particleBtn.setAttribute('aria-label', `Particle style: ${name}. Click to cycle.`)
  }

  updateSessionRecording(recording: boolean, elapsedSec: number): void {
    this.sessionBtn.classList.toggle('hud-session-btn--on', recording)
    this.sessionLabelEl.textContent = recording ? formatMMSS(elapsedSec) : 'Record'
  }

  // 0–1 fraction around the loop button as a conic-gradient ring. Hidden when
  // the loop isn't playing (the setter flips a class to toggle visibility).
  updateLoopProgress(fraction: number): void {
    this.loopBtn.style.setProperty('--loop-progress', `${Math.max(0, Math.min(1, fraction)) * 360}deg`)
  }

  updateMetronome(running: boolean, bpm: number): void {
    this.metroBpmEl.textContent = String(bpm)
    this.metroGroupEl.classList.toggle('hud-metro--on', running)
    this.metroBtn.classList.toggle('hud-metro-toggle--on', running)
  }

  // Called once per beat from Metronome; triggers a brief visual pulse on the
  // icon. Restarts the CSS animation by toggling the class off and on.
  pulseMetronomeBeat(isDownbeat: boolean): void {
    this.metroBeatEl.classList.remove('hud-metro-beat--tick', 'hud-metro-beat--down')
    // Force reflow so the re-added class re-triggers the animation.
    void this.metroBeatEl.offsetWidth
    this.metroBeatEl.classList.add(isDownbeat ? 'hud-metro-beat--down' : 'hud-metro-beat--tick')
  }

  setHudPinned(pinned: boolean): void {
    this.hudPinned = pinned
    this.hudPinBtn.classList.toggle('hud-pin-btn--on', pinned)
    this.hudPinBtn.setAttribute('aria-pressed', String(pinned))
    if (pinned) this.clearIdle()
    else this.scheduleIdle()
  }

  // Called by app.ts whenever a long-running state changes (recording, loop,
  // metronome). Same effect as pinning, but silent — the user didn't click,
  // the app decided.
  setHudActivityLock(locked: boolean): void {
    if (this.hudActivityLock === locked) return
    this.hudActivityLock = locked
    if (locked) this.clearIdle()
    else this.scheduleIdle()
  }

  private togglePin(): void {
    this.setHudPinned(!this.hudPinned)
    this.opts.onHudPinChange?.(this.hudPinned)
  }

  private bumpBpm(delta: number): void {
    const current = parseInt(this.metroBpmEl.textContent ?? '120', 10)
    this.opts.onMetronomeBpmChange?.(current + delta)
  }

  updateLoopState(state: LoopState, layerCount: number): void {
    this.loopLabelEl.textContent = loopLabel(state, layerCount)
    this.loopBtn.dataset['loopState'] = state
    const active = state !== 'idle' && state !== 'armed'
    this.loopClearBtn.classList.toggle('hidden', !active)
    this.loopSaveBtn.classList.toggle('hidden', state !== 'playing' && state !== 'overdubbing')
    // Undo is only meaningful when there's a past state to restore to — i.e.
    // while overdubbing (cancel in-progress) or when ≥1 committed layer exists.
    const canUndo = state === 'overdubbing' || (state === 'playing' && layerCount >= 1)
    this.loopUndoBtn.classList.toggle('hidden', !canUndo)
  }

  updateMidiStatus(status: MidiDeviceStatus, deviceName: string): void {
    this.currentMidiStatus = status
    this.currentMidiDeviceName = deviceName
    this.topStrip.dataset['midiStatus'] = status
    this.midiBtn.classList.toggle('ts-pill--on', status === 'connected')
    this.midiLabelEl.textContent = getMidiPillLabel(status, deviceName)
    const full = getMidiMenuLabel(status, deviceName)
    this.midiBtn.title = full
    this.midiBtn.setAttribute('aria-label', full)
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
    // HUD is visible for file playback AND live mode (with a reduced set of controls).
    const showFileHud = isFileMode && hasFile && !isLoadingFile
    const showLiveHud = mode === 'live'
    const showHud = showFileHud || showLiveHud

    this.topStrip.classList.add('strip--active')
    this.topStrip.classList.toggle('strip--playing', isFileMode && status === 'playing')
    this.topStrip.classList.toggle('strip--exporting', status === 'exporting')
    this.topStrip.dataset['mode'] = mode
    this.topStrip.dataset['hasFile'] = hasFile ? 'true' : 'false'

    // Contextual pill visibility
    this.tracksBtn.classList.toggle('hidden', !isFileMode || !hasFile || isLoadingFile)
    this.recordBtn.classList.toggle('hidden', !isFileMode || !hasFile || isLoadingFile)

    // Mode switcher: reflect current mode. `home` leaves both neutral so the
    // user sees both as open paths. The thumb element is positioned via a
    // data-attribute so the highlight can slide between segments.
    const activeMode = mode === 'file' || mode === 'live' ? mode : 'none'
    this.modeSwitchEl.dataset['active'] = activeMode
    this.modeFileBtn.classList.toggle('is-active', mode === 'file')
    this.modeLiveBtn.classList.toggle('is-active', mode === 'live')
    this.modeFileBtn.setAttribute('aria-selected', mode === 'file' ? 'true' : 'false')
    this.modeLiveBtn.setAttribute('aria-selected', mode === 'live' ? 'true' : 'false')

    this.hud.classList.toggle('hud--active', showHud)
    this.hud.classList.toggle('hud--playing', isFileMode && status === 'playing')
    this.hud.classList.toggle('hud--exporting', status === 'exporting')
    this.hud.classList.toggle('hud--live', showLiveHud)
    this.hud.classList.toggle('hud--file', showFileHud)
    this.applyHudOffset()
    this.playBtn.innerHTML = status === 'playing' ? ICON_PAUSE : ICON_PLAY

    this.keyHint.classList.toggle('kh--visible', mode === 'live')

    this.renderContext(mode, midi?.name ?? null)

    // Auto-hide the HUD when idle in any mode where it's visible.
    // File mode: only while playing (pausing needs the controls accessible).
    // Live mode: always eligible to auto-hide after inactivity.
    if ((isFileMode && status === 'playing') || showLiveHud) {
      this.scheduleIdle()
    } else {
      this.clearIdle()
    }
  }

  private renderContext(mode: AppMode, fileName: string | null): void {
    if (mode === 'file' && this.opts.state.status.value === 'loading') {
      this.contextKickerEl.textContent = 'Loading'
      this.contextTitleEl.textContent = 'Opening MIDI'
      return
    }

    if (mode === 'live') {
      this.contextKickerEl.textContent = 'Live'
      this.contextTitleEl.textContent = this.currentMidiStatus === 'connected'
        ? (this.currentMidiDeviceName || 'MIDI session')
        : 'Play with your keyboard'
      return
    }

    if (mode === 'file') {
      this.contextKickerEl.textContent = 'Now playing'
      this.contextTitleEl.textContent = fileName ?? 'Open MIDI'
      return
    }

    this.contextKickerEl.textContent = 'Ready'
    this.contextTitleEl.textContent = 'Open MIDI or play live'
  }

  private wakeUp(): void {
    this.topStrip.classList.remove('strip--dim')
    this.hud.classList.remove('hud--idle')
    this.keyHint.classList.remove('kh--idle')
    this.scheduleIdle()
  }

  private scheduleIdle(): void {
    this.clearIdle()
    if (this.hudPinned || this.hudActivityLock) return
    const mode = this.opts.state.mode.value
    const status = this.opts.state.status.value
    const isPlaying = mode === 'file' && status === 'playing'
    const isLive = mode === 'live'
    if (!isPlaying && !isLive) return
    this.idleTimer = setTimeout(() => {
      if (!this.isScrubbing) {
        this.topStrip.classList.add('strip--dim')
        this.hud.classList.add('hud--idle')
        this.keyHint.classList.add('kh--idle')
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
    this.keyHint.classList.remove('kh--idle')
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

  // Force the next clock tick to redraw the time display and fill gradient,
  // even if the new time happens to fall within a cached threshold.
  private invalidateTimeCache(): void {
    this.lastDisplaySec = -1
    this.lastFillPct = -1
  }
}

function getMidiMenuLabel(status: MidiDeviceStatus, deviceName: string): string {
  if (status === 'connected') return `MIDI: ${deviceName || 'connected'}`
  if (status === 'blocked') return 'Enable MIDI device'
  if (status === 'unavailable') return 'MIDI unavailable in this browser'
  return 'Connect a MIDI device'
}

function getMidiPillLabel(status: MidiDeviceStatus, deviceName: string): string {
  if (status === 'connected') {
    const n = deviceName.split(',')[0]?.trim()
    return n && n.length < 22 ? n : 'MIDI'
  }
  if (status === 'blocked') return 'Enable MIDI'
  return 'MIDI'
}

function formatTime(s: number): string {
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${sec.toString().padStart(2, '0')}`
}

function formatMMSS(s: number): string {
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`
}

function formatSpeed(s: number): string {
  if (s === 1) return '1x'
  return `${s % 1 === 0 ? s : s.toFixed(2).replace(/0+$/, '')}x`
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function loopLabel(state: LoopState, layerCount: number): string {
  switch (state) {
    case 'idle':        return 'Loop'
    case 'armed':       return 'Play now…'
    case 'recording':   return 'Stop'
    case 'playing':     return layerCount > 1 ? `Loop ×${layerCount}` : 'Tap to overdub'
    case 'overdubbing': return `Overdub ${layerCount + 1}`
  }
}

const ICON_LOOP = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <polyline points="17 1 21 5 17 9"/>
  <path d="M3 11V9a4 4 0 0 1 4-4h14"/>
  <polyline points="7 23 3 19 7 15"/>
  <path d="M21 13v2a4 4 0 0 1-4 4H3"/>
</svg>`

const ICON_DOWNLOAD = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
  <polyline points="7 10 12 15 17 10"/>
  <line x1="12" y1="15" x2="12" y2="3"/>
</svg>`

const ICON_UNDO = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <polyline points="3 7 3 13 9 13"/>
  <path d="M3 13a9 9 0 1 0 3-7l-3 4"/>
</svg>`

const ICON_METRONOME = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M6 22 L10 3 H14 L18 22 Z"/>
  <line x1="5" y1="17" x2="19" y2="17"/>
  <line x1="12" y1="17" x2="17" y2="6"/>
</svg>`

const ICON_TRACKS = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
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

const ICON_WORDMARK = `<svg class="ts-home-mark" width="22" height="18" viewBox="0 0 32 24" fill="currentColor" aria-hidden="true">
  <rect x="1" y="6" width="5" height="15" rx="1.5"/>
  <rect x="9" y="1" width="5" height="20" rx="1.5"/>
  <rect x="17" y="4" width="5" height="12" rx="1.5" opacity="0.55"/>
  <rect x="25" y="8" width="5" height="9" rx="1.5" opacity="0.35"/>
</svg>`

const ICON_CHEV = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <polyline points="6 9 12 15 18 9"/>
</svg>`

const ICON_UPLOAD = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
  <polyline points="17 8 12 3 7 8"/>
  <line x1="12" y1="3" x2="12" y2="15"/>
</svg>`

/* File mode — three stacked note-bars, echoing the piano-roll visual. */
const ICON_MODE_FILE = `<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
  <rect x="2" y="3.5" width="7" height="2.2" rx="0.8"/>
  <rect x="2" y="7" width="12" height="2.2" rx="0.8"/>
  <rect x="2" y="10.5" width="5" height="2.2" rx="0.8"/>
</svg>`

/* Live mode — a clean pulse waveform, evoking real-time input. */
const ICON_MODE_LIVE = `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M1.5 8h2l1.2-3.5L7 12l1.8-6 1.3 3 0.9-1.2H14"/>
</svg>`

const ICON_CLOSE = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
  <line x1="6" y1="6" x2="18" y2="18"/>
  <line x1="6" y1="18" x2="18" y2="6"/>
</svg>`

const ICON_RECORD = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <circle cx="12" cy="12" r="4" fill="currentColor" stroke="none"/>
  <circle cx="12" cy="12" r="9"/>
</svg>`

const ICON_EXPORT = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M12 3v12"/>
  <polyline points="7 8 12 3 17 8"/>
  <rect x="3" y="15" width="18" height="6" rx="1.5"/>
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

const ICON_PIN = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <line x1="12" y1="17" x2="12" y2="22"/>
  <path d="M5 17h14l-1.5-2V9a5.5 5.5 0 1 0-11 0v6L5 17z"/>
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

const ICON_INSTRUMENT = `<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
  <path d="M9 3h6a1 1 0 0 1 1 1v14a3 3 0 1 1-2 0V9h-2v9a3 3 0 1 1-2 0V4a1 1 0 0 1 1-1z" opacity="0.9"/>
</svg>`

const ICON_SPARKLES = `<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
  <path d="M12 3l1.2 3.8L17 8l-3.8 1.2L12 13l-1.2-3.8L7 8l3.8-1.2L12 3z"/>
  <path d="M19 13l.7 2.2 2.3.8-2.3.8-.7 2.2-.7-2.2-2.3-.8 2.3-.8.7-2.2z" opacity="0.7"/>
  <path d="M5 14l.6 1.9 1.9.6-1.9.6-.6 1.9-.6-1.9-1.9-.6 1.9-.6.6-1.9z" opacity="0.55"/>
</svg>`

const ICON_ZOOM = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <circle cx="11" cy="11" r="8"/>
  <line x1="21" y1="21" x2="16.65" y2="16.65"/>
  <line x1="11" y1="8" x2="11" y2="14"/>
  <line x1="8" y1="11" x2="14" y2="11"/>
</svg>`
