import { createSignal } from 'solid-js'
import { createStore, type SetStoreFunction } from 'solid-js/store'
import { render } from 'solid-js/web'
import type { AppServices } from '../core/services'
import { ENABLE_LEARN_MODE } from '../env'
import { t } from '../i18n'
import type { LiveLooperState } from '../midi/LiveLooper'
import type { MidiDeviceStatus } from '../midi/MidiInputManager'
import type { AppMode } from '../store/state'
import { watch } from '../store/watch'
import { icons } from './icons'

const SKIP_SECONDS = 10
export const ZOOM_MIN = 80
export const ZOOM_MAX = 600
export const ZOOM_DEFAULT = 200
const IDLE_MS = 2500

// Grouped UI state with field-level reactivity. Each top-level key is read
// individually in JSX so updates fan out only to the views that actually
// depend on the changed field.
interface UiStoreShape {
  context: { kicker: string; title: string }
  midi: { status: MidiDeviceStatus; deviceName: string }
  session: { recording: boolean; elapsed: number }
  loop: { state: LiveLooperState; layerCount: number; progressDeg: number }
  metro: { running: boolean; bpm: number }
  hudOffset: { dx: number; dy: number }
}

export interface ControlsOptions {
  container: HTMLElement
  services: AppServices
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
  onOctaveShift?: (delta: number) => void
}

interface TopStripProps {
  mode: () => AppMode
  status: () => string
  hasFile: () => boolean
  isLoadingFile: () => boolean
  context: () => { kicker: string; title: string }
  midiStatus: () => MidiDeviceStatus
  midiDeviceName: () => string
  midiPillLabel: () => string
  midiMenuLabel: () => string
  dim: () => boolean
  onHome: () => void
  onMode: (m: Exclude<AppMode, 'home'>) => void
  onOpenFile: () => void
  onTracks: () => void
  onMidi: () => void
  onRecord: () => void
  registerEl: (el: HTMLElement) => void
  registerTracksBtn: (el: HTMLButtonElement) => void
}

function TopStripView(props: TopStripProps) {
  const activeMode = (): string => {
    const m = props.mode()
    if (m === 'play' || m === 'live' || m === 'learn') return m
    return 'none'
  }
  return (
    <div
      id="top-strip"
      ref={(el) => props.registerEl(el)}
      class="strip--active"
      classList={{
        'strip--playing': props.mode() === 'play' && props.status() === 'playing',
        'strip--exporting': props.status() === 'exporting',
        'strip--dim': props.dim(),
      }}
      data-mode={props.mode()}
      data-has-file={props.hasFile() ? 'true' : 'false'}
      data-midi-status={props.midiStatus()}
    >
      <button
        class="ts-home"
        id="ts-home"
        type="button"
        aria-label="midee home"
        data-tip={t('topStrip.home')}
        onClick={() => props.onHome()}
        innerHTML={`${icons.wordmark()}<span class="ts-home-name">midee</span>`}
      />

      <div
        class="ts-mode-switch"
        role="tablist"
        aria-label={t('hud.aria.appMode')}
        data-active={activeMode()}
      >
        <button
          class="ts-mode-seg"
          classList={{ 'is-active': props.mode() === 'play' }}
          id="ts-mode-play"
          type="button"
          role="tab"
          aria-selected={props.mode() === 'play' ? 'true' : 'false'}
          data-tip={t('topStrip.modePlay')}
          onClick={() => props.onMode('play')}
        >
          <span class="ts-mode-icon" aria-hidden="true" innerHTML={icons.modePlay()} />
          <span class="ts-mode-label">Play</span>
        </button>
        <button
          class="ts-mode-seg"
          classList={{ 'is-active': props.mode() === 'live' }}
          id="ts-mode-live"
          type="button"
          role="tab"
          aria-selected={props.mode() === 'live' ? 'true' : 'false'}
          data-tip={t('topStrip.modeLive')}
          onClick={() => props.onMode('live')}
        >
          <span class="ts-mode-icon" aria-hidden="true" innerHTML={icons.modeLive()} />
          <span class="ts-mode-label">Live</span>
        </button>
        <button
          class="ts-mode-seg"
          classList={{ 'is-active': props.mode() === 'learn' }}
          id="ts-mode-learn"
          type="button"
          role="tab"
          aria-selected={props.mode() === 'learn' ? 'true' : 'false'}
          data-tip={t('topStrip.modeLearn')}
          onClick={() => props.onMode('learn')}
        >
          <span class="ts-mode-icon" aria-hidden="true" innerHTML={icons.practice()} />
          <span class="ts-mode-label">Learn</span>
        </button>
        <span class="ts-mode-thumb" aria-hidden="true" />
      </div>

      <div class="ts-status" id="ts-status" aria-live="polite">
        <span class="ts-status-dot" aria-hidden="true" />
        <span class="ts-status-main">
          <span class="ts-status-kicker" id="ts-context-kicker">
            {props.context().kicker}
          </span>
          <span class="ts-status-title" id="ts-context-title">
            {props.context().title}
          </span>
        </span>
        <span class="ts-bars" aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
        </span>
        <span id="ts-chord-slot" class="ts-chord-slot" />
      </div>

      <div class="ts-end">
        <button
          class="ts-pill"
          id="ts-open"
          type="button"
          aria-label={t('topStrip.openMidi')}
          data-tip={t('topStrip.openMidi')}
          onClick={() => props.onOpenFile()}
        >
          <span innerHTML={icons.upload()} />
          <span>{t('home.cta.openMidi')}</span>
        </button>
        <button
          ref={(el) => props.registerTracksBtn(el)}
          class="ts-pill ts-pill--file"
          classList={{
            hidden: !(props.mode() === 'play' && props.hasFile() && !props.isLoadingFile()),
          }}
          id="ts-tracks"
          type="button"
          aria-label={t('topStrip.tracks')}
          data-tip={t('topStrip.tracks')}
          onClick={() => props.onTracks()}
        >
          <span innerHTML={icons.tracks()} />
          <span>{t('topStrip.tracks')}</span>
        </button>
        <span id="ts-instrument-slot" />
        <div class="ts-sep" aria-hidden="true" />
        <button
          class="ts-pill ts-pill--midi"
          classList={{ 'ts-pill--on': props.midiStatus() === 'connected' }}
          id="ts-midi"
          type="button"
          aria-label={props.midiMenuLabel()}
          title={props.midiMenuLabel()}
          data-tip={t('topStrip.midi')}
          onClick={() => props.onMidi()}
        >
          <span innerHTML={icons.midi()} />
          <span id="ts-menu-midi-label" class="ts-midi-label">
            {props.midiPillLabel()}
          </span>
        </button>
        <span id="ts-customize-slot" />
        <button
          class="ts-record-btn"
          classList={{
            hidden: !(props.mode() === 'play' && props.hasFile() && !props.isLoadingFile()),
          }}
          id="ts-record"
          type="button"
          aria-label={t('topStrip.export')}
          data-tip={t('topStrip.export')}
          onClick={() => props.onRecord()}
        >
          <span innerHTML={icons.export()} />
          <span>Export</span>
        </button>
      </div>
    </div>
  )
}

interface HudProps {
  mode: () => AppMode
  status: () => string
  showPlayHud: () => boolean
  showLiveHud: () => boolean
  idle: () => boolean
  dragging: () => boolean
  pinned: () => boolean
  playing: () => boolean
  instrumentLoading: () => boolean
  sessionRecording: () => boolean
  sessionLabel: () => string
  loopState: () => LiveLooperState
  loopLabel: () => string
  loopProgressDeg: () => number
  loopActive: () => boolean
  loopSaveVisible: () => boolean
  loopUndoVisible: () => boolean
  metroRunning: () => boolean
  metroBpm: () => number
  hudDx: () => number
  hudDy: () => number
  onPlay: () => void
  onSkipBack: () => void
  onSkipFwd: () => void
  onVolume: (v: number) => void
  onSpeed: (v: number) => void
  onZoom: (v: number) => void
  onMetroToggle: () => void
  onBpmDec: () => void
  onBpmInc: () => void
  onBpmWheel: (e: WheelEvent) => void
  onSession: () => void
  onLoop: () => void
  onLoopUndo: () => void
  onLoopSave: () => void
  onLoopClear: () => void
  onPin: () => void
  onHudDragStart: (e: PointerEvent) => void
  onScrubberInput: () => void
  onScrubberChange: () => void
  onScrubberDown: () => void
  onScrubberTouch: () => void
  registerHud: (el: HTMLElement) => void
  registerScrubber: (el: HTMLInputElement) => void
  registerTime: (el: HTMLElement) => void
  registerDuration: (el: HTMLElement) => void
  registerMetroBeat: (el: HTMLElement) => void
  volume: () => number
  speed: () => number
  speedLabel: () => string
  zoom: () => number
}

function HudView(props: HudProps) {
  return (
    <div
      id="hud"
      ref={(el) => props.registerHud(el)}
      classList={{
        'hud--active': props.showPlayHud() || props.showLiveHud(),
        'hud--playing': props.mode() === 'play' && props.status() === 'playing',
        'hud--exporting': props.status() === 'exporting',
        'hud--live': props.showLiveHud(),
        'hud--play': props.showPlayHud(),
        'hud--idle': props.idle(),
        'hud--dragging': props.dragging(),
      }}
      style={{
        '--hud-dx': `${props.hudDx()}px`,
        '--hud-dy': `${props.hudDy()}px`,
      }}
    >
      <div class="hud-bar">
        <button
          class="hud-drag-handle"
          id="hud-drag"
          type="button"
          aria-label={t('hud.aria.drag')}
          data-tip={t('hud.drag')}
          onPointerDown={(e) => props.onHudDragStart(e)}
          innerHTML={icons.grip()}
        />
        <button
          class="hud-pin-btn"
          classList={{ 'hud-pin-btn--on': props.pinned() }}
          id="hud-pin"
          type="button"
          aria-label={t('hud.aria.pin')}
          aria-pressed={props.pinned() ? 'true' : 'false'}
          data-tip={t('hud.pin')}
          onClick={() => props.onPin()}
          innerHTML={icons.pin()}
        />

        <div class="hud-group hud-group--transport">
          <button
            type="button"
            class="btn-skip"
            id="hud-skip-back"
            aria-label={t('hud.aria.skipBack')}
            data-tip={t('hud.skipBack')}
            onClick={() => props.onSkipBack()}
            innerHTML={icons.skipBack()}
          />
          <button
            type="button"
            class="btn-play"
            classList={{ 'btn-play--loading': props.instrumentLoading() }}
            id="hud-play"
            aria-label={t('hud.aria.play')}
            data-tip={t('hud.play')}
            onClick={() => props.onPlay()}
            innerHTML={props.playing() ? icons.pause() : icons.play()}
          />
          <button
            type="button"
            class="btn-skip"
            id="hud-skip-fwd"
            aria-label={t('hud.aria.skipFwd')}
            data-tip={t('hud.skipFwd')}
            onClick={() => props.onSkipFwd()}
            innerHTML={icons.skipForward()}
          />
        </div>

        <div class="hud-divider hud-group--transport" />

        <div class="scrubber-wrap hud-group--transport">
          {/* @reactive-scrubber-forbidden — see docs/done/SOLID_MIGRATION_PLAN.md §2 rule 4 */}
          <span class="time-display" id="hud-time" ref={(el) => props.registerTime(el)}>
            0:00
          </span>
          {/* @reactive-scrubber-forbidden — see docs/done/SOLID_MIGRATION_PLAN.md §2 rule 4 */}
          <input
            ref={(el) => props.registerScrubber(el)}
            type="range"
            id="hud-scrubber"
            class="scrubber"
            min="0"
            max="100"
            step="0.1"
            value="0"
            aria-label={t('hud.aria.seek')}
            onMouseDown={() => props.onScrubberDown()}
            onTouchStart={() => props.onScrubberTouch()}
            onInput={() => props.onScrubberInput()}
            onChange={() => props.onScrubberChange()}
          />
          <span class="time-display dim" id="hud-duration" ref={(el) => props.registerDuration(el)}>
            0:00
          </span>
        </div>

        <div class="hud-divider hud-group--transport" />

        <div class="ctrl-group" data-tip={t('hud.volume')}>
          <span class="ctrl-icon" innerHTML={icons.volume()} />
          <input
            type="range"
            id="hud-volume"
            class="mini-slider"
            min="0"
            max="1"
            step="0.02"
            value={props.volume()}
            style={{ '--pct': `${props.volume() * 100}%` }}
            aria-label={t('hud.aria.volume')}
            onInput={(e) => props.onVolume(parseFloat(e.currentTarget.value))}
          />
        </div>

        <div class="ctrl-group hud-group--transport" data-tip={t('hud.speed')}>
          <span class="speed-val" id="hud-speed-val">
            {props.speedLabel()}
          </span>
          <input
            type="range"
            id="hud-speed"
            class="mini-slider"
            min="0.25"
            max="2"
            step="0.05"
            value={props.speed()}
            style={{ '--pct': `${((props.speed() - 0.25) / 1.75) * 100}%` }}
            aria-label={t('hud.aria.speed')}
            onInput={(e) => props.onSpeed(parseFloat(e.currentTarget.value))}
          />
        </div>

        <div class="hud-divider" />

        <div class="ctrl-group" data-tip={t('hud.zoom')}>
          <span class="ctrl-icon" innerHTML={icons.zoom()} />
          <input
            type="range"
            id="hud-zoom"
            class="mini-slider mini-slider--zoom"
            min={ZOOM_MIN}
            max={ZOOM_MAX}
            step="10"
            value={props.zoom()}
            style={{
              '--pct': `${((props.zoom() - ZOOM_MIN) / (ZOOM_MAX - ZOOM_MIN)) * 100}%`,
            }}
            aria-label={t('hud.aria.zoom')}
            onInput={(e) => props.onZoom(parseFloat(e.currentTarget.value))}
          />
        </div>

        <div class="hud-divider hud-group--live" />

        <div
          class="hud-metro hud-group--live"
          classList={{ 'hud-metro--on': props.metroRunning() }}
          id="hud-metro-group"
          onWheel={(e) => {
            e.preventDefault()
            props.onBpmWheel(e)
          }}
        >
          <button
            class="hud-metro-toggle"
            classList={{ 'hud-metro-toggle--on': props.metroRunning() }}
            id="hud-metro"
            type="button"
            aria-label={t('hud.aria.metronomeToggle')}
            data-tip={t('hud.metronome')}
            onClick={() => props.onMetroToggle()}
          >
            <span class="hud-metro-icon" innerHTML={icons.metronome()} />
            <span
              class="hud-metro-beat"
              aria-hidden="true"
              ref={(el) => props.registerMetroBeat(el)}
            />
          </button>
          <button
            class="hud-metro-step"
            id="hud-metro-dec"
            type="button"
            aria-label={t('hud.aria.bpmDec')}
            onClick={() => props.onBpmDec()}
          >
            −
          </button>
          <span class="hud-metro-bpm" id="hud-metro-bpm" data-tip={t('hud.bpm')} tabindex="0">
            {props.metroBpm()}
          </span>
          <button
            class="hud-metro-step"
            id="hud-metro-inc"
            type="button"
            aria-label={t('hud.aria.bpmInc')}
            onClick={() => props.onBpmInc()}
          >
            +
          </button>
        </div>

        <button
          class="hud-session-btn hud-group--live"
          classList={{ 'hud-session-btn--on': props.sessionRecording() }}
          id="hud-session"
          type="button"
          aria-label={t('hud.aria.session')}
          data-tip={t('hud.record')}
          onClick={() => props.onSession()}
        >
          <span class="hud-session-dot" aria-hidden="true" />
          <span class="hud-session-label" id="hud-session-label">
            {props.sessionLabel()}
          </span>
        </button>

        <button
          class="hud-loop-btn hud-group--live"
          id="hud-loop"
          type="button"
          aria-label={t('hud.aria.loop')}
          data-tip={t('hud.loop')}
          data-loop-state={props.loopState()}
          style={{ '--loop-progress': `${props.loopProgressDeg()}deg` }}
          onClick={() => props.onLoop()}
        >
          <span class="hud-loop-icon" innerHTML={icons.loop()} />
          <span class="hud-loop-label" id="hud-loop-label">
            {props.loopLabel()}
          </span>
        </button>
        <button
          class="hud-loop-undo hud-group--live"
          classList={{ hidden: !props.loopUndoVisible() }}
          id="hud-loop-undo"
          type="button"
          aria-label={t('hud.aria.loopUndo')}
          data-tip={t('hud.loopUndo')}
          onClick={() => props.onLoopUndo()}
          innerHTML={icons.undo()}
        />
        <button
          class="hud-loop-save hud-group--live"
          classList={{ hidden: !props.loopSaveVisible() }}
          id="hud-loop-save"
          type="button"
          aria-label={t('hud.aria.loopSave')}
          data-tip={t('hud.loopSave')}
          onClick={() => props.onLoopSave()}
          innerHTML={icons.download()}
        />
        <button
          class="hud-loop-clear hud-group--live"
          classList={{ hidden: !props.loopActive() }}
          id="hud-loop-clear"
          type="button"
          aria-label={t('hud.aria.loopClear')}
          data-tip={t('hud.loopClear')}
          onClick={() => props.onLoopClear()}
          innerHTML={icons.close()}
        />
      </div>
    </div>
  )
}

interface KeyHintProps {
  visible: () => boolean
  idle: () => boolean
  collapsed: () => boolean
  octave: () => number
  onOctaveDown: () => void
  onOctaveUp: () => void
  onClose: () => void
  onReopen: () => void
}

function KeyHintView(props: KeyHintProps) {
  return (
    <div
      id="key-hint"
      classList={{
        'kh--visible': props.visible(),
        'kh--idle': props.idle(),
        'kh--collapsed': props.collapsed(),
      }}
    >
      <div class="kh-body">
        <div class="kh-section kh-section--first">
          <div class="kh-section-head">
            <span class="kh-label">Play</span>
            <button
              class="kh-close"
              id="kh-close"
              type="button"
              aria-label={t('hud.aria.kbdRefHide')}
              data-tip={t('hud.tip.kbdRefHide')}
              onClick={() => props.onClose()}
              innerHTML={icons.smallClose()}
            />
          </div>
          <span class="kh-keys">
            <kbd>Z</kbd>
            <kbd>X</kbd>
            <kbd>C</kbd>
            <kbd>V</kbd>
            <span class="kh-divider" aria-hidden="true" />
            <kbd>Q</kbd>
            <kbd>W</kbd>
            <kbd>E</kbd>
            <kbd>R</kbd>
          </span>
        </div>

        <div class="kh-section">
          <span class="kh-label">Octave</span>
          <span class="kh-keys">
            <button
              class="kh-cap-btn"
              id="kh-octave-down"
              type="button"
              aria-label={t('hud.aria.octaveDown')}
              data-tip={t('hud.tip.octaveDown')}
              onClick={() => props.onOctaveDown()}
            >
              <kbd class="kh-cap-sym">↓</kbd>
            </button>
            <button
              class="kh-cap-btn"
              id="kh-octave-up"
              type="button"
              aria-label={t('hud.aria.octaveUp')}
              data-tip={t('hud.tip.octaveUp')}
              onClick={() => props.onOctaveUp()}
            >
              <kbd class="kh-cap-sym">↑</kbd>
            </button>
            <span class="kh-octave-pill" id="kh-octave">
              C{props.octave()}
            </span>
          </span>
        </div>

        <div class="kh-section">
          <span class="kh-label">Shortcuts</span>
          <div class="kh-shortcuts">
            <span class="kh-combo">
              <kbd>Tab</kbd>
              <span>Record</span>
            </span>
            <span class="kh-combo">
              <span class="kh-cap-group">
                <kbd class="kh-cap-sym">⇧</kbd>
                <kbd>L</kbd>
              </span>
              <span>Loop</span>
            </span>
            <span class="kh-combo">
              <span class="kh-cap-group">
                <kbd class="kh-cap-sym">⇧</kbd>
                <kbd>U</kbd>
              </span>
              <span>Undo</span>
            </span>
            <span class="kh-combo">
              <span class="kh-cap-group">
                <kbd class="kh-cap-sym">⇧</kbd>
                <kbd>C</kbd>
              </span>
              <span>Clear</span>
            </span>
            <span class="kh-combo">
              <kbd class="kh-cap-sym">`</kbd>
              <span>Metronome</span>
            </span>
          </div>
        </div>
      </div>
      <button
        class="kh-reopen"
        id="kh-reopen"
        type="button"
        aria-label={t('hud.aria.kbdRefShow')}
        data-tip={t('hud.tip.kbdRefShow')}
        onClick={() => props.onReopen()}
        innerHTML={icons.keycap()}
      />
    </div>
  )
}

export class Controls {
  private topStripEl!: HTMLElement
  private hudEl!: HTMLElement
  private scrubber!: HTMLInputElement
  private timeDisplay!: HTMLElement
  private durationEl!: HTMLElement
  private metroBeatEl!: HTMLElement
  private tracksBtn!: HTMLButtonElement

  private disposeRoot: (() => void) | null = null

  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private hudActivityLock = false
  private isScrubbing = false
  // Cached values for throttling DOM writes — only update when the user would
  // actually see a difference. Cuts ~180 DOM writes/sec during playback.
  private lastDisplaySec = -1
  private lastFillPct = -1
  private isDraggingHud = false
  private hudDragStartX = 0
  private hudDragStartY = 0
  private hudDragOriginX = 0
  private hudDragOriginY = 0
  private unsubs: Array<() => void> = []

  // Reactive state — drives the three JSX views. The six grouped fields
  // (context/midi/session/loop/metro/hudOffset) live on a single `createStore`
  // so partial writes (e.g. updating just `loop.progressDeg` at 60 Hz) only
  // re-fire JSX getters that read that exact field. The remaining flat
  // signals are independent flags whose updates don't fan out.
  private uiStore!: UiStoreShape
  private setUi!: SetStoreFunction<UiStoreShape>
  private readonly setDimTopStrip: (v: boolean) => void
  private readonly setHudIdle: (v: boolean) => void
  private readonly setHudDragging: (v: boolean) => void
  private readonly sigHudPinned: () => boolean
  private readonly setHudPinnedSig: (v: boolean) => void
  private readonly setInstrumentLoadingSig: (v: boolean) => void
  private readonly setKeyHintCollapsed: (v: boolean) => void
  private readonly setOctave: (v: number) => void
  private readonly setVolume: (v: number) => void
  private readonly setSpeed: (v: number) => void
  private readonly setZoom: (v: number) => void

  // Document-level listeners bound at construction.
  private onMouseMoveDoc = (): void => {
    if (this.hudEl?.classList.contains('hud--active')) this.wakeUp()
  }
  private onKeyDownDoc = (e: KeyboardEvent): void => this.handleKey(e)
  private onPointerMoveDoc = (e: PointerEvent): void => this.handleHudDragMove(e)
  private onPointerUpDoc = (): void => this.stopHudDrag()
  private onWindowResize = (): void => this.clampHudOffset()

  constructor(private opts: ControlsOptions) {
    const { store } = opts.services

    const [mode, setMode] = createSignal<AppMode>(store.state.mode)
    const [status, setStatus] = createSignal<string>(store.state.status)
    const [hasFile, setHasFile] = createSignal<boolean>(store.state.loadedMidi !== null)
    const [dimTopStrip, setDimTopStrip] = createSignal(false)
    const [hudIdle, setHudIdle] = createSignal(false)
    const [hudDragging, setHudDragging] = createSignal(false)
    const [hudPinned, setHudPinned] = createSignal(false)
    const [instrumentLoading, setInstrumentLoading] = createSignal(false)
    const [keyHintCollapsed, setKeyHintCollapsed] = createSignal(loadKeyHintHidden())
    const [octave, setOctave] = createSignal(4)
    const [volume, setVolumeSig] = createSignal(store.state.volume ?? 0.8)
    const [speed, setSpeedSig] = createSignal(store.state.speed ?? 1)
    const [zoom, setZoomSig] = createSignal(ZOOM_DEFAULT)

    const [uiStore, setUi] = createStore<UiStoreShape>({
      context: { kicker: 'Ready', title: 'Open MIDI or play live' },
      midi: { status: 'disconnected', deviceName: '' },
      session: { recording: false, elapsed: 0 },
      loop: { state: 'idle', layerCount: 0, progressDeg: 0 },
      metro: { running: false, bpm: 120 },
      hudOffset: { dx: 0, dy: 0 },
    })
    this.uiStore = uiStore
    this.setUi = setUi

    void mode
    this.setDimTopStrip = setDimTopStrip
    this.setHudIdle = setHudIdle
    this.setHudDragging = setHudDragging
    this.sigHudPinned = hudPinned
    this.setHudPinnedSig = setHudPinned
    this.setInstrumentLoadingSig = setInstrumentLoading
    this.setKeyHintCollapsed = setKeyHintCollapsed
    this.setOctave = setOctave
    this.setVolume = setVolumeSig
    this.setSpeed = setSpeedSig
    this.setZoom = setZoomSig

    // One Solid root hosts the three sibling views (TopStrip, HUD, KeyHint).
    // Single owner tree, single error-boundary scope, single schedule cycle —
    // and the views still render as DOM siblings under `opts.container`
    // because the wrapper uses `display: contents`.
    const rootWrap = document.createElement('div')
    rootWrap.style.display = 'contents'
    opts.container.appendChild(rootWrap)
    this.disposeRoot = render(
      () => (
        <>
          <TopStripView
            mode={mode}
            status={status}
            hasFile={hasFile}
            isLoadingFile={() => mode() === 'play' && status() === 'loading'}
            context={() => uiStore.context}
            midiStatus={() => uiStore.midi.status}
            midiDeviceName={() => uiStore.midi.deviceName}
            midiPillLabel={() => getMidiPillLabel(uiStore.midi.status, uiStore.midi.deviceName)}
            midiMenuLabel={() => getMidiMenuLabel(uiStore.midi.status, uiStore.midi.deviceName)}
            dim={dimTopStrip}
            onHome={() => opts.onHome?.()}
            onMode={(m) => opts.onModeRequest?.(m)}
            onOpenFile={() => opts.onOpenFile?.()}
            onTracks={() => opts.onOpenTracks?.()}
            onMidi={() => opts.onMidiConnect?.()}
            onRecord={() => opts.onRecord?.()}
            registerEl={(el) => {
              this.topStripEl = el
            }}
            registerTracksBtn={(el) => {
              this.tracksBtn = el
            }}
          />
          <HudView
            mode={mode}
            status={status}
            showPlayHud={() => mode() === 'play' && hasFile() && status() !== 'loading'}
            showLiveHud={() => mode() === 'live'}
            idle={hudIdle}
            dragging={hudDragging}
            pinned={hudPinned}
            playing={() => status() === 'playing'}
            instrumentLoading={instrumentLoading}
            sessionRecording={() => uiStore.session.recording}
            sessionLabel={() =>
              uiStore.session.recording ? formatMMSS(uiStore.session.elapsed) : 'Record'
            }
            loopState={() => uiStore.loop.state}
            loopLabel={() => loopLabel(uiStore.loop.state, uiStore.loop.layerCount)}
            loopProgressDeg={() => uiStore.loop.progressDeg}
            loopActive={() => {
              const s = uiStore.loop.state
              return s !== 'idle' && s !== 'armed'
            }}
            loopSaveVisible={() =>
              uiStore.loop.state === 'playing' || uiStore.loop.state === 'overdubbing'
            }
            loopUndoVisible={() => {
              const { state, layerCount } = uiStore.loop
              return state === 'overdubbing' || (state === 'playing' && layerCount >= 1)
            }}
            metroRunning={() => uiStore.metro.running}
            metroBpm={() => uiStore.metro.bpm}
            hudDx={() => uiStore.hudOffset.dx}
            hudDy={() => uiStore.hudOffset.dy}
            onPlay={() => this.handlePlayClick()}
            onSkipBack={() => this.handleSkip(-SKIP_SECONDS)}
            onSkipFwd={() => this.handleSkip(SKIP_SECONDS)}
            onVolume={(v) => {
              this.setVolume(v)
              store.setState('volume', v)
            }}
            onSpeed={(v) => {
              this.setSpeed(v)
              store.setState('speed', v)
            }}
            onZoom={(v) => {
              this.setZoom(v)
              opts.onZoom?.(v)
            }}
            onMetroToggle={() => opts.onMetronomeToggle?.()}
            onBpmDec={() => this.bumpBpm(-1)}
            onBpmInc={() => this.bumpBpm(+1)}
            onBpmWheel={(e) => {
              const dir = e.deltaY < 0 ? 1 : -1
              const step = e.shiftKey ? 10 : 1
              this.bumpBpm(dir * step)
            }}
            onSession={() => opts.onSessionToggle?.()}
            onLoop={() => opts.onLoopToggle?.()}
            onLoopUndo={() => opts.onLoopUndo?.()}
            onLoopSave={() => opts.onLoopSave?.()}
            onLoopClear={() => opts.onLoopClear?.()}
            onPin={() => this.togglePin()}
            onHudDragStart={(e) => this.startHudDrag(e)}
            onScrubberDown={() => {
              this.isScrubbing = true
              this.wakeUp()
            }}
            onScrubberTouch={() => {
              this.isScrubbing = true
            }}
            onScrubberInput={() => {
              const t = parseFloat(this.scrubber.value)
              this.timeDisplay.textContent = formatTime(t)
              this.updateFill(t)
            }}
            onScrubberChange={() => {
              this.isScrubbing = false
              const t = parseFloat(this.scrubber.value)
              this.invalidateTimeCache()
              opts.services.clock.seek(t)
              opts.onSeek?.(t)
            }}
            registerHud={(el) => {
              this.hudEl = el
            }}
            registerScrubber={(el) => {
              this.scrubber = el
            }}
            registerTime={(el) => {
              this.timeDisplay = el
            }}
            registerDuration={(el) => {
              this.durationEl = el
            }}
            registerMetroBeat={(el) => {
              this.metroBeatEl = el
            }}
            volume={volume}
            speed={speed}
            speedLabel={() => formatSpeed(speed())}
            zoom={zoom}
          />
          <KeyHintView
            visible={() => mode() === 'live'}
            idle={hudIdle}
            collapsed={keyHintCollapsed}
            octave={octave}
            onOctaveDown={() => opts.onOctaveShift?.(-1)}
            onOctaveUp={() => opts.onOctaveShift?.(+1)}
            onClose={() => {
              this.setKeyHintCollapsed(true)
              saveKeyHintHidden(true)
            }}
            onReopen={() => {
              this.setKeyHintCollapsed(false)
              saveKeyHintHidden(false)
            }}
          />
        </>
      ),
      rootWrap,
    )

    // Sync store → reactive signals.
    this.unsubs.push(
      watch(
        () => store.state.mode,
        (m) => {
          setMode(m)
          this.refreshUi()
        },
      ),
      watch(
        () => store.state.status,
        (s) => {
          setStatus(s)
          this.refreshUi()
        },
      ),
      watch(
        () => store.state.loadedMidi,
        (midi) => {
          setHasFile(midi !== null)
          this.refreshUi()
        },
      ),
      watch(
        () => store.state.duration,
        (d) => {
          this.scrubber.max = String(d)
          this.durationEl.textContent = formatTime(d)
        },
      ),
    )

    // 60Hz clock tick — imperative per §2 rule 4.
    this.unsubs.push(
      opts.services.clock.subscribe((t) => {
        if (store.state.mode !== 'play' || this.isScrubbing) return
        // Skip UI updates during export — frame-by-frame seeks would thrash the
        // scrubber behind the export modal and compete with the encoder.
        if (store.state.status === 'exporting') return
        const dur = store.state.duration

        // @reactive-scrubber-forbidden — see docs/done/SOLID_MIGRATION_PLAN.md §2 rule 4
        this.scrubber.value = String(t)

        const sec = Math.floor(t)
        if (sec !== this.lastDisplaySec) {
          // @reactive-scrubber-forbidden — see docs/done/SOLID_MIGRATION_PLAN.md §2 rule 4
          this.timeDisplay.textContent = formatTime(t)
          this.lastDisplaySec = sec
        }

        const pct = dur > 0 ? Math.min((t / dur) * 100, 100) : 0
        if (Math.abs(pct - this.lastFillPct) >= 0.1) {
          // @reactive-scrubber-forbidden — see docs/done/SOLID_MIGRATION_PLAN.md §2 rule 4
          this.scrubber.style.setProperty('--pct', `${pct.toFixed(1)}%`)
          this.lastFillPct = pct
        }

        if (dur > 0 && t >= dur) {
          opts.services.clock.pause()
          opts.services.clock.seek(0)
          store.setState('status', 'ready')
        }
      }),
    )

    document.addEventListener('mousemove', this.onMouseMoveDoc)
    document.addEventListener('keydown', this.onKeyDownDoc)
    window.addEventListener('resize', this.onWindowResize)

    this.refreshUi()
  }

  // ── Public methods (called by App) ──────────────────────────────────

  updateThemeDot(_color: string): void {}
  updateThemeLabel(_name: string): void {}
  updateInstrument(_name: string): void {}
  updateParticleStyle(_name: string): void {}
  updateChordOverlayState(_on: boolean): void {}

  updateOctave(octave: number): void {
    this.setOctave(octave)
  }

  updateSessionRecording(recording: boolean, elapsedSec: number): void {
    this.setUi('session', { recording, elapsed: elapsedSec })
  }

  // Hot path: fires every animation frame while a loop is recording / playing.
  // Field-level write so JSX getters that read `loop.state` / `layerCount`
  // don't re-fire on every frame — only `loopProgressDeg` does.
  updateLoopProgress(fraction: number): void {
    const deg = Math.max(0, Math.min(1, fraction)) * 360
    this.setUi('loop', 'progressDeg', deg)
  }

  updateMetronome(running: boolean, bpm: number): void {
    this.setUi('metro', { running, bpm })
  }

  // Called once per beat from Metronome; triggers a brief visual pulse on the
  // icon. Restarts the CSS animation by toggling the class off and on after a
  // forced reflow.
  pulseMetronomeBeat(isDownbeat: boolean): void {
    this.metroBeatEl.classList.remove('hud-metro-beat--tick', 'hud-metro-beat--down')
    void this.metroBeatEl.offsetWidth
    this.metroBeatEl.classList.add(isDownbeat ? 'hud-metro-beat--down' : 'hud-metro-beat--tick')
  }

  setHudPinned(pinned: boolean): void {
    this.setHudPinnedSig(pinned)
    if (pinned) this.clearIdle()
    else this.scheduleIdle()
  }

  setHudActivityLock(locked: boolean): void {
    if (this.hudActivityLock === locked) return
    this.hudActivityLock = locked
    if (locked) this.clearIdle()
    else this.scheduleIdle()
  }

  updateLoopState(state: LiveLooperState, layerCount: number): void {
    // Merge — leaves `progressDeg` alone so per-frame writes don't race.
    this.setUi('loop', { state, layerCount })
  }

  setInstrumentLoading(loading: boolean): void {
    this.setInstrumentLoadingSig(loading)
  }

  updateMidiStatus(status: MidiDeviceStatus, deviceName: string): void {
    this.setUi('midi', { status, deviceName })
    this.refreshUi()
  }

  get tracksButton(): HTMLElement {
    return this.tracksBtn
  }
  get instrumentSlot(): HTMLElement {
    return this.topStripEl.querySelector<HTMLElement>('#ts-instrument-slot')!
  }
  get chordSlot(): HTMLElement {
    return this.topStripEl.querySelector<HTMLElement>('#ts-chord-slot')!
  }
  get customizeSlot(): HTMLElement {
    return this.topStripEl.querySelector<HTMLElement>('#ts-customize-slot')!
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
    this.disposeRoot?.()
    this.disposeRoot = null
  }

  // ── Private helpers ─────────────────────────────────────────────────

  private handlePlayClick(): void {
    const { store, clock } = this.opts.services
    if (store.state.mode !== 'play') return
    const s = store.state.status
    if (s === 'playing') {
      clock.pause()
      store.setState('status', 'paused')
    } else if (s === 'paused' || s === 'ready') {
      clock.play()
      store.setState('status', 'playing')
    }
  }

  private handleSkip(delta: number): void {
    const { store, clock } = this.opts.services
    if (store.state.mode !== 'play') return
    const next =
      delta < 0
        ? Math.max(0, clock.currentTime + delta)
        : Math.min(store.state.duration, clock.currentTime + delta)
    this.invalidateTimeCache()
    clock.seek(next)
    this.opts.onSeek?.(next)
  }

  private handleKey(e: KeyboardEvent): void {
    const target = e.target as HTMLElement
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return
    const mode = this.opts.services.store.state.mode

    if (e.shiftKey && e.code === 'KeyP') {
      e.preventDefault()
      this.togglePin()
      return
    }

    if (mode === 'play') {
      if (e.code === 'Space') {
        e.preventDefault()
        this.handlePlayClick()
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault()
        this.handleSkip(-SKIP_SECONDS)
      } else if (e.code === 'ArrowRight') {
        e.preventDefault()
        this.handleSkip(SKIP_SECONDS)
      } else if (e.code === 'KeyT') {
        this.opts.onOpenTracks?.()
      } else if (e.code === 'KeyR') {
        if (!this.hudEl.classList.contains('hud--exporting')) {
          this.opts.onRecord?.()
        }
      }
      return
    }

    if (mode === 'live') {
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

  private togglePin(): void {
    const next = !this.sigHudPinned()
    this.setHudPinned(next)
    this.opts.onHudPinChange?.(next)
  }

  private bumpBpm(delta: number): void {
    const current = this.uiStore.metro.bpm
    this.opts.onMetronomeBpmChange?.(current + delta)
  }

  private refreshUi(): void {
    const { store } = this.opts.services
    const mode = store.state.mode
    const status = store.state.status
    const isPlayMode = mode === 'play'
    const showLiveHud = mode === 'live'

    this.renderContext(mode, store.state.loadedMidi?.name ?? null)

    if ((isPlayMode && status === 'playing') || showLiveHud) {
      this.scheduleIdle()
    } else {
      this.clearIdle()
    }
    // Clamp any drag offset whenever the HUD visibility or layout changes.
    this.clampHudOffset()
  }

  private renderContext(mode: AppMode, fileName: string | null): void {
    const midi = this.uiStore.midi

    if (mode === 'play' && this.opts.services.store.state.status === 'loading') {
      this.setUi('context', { kicker: 'Loading', title: 'Opening MIDI' })
      return
    }

    if (mode === 'live') {
      this.setUi('context', {
        kicker: 'Live',
        title:
          midi.status === 'connected'
            ? midi.deviceName || 'MIDI session'
            : 'Play with your keyboard',
      })
      return
    }

    if (mode === 'play') {
      this.setUi('context', { kicker: 'Now playing', title: fileName ?? 'Open MIDI' })
      return
    }

    if (mode === 'learn') {
      this.setUi('context', {
        kicker: ENABLE_LEARN_MODE ? 'Learn' : 'Coming soon',
        title: ENABLE_LEARN_MODE
          ? 'Exercises, ear training, sight reading'
          : 'Learn mode is on the way',
      })
      return
    }

    this.setUi('context', { kicker: 'Ready', title: 'Open MIDI or play live' })
  }

  private wakeUp(): void {
    this.setDimTopStrip(false)
    this.setHudIdle(false)
    this.scheduleIdle()
  }

  private scheduleIdle(): void {
    this.clearIdle()
    if (this.sigHudPinned() || this.hudActivityLock) return
    const mode = this.opts.services.store.state.mode
    const status = this.opts.services.store.state.status
    const isPlaying = mode === 'play' && status === 'playing'
    const isLive = mode === 'live'
    if (!isPlaying && !isLive) return
    this.idleTimer = setTimeout(() => {
      if (!this.isScrubbing) {
        this.setDimTopStrip(true)
        this.setHudIdle(true)
      }
    }, IDLE_MS)
  }

  private clearIdle(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
    this.setDimTopStrip(false)
    this.setHudIdle(false)
  }

  private startHudDrag(e: PointerEvent): void {
    e.preventDefault()
    this.isDraggingHud = true
    this.hudDragStartX = e.clientX
    this.hudDragStartY = e.clientY
    const off = this.uiStore.hudOffset
    this.hudDragOriginX = off.dx
    this.hudDragOriginY = off.dy
    this.setHudDragging(true)
    document.addEventListener('pointermove', this.onPointerMoveDoc)
    document.addEventListener('pointerup', this.onPointerUpDoc)
  }

  private handleHudDragMove(e: PointerEvent): void {
    if (!this.isDraggingHud) return
    this.setUi('hudOffset', {
      dx: this.hudDragOriginX + (e.clientX - this.hudDragStartX),
      dy: this.hudDragOriginY + (e.clientY - this.hudDragStartY),
    })
    this.clampHudOffset()
  }

  private stopHudDrag(): void {
    if (!this.isDraggingHud) return
    this.isDraggingHud = false
    this.setHudDragging(false)
    document.removeEventListener('pointermove', this.onPointerMoveDoc)
    document.removeEventListener('pointerup', this.onPointerUpDoc)
  }

  private clampHudOffset(): void {
    if (!this.hudEl) return
    const hudRect = this.hudEl.getBoundingClientRect()
    if (hudRect.width === 0 || hudRect.height === 0) return

    const rootStyles = getComputedStyle(document.documentElement)
    const keyboardHeight = parseFloat(rootStyles.getPropertyValue('--keyboard-h')) || 120
    const hudGap = parseFloat(rootStyles.getPropertyValue('--hud-gap')) || 14
    const defaultLeft = (window.innerWidth - hudRect.width) / 2
    const defaultTop = window.innerHeight - keyboardHeight - hudGap - hudRect.height
    const topStripBottom = this.topStripEl.getBoundingClientRect().bottom
    const minLeft = 12
    const maxLeft = Math.max(minLeft, window.innerWidth - hudRect.width - 12)
    const minTop = Math.max(topStripBottom + 12, 12)
    const maxTop = Math.max(minTop, window.innerHeight - keyboardHeight - hudRect.height - 12)
    const { dx, dy } = this.uiStore.hudOffset
    const nextLeft = clamp(defaultLeft + dx, minLeft, maxLeft)
    const nextTop = clamp(defaultTop + dy, minTop, maxTop)

    this.setUi('hudOffset', { dx: nextLeft - defaultLeft, dy: nextTop - defaultTop })
  }

  private updateFill(t: number): void {
    const dur = this.opts.services.store.state.duration
    const pct = dur > 0 ? Math.min((t / dur) * 100, 100) : 0
    this.scrubber.style.setProperty('--pct', `${pct}%`)
  }

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

function loopLabel(state: LiveLooperState, layerCount: number): string {
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
