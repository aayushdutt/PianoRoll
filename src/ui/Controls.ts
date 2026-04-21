import type { MasterClock } from '../core/clock/MasterClock'
import { t } from '../i18n'
import type { LoopState } from '../midi/LoopEngine'
import type { MidiDeviceStatus } from '../midi/MidiInputManager'
import type { AppMode, appState } from '../store/state'
import { icons } from './icons'

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
  onChordToggle?: () => void
  onPracticeToggle?: () => void
  // Clickable octave arrows in the key-hint panel — delta is −1 / +1.
  // Users click the ↑/↓ glyphs thinking they're buttons; this makes the
  // inference correct. Backed by the same handlers as the ArrowUp/ArrowDown
  // keybindings in ComputerKeyboardInput.
  onOctaveShift?: (delta: number) => void
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
  // Theme/particle/chord-toggle moved into the CustomizeMenu popover; no
  // direct topbar references remain. Public update methods on this class
  // are wired by App to forward into that menu.
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
  private octaveDownBtn!: HTMLButtonElement
  private octaveUpBtn!: HTMLButtonElement
  private keyHintCloseBtn!: HTMLButtonElement
  private keyHintReopenBtn!: HTMLButtonElement
  private keyHintHidden = false
  private practiceBtn!: HTMLButtonElement
  private practiceLabelEl!: HTMLElement
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
  // Unsubscribe closures from every Signal we listen to — invoked in dispose()
  // so the signals' listener sets don't accumulate dead references.
  private unsubs: Array<() => void> = []

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
      <button class="ts-home" id="ts-home" type="button" aria-label="midee home" data-tip="${t('topStrip.home')}">
        ${icons.wordmark()}
        <span class="ts-home-name">midee</span>
      </button>

      <div class="ts-mode-switch" role="tablist" aria-label="${t('hud.aria.appMode')}">
        <button class="ts-mode-seg" id="ts-mode-file" type="button"
                role="tab" aria-selected="false" data-tip="${t('topStrip.modeFile')}">
          <span class="ts-mode-icon" aria-hidden="true">${icons.modeFile()}</span>
          <span class="ts-mode-label">File</span>
        </button>
        <button class="ts-mode-seg" id="ts-mode-live" type="button"
                role="tab" aria-selected="false" data-tip="${t('topStrip.modeLive')}">
          <span class="ts-mode-icon" aria-hidden="true">${icons.modeLive()}</span>
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
        <span id="ts-chord-slot" class="ts-chord-slot"></span>
      </div>

      <div class="ts-end">
        <button class="ts-pill" id="ts-open" type="button" aria-label="${t('topStrip.openMidi')}" data-tip="${t('topStrip.openMidi')}">
          ${icons.upload()}<span>${t('home.cta.openMidi')}</span>
        </button>
        <button class="ts-pill ts-pill--file" id="ts-tracks" type="button" aria-label="${t('topStrip.tracks')}" data-tip="${t('topStrip.tracks')}">
          ${icons.tracks()}<span>${t('topStrip.tracks')}</span>
        </button>
        <span id="ts-instrument-slot"></span>
        <div class="ts-sep" aria-hidden="true"></div>
        <button class="ts-pill ts-pill--midi" id="ts-midi" type="button"
                aria-label="${t('topStrip.midi')}" data-tip="${t('topStrip.midi')}">
          ${icons.midi()}
          <span id="ts-menu-midi-label" class="ts-midi-label">MIDI</span>
        </button>
        <span id="ts-customize-slot"></span>
        <button class="ts-record-btn" id="ts-record" type="button" aria-label="${t('topStrip.export')}" data-tip="${t('topStrip.export')}">
          ${icons.export()}
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
        <button class="hud-drag-handle" id="hud-drag" type="button"
                aria-label="${t('hud.aria.drag')}" data-tip="${t('hud.drag')}">
          ${icons.grip()}
        </button>
        <button class="hud-pin-btn" id="hud-pin" type="button"
                aria-label="${t('hud.aria.pin')}" data-tip="${t('hud.pin')}">
          ${icons.pin()}
        </button>

        <div class="hud-group hud-group--transport">
          <button class="btn-skip" id="hud-skip-back" aria-label="${t('hud.aria.skipBack')}" data-tip="${t('hud.skipBack')}">${icons.skipBack()}</button>
          <button class="btn-play" id="hud-play" aria-label="${t('hud.aria.play')}" data-tip="${t('hud.play')}">${icons.play()}</button>
          <button class="btn-skip" id="hud-skip-fwd" aria-label="${t('hud.aria.skipFwd')}" data-tip="${t('hud.skipFwd')}">${icons.skipForward()}</button>
        </div>

        <div class="hud-divider hud-group--transport"></div>

        <div class="scrubber-wrap hud-group--transport">
          <span class="time-display" id="hud-time">0:00</span>
          <input type="range" id="hud-scrubber" class="scrubber"
            min="0" max="100" step="0.1" value="0" aria-label="${t('hud.aria.seek')}" />
          <span class="time-display dim" id="hud-duration">0:00</span>
        </div>

        <div class="hud-divider hud-group--transport"></div>

        <div class="ctrl-group" data-tip="${t('hud.volume')}">
          <span class="ctrl-icon">${icons.volume()}</span>
          <input type="range" id="hud-volume" class="mini-slider"
            min="0" max="1" step="0.02" value="0.8" aria-label="${t('hud.aria.volume')}" />
        </div>

        <div class="ctrl-group hud-group--transport" data-tip="${t('hud.speed')}">
          <span class="speed-val" id="hud-speed-val">1x</span>
          <input type="range" id="hud-speed" class="mini-slider"
            min="0.25" max="2" step="0.05" value="1" aria-label="${t('hud.aria.speed')}" />
        </div>

        <div class="hud-divider"></div>

        <div class="ctrl-group" data-tip="${t('hud.zoom')}">
          <span class="ctrl-icon">${icons.zoom()}</span>
          <input type="range" id="hud-zoom" class="mini-slider mini-slider--zoom"
            min="${ZOOM_MIN}" max="${ZOOM_MAX}" step="10" value="${ZOOM_DEFAULT}" aria-label="${t('hud.aria.zoom')}" />
        </div>

        <div class="hud-divider hud-group--file"></div>

        <button class="hud-practice-btn hud-group--file" id="hud-practice"
                type="button" aria-label="${t('hud.aria.practice')}"
                aria-pressed="false"
                data-tip="${t('hud.tip.practice')}">
          <span class="hud-practice-icon" aria-hidden="true">${icons.practice()}</span>
          <span class="hud-practice-label" id="hud-practice-label">Practice</span>
        </button>

        <div class="hud-divider hud-group--live"></div>

        <div class="hud-metro hud-group--live" id="hud-metro-group">
          <button class="hud-metro-toggle" id="hud-metro" type="button"
                  aria-label="${t('hud.aria.metronomeToggle')}" data-tip="${t('hud.metronome')}">
            <span class="hud-metro-icon">${icons.metronome()}</span>
            <span class="hud-metro-beat" aria-hidden="true"></span>
          </button>
          <button class="hud-metro-step" id="hud-metro-dec" type="button"
                  aria-label="${t('hud.aria.bpmDec')}">−</button>
          <span class="hud-metro-bpm" id="hud-metro-bpm" data-tip="${t('hud.bpm')}" tabindex="0">120</span>
          <button class="hud-metro-step" id="hud-metro-inc" type="button"
                  aria-label="${t('hud.aria.bpmInc')}">+</button>
        </div>

        <button class="hud-session-btn hud-group--live" id="hud-session"
                type="button" aria-label="${t('hud.aria.session')}"
                data-tip="${t('hud.record')}">
          <span class="hud-session-dot" aria-hidden="true"></span>
          <span class="hud-session-label" id="hud-session-label">Record</span>
        </button>

        <button class="hud-loop-btn hud-group--live" id="hud-loop"
                type="button" aria-label="${t('hud.aria.loop')}"
                data-tip="${t('hud.loop')}">
          <span class="hud-loop-icon">${icons.loop()}</span>
          <span class="hud-loop-label" id="hud-loop-label">Loop</span>
        </button>
        <button class="hud-loop-undo hud-group--live hidden" id="hud-loop-undo"
                type="button" aria-label="${t('hud.aria.loopUndo')}" data-tip="${t('hud.loopUndo')}">
          ${icons.undo()}
        </button>
        <button class="hud-loop-save hud-group--live hidden" id="hud-loop-save"
                type="button" aria-label="${t('hud.aria.loopSave')}" data-tip="${t('hud.loopSave')}">
          ${icons.download()}
        </button>
        <button class="hud-loop-clear hud-group--live hidden" id="hud-loop-clear"
                type="button" aria-label="${t('hud.aria.loopClear')}" data-tip="${t('hud.loopClear')}">
          ${icons.close()}
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
        <div class="kh-section kh-section--first">
          <div class="kh-section-head">
            <span class="kh-label">Play</span>
            <button class="kh-close" id="kh-close" type="button"
                    aria-label="${t('hud.aria.kbdRefHide')}" data-tip="${t('hud.tip.kbdRefHide')}">
              ${icons.smallClose()}
            </button>
          </div>
          <span class="kh-keys">
            <kbd>Z</kbd><kbd>X</kbd><kbd>C</kbd><kbd>V</kbd>
            <span class="kh-divider" aria-hidden="true"></span>
            <kbd>Q</kbd><kbd>W</kbd><kbd>E</kbd><kbd>R</kbd>
          </span>
        </div>

        <div class="kh-section">
          <span class="kh-label">Octave</span>
          <span class="kh-keys">
            <button class="kh-cap-btn" id="kh-octave-down" type="button"
                    aria-label="${t('hud.aria.octaveDown')}" data-tip="${t('hud.tip.octaveDown')}"
            ><kbd class="kh-cap-sym">↓</kbd></button>
            <button class="kh-cap-btn" id="kh-octave-up" type="button"
                    aria-label="${t('hud.aria.octaveUp')}" data-tip="${t('hud.tip.octaveUp')}"
            ><kbd class="kh-cap-sym">↑</kbd></button>
            <span class="kh-octave-pill" id="kh-octave">C4</span>
          </span>
        </div>

        <div class="kh-section">
          <span class="kh-label">Shortcuts</span>
          <div class="kh-shortcuts">
            <span class="kh-combo"><kbd>Tab</kbd><span>Record</span></span>
            <span class="kh-combo"><span class="kh-cap-group"><kbd class="kh-cap-sym">⇧</kbd><kbd>L</kbd></span><span>Loop</span></span>
            <span class="kh-combo"><span class="kh-cap-group"><kbd class="kh-cap-sym">⇧</kbd><kbd>U</kbd></span><span>Undo</span></span>
            <span class="kh-combo"><span class="kh-cap-group"><kbd class="kh-cap-sym">⇧</kbd><kbd>C</kbd></span><span>Clear</span></span>
            <span class="kh-combo"><kbd class="kh-cap-sym">\`</kbd><span>Metronome</span></span>
          </div>
        </div>
      </div>
      <button class="kh-reopen" id="kh-reopen" type="button"
              aria-label="${t('hud.aria.kbdRefShow')}" data-tip="${t('hud.tip.kbdRefShow')}">
        ${icons.keycap()}
      </button>
    `
    this.opts.container.appendChild(el)
    this.keyHint = el
    this.octaveEl = el.querySelector<HTMLElement>('#kh-octave')!
    this.octaveDownBtn = el.querySelector<HTMLButtonElement>('#kh-octave-down')!
    this.octaveUpBtn = el.querySelector<HTMLButtonElement>('#kh-octave-up')!
    this.keyHintCloseBtn = el.querySelector<HTMLButtonElement>('#kh-close')!
    this.keyHintReopenBtn = el.querySelector<HTMLButtonElement>('#kh-reopen')!
    this.keyHintCloseBtn.addEventListener('click', () => this.setKeyHintHidden(true))
    this.keyHintReopenBtn.addEventListener('click', () => this.setKeyHintHidden(false))
    this.octaveDownBtn.addEventListener('click', () => this.opts.onOctaveShift?.(-1))
    this.octaveUpBtn.addEventListener('click', () => this.opts.onOctaveShift?.(+1))
    this.keyHintHidden = loadKeyHintHidden()
    this.applyKeyHintHiddenClass()
  }

  private bindEvents(): void {
    const { state, clock, onSeek, onZoom } = this.opts

    this.playBtn = this.hud.querySelector<HTMLButtonElement>('#hud-play')!
    this.scrubber = this.hud.querySelector<HTMLInputElement>('#hud-scrubber')!
    this.timeDisplay = this.hud.querySelector<HTMLElement>('#hud-time')!
    this.durationEl = this.hud.querySelector<HTMLElement>('#hud-duration')!
    this.homeBtn = this.topStrip.querySelector<HTMLButtonElement>('#ts-home')!
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
    this.practiceBtn = this.hud.querySelector<HTMLButtonElement>('#hud-practice')!
    this.practiceLabelEl = this.hud.querySelector<HTMLElement>('#hud-practice-label')!

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
    this.scrubber.addEventListener(
      'touchstart',
      () => {
        this.isScrubbing = true
      },
      { passive: true },
    )
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

    const volumeSlider = this.hud.querySelector<HTMLInputElement>('#hud-volume')!
    volumeSlider.addEventListener('input', (e) => {
      state.setVolume(parseFloat((e.target as HTMLInputElement).value))
      this.updateSliderFill(volumeSlider)
    })

    const speedSlider = this.hud.querySelector<HTMLInputElement>('#hud-speed')!
    const speedVal = this.hud.querySelector<HTMLElement>('#hud-speed-val')!
    speedSlider.addEventListener('input', () => {
      const s = parseFloat(speedSlider.value)
      speedVal.textContent = formatSpeed(s)
      state.setSpeed(s)
      this.updateSliderFill(speedSlider)
    })

    const zoomSlider = this.hud.querySelector<HTMLInputElement>('#hud-zoom')!
    zoomSlider.addEventListener('input', (e) => {
      onZoom?.(parseFloat((e.target as HTMLInputElement).value))
      this.updateSliderFill(zoomSlider)
    })

    // Paint the initial fill once so the thumb's accent trail is visible
    // before the first user interaction (volume defaults to 0.8, etc.).
    this.updateSliderFill(volumeSlider)
    this.updateSliderFill(speedSlider)
    this.updateSliderFill(zoomSlider)

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
    this.practiceBtn.addEventListener('click', () => this.opts.onPracticeToggle?.())
    this.metroGroupEl.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault()
        const dir = e.deltaY < 0 ? 1 : -1
        const step = e.shiftKey ? 10 : 1
        this.bumpBpm(dir * step)
      },
      { passive: false },
    )

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
      } else if (e.code === 'KeyP' && !e.shiftKey) {
        // P toggles practice mode in file mode (Shift+P is reserved for HUD pin).
        e.preventDefault()
        this.opts.onPracticeToggle?.()
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
          case 'KeyR':
            e.preventDefault()
            this.opts.onSessionToggle?.()
            break
          case 'KeyL':
            e.preventDefault()
            this.opts.onLoopToggle?.()
            break
          case 'KeyU':
            e.preventDefault()
            this.opts.onLoopUndo?.()
            break
          case 'KeyC':
            e.preventDefault()
            this.opts.onLoopClear?.()
            break
          case 'KeyM':
            e.preventDefault()
            this.opts.onMetronomeToggle?.()
            break
        }
      }
    }
  }

  private setKeyHintHidden(hidden: boolean): void {
    if (this.keyHintHidden === hidden) return
    this.keyHintHidden = hidden
    this.applyKeyHintHiddenClass()
    saveKeyHintHidden(hidden)
  }

  private applyKeyHintHiddenClass(): void {
    this.keyHint.classList.toggle('kh--collapsed', this.keyHintHidden)
  }

  private bindState(): void {
    const { state, clock } = this.opts

    this.unsubs.push(
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
      }),
      state.duration.subscribe((d) => {
        this.scrubber.max = String(d)
        this.durationEl.textContent = formatTime(d)
      }),
      state.mode.subscribe(() => this.refreshUi()),
      state.status.subscribe(() => this.refreshUi()),
      state.loadedMidi.subscribe(() => this.refreshUi()),
    )

    this.refreshUi()
  }

  // Theme + particle styling now lives in the CustomizeMenu popover; the
  // legacy methods stay as no-ops so existing call-sites in App.ts continue
  // to compile until they're migrated to push state straight into the menu.
  updateThemeDot(_color: string): void {}
  updateThemeLabel(_name: string): void {}

  updateOctave(octave: number): void {
    this.octaveEl.textContent = `C${octave}`
  }

  // Legacy shim — the instrument label now lives in the topbar dropdown, and
  // app.ts drives it directly through the InstrumentMenu instance. Kept so
  // older call sites don't break; no-op until fully migrated off.
  updateInstrument(_name: string): void {}

  get tracksButton(): HTMLElement {
    return this.tracksBtn
  }
  get instrumentSlot(): HTMLElement {
    return this.topStrip.querySelector<HTMLElement>('#ts-instrument-slot')!
  }
  get chordSlot(): HTMLElement {
    return this.topStrip.querySelector<HTMLElement>('#ts-chord-slot')!
  }
  get customizeSlot(): HTMLElement {
    return this.topStrip.querySelector<HTMLElement>('#ts-customize-slot')!
  }

  updateParticleStyle(_name: string): void {}

  updateSessionRecording(recording: boolean, elapsedSec: number): void {
    this.sessionBtn.classList.toggle('hud-session-btn--on', recording)
    this.sessionLabelEl.textContent = recording ? formatMMSS(elapsedSec) : 'Record'
  }

  // 0–1 fraction around the loop button as a conic-gradient ring. Hidden when
  // the loop isn't playing (the setter flips a class to toggle visibility).
  updateLoopProgress(fraction: number): void {
    this.loopBtn.style.setProperty(
      '--loop-progress',
      `${Math.max(0, Math.min(1, fraction)) * 360}deg`,
    )
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

  // Flipped on while the active instrument's samples are downloading.
  // Shown on the play button so users don't click-pause-click again when the
  // clock visibly runs but audio hasn't started yet.
  setInstrumentLoading(loading: boolean): void {
    this.playBtn.classList.toggle('btn-play--loading', loading)
  }

  updateChordOverlayState(_on: boolean): void {}

  // Practice mode reflects two states: enabled (button "armed") and waiting
  // (button pulses while the engine is holding the clock). The two CSS
  // classes are independent so a non-waiting "armed" state still reads
  // distinctly from the inactive default.
  updatePracticeState(enabled: boolean, waiting: boolean): void {
    this.practiceBtn.classList.toggle('hud-practice-btn--on', enabled)
    this.practiceBtn.classList.toggle('hud-practice-btn--waiting', waiting)
    this.practiceBtn.setAttribute('aria-pressed', String(enabled))
    this.practiceLabelEl.textContent = waiting ? 'Waiting…' : enabled ? 'Practice' : 'Practice'
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
    for (const unsub of this.unsubs) unsub()
    this.unsubs = []
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
    this.playBtn.innerHTML = status === 'playing' ? icons.pause() : icons.play()

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
      this.contextTitleEl.textContent =
        this.currentMidiStatus === 'connected'
          ? this.currentMidiDeviceName || 'MIDI session'
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

  // Paint the accent-tinted fill on a range slider based on its current
  // value. CSS reads `--pct` in a gradient to show the "filled" portion.
  private updateSliderFill(slider: HTMLInputElement): void {
    const min = parseFloat(slider.min) || 0
    const max = parseFloat(slider.max) || 100
    const val = parseFloat(slider.value)
    const pct = max > min ? ((val - min) / (max - min)) * 100 : 0
    slider.style.setProperty('--pct', `${pct.toFixed(1)}%`)
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

const KEY_HINT_HIDDEN_KEY = 'midee.keyHintHidden'

function loadKeyHintHidden(): boolean {
  return localStorage.getItem(KEY_HINT_HIDDEN_KEY) === 'true'
}

function saveKeyHintHidden(hidden: boolean): void {
  localStorage.setItem(KEY_HINT_HIDDEN_KEY, String(hidden))
}

function loopLabel(state: LoopState, layerCount: number): string {
  switch (state) {
    case 'idle':
      return 'Loop'
    case 'armed':
      return 'Play now…'
    case 'recording':
      return 'Stop'
    case 'playing':
      return layerCount > 1 ? `Loop ×${layerCount}` : 'Tap to overdub'
    case 'overdubbing':
      return `Overdub ${layerCount + 1}`
  }
}
