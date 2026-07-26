import { createEffect, onCleanup, onMount } from 'solid-js'
import type { VisualizationMode } from '../guitar/types'
import { t } from '../i18n'
import type { LiveLooperState } from '../midi/LiveLooper'
import type { MidiDeviceStatus } from '../midi/MidiInputManager'
import type { AppMode } from '../store/state'
import { FloatingHud } from './FloatingHud'
import { icons } from './icons'
import { VisualizationSelector } from './VisualizationSelector'

export const ZOOM_MIN = 80
export const ZOOM_MAX = 600
export const ZOOM_DEFAULT = 200

// ── View component interfaces ────────────────────────────────────────────

export interface TopStripProps {
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
  onLearnThis: () => void
  registerEl: (el: HTMLElement) => void
  registerTracksBtn: (el: HTMLButtonElement) => void
  visualizationMode: () => VisualizationMode
  visualizationDisabled: () => boolean
  onVisualizationChange: (mode: VisualizationMode) => void
}

export interface HudProps {
  mode: () => AppMode
  status: () => string
  showPlayHud: () => boolean
  showLiveHud: () => boolean
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
  onScrubberInput: () => void
  onScrubberChange: () => void
  onScrubberDown: () => void
  onScrubberTouch: () => void
  registerScrubber: (el: HTMLInputElement) => void
  registerTime: (el: HTMLElement) => void
  registerDuration: (el: HTMLElement) => void
  registerMetroBeat: (el: HTMLElement) => void
  volume: () => number
  speed: () => number
  speedLabel: () => string
  zoom: () => number
  wakeRef: (fn: () => void) => void
  togglePinRef: (fn: () => void) => void
  onIdleChange: (idle: boolean) => void
  onHasDragged: () => void
  // Session-only collapse: when closed, the pill shrinks to a small draggable
  // icon (handled inside FloatingHud). Not persisted — always starts open.
  closed: () => boolean
  onClose: () => void
  onReopen: () => void
}

export interface KeyHintProps {
  visible: () => boolean
  idle: () => boolean
  collapsed: () => boolean
  octave: () => number
  onOctaveDown: () => void
  onOctaveUp: () => void
  onClose: () => void
  onReopen: () => void
}

// ── View components ──────────────────────────────────────────────────────

export function TopStripView(props: TopStripProps) {
  const activeMode = (): string => {
    const m = props.mode()
    if (m === 'play' || m === 'live' || m === 'learn') return m
    return 'none'
  }

  // Mode-switch thumb. Segments are content-width (labels differ per locale
  // and inactive labels hide on narrow screens), so the thumb can't use a
  // static one-third position — we measure the active segment and slide the
  // thumb to its exact offset/width. offsetLeft/offsetWidth and the thumb's
  // own offsetLeft all share the same offsetParent (the switch), so their
  // difference is the precise translation regardless of border/padding.
  let thumbEl: HTMLSpanElement | undefined
  const segEls: Partial<Record<'play' | 'live' | 'learn', HTMLButtonElement>> = {}

  // animate=false snaps without a slide — used for the first paint and for
  // resize/font reflows, where a sliding thumb would look like a glitch.
  const positionThumb = (animate = true): void => {
    if (!thumbEl) return
    const m = activeMode()
    const seg = m === 'play' || m === 'live' || m === 'learn' ? segEls[m] : undefined
    if (!seg) {
      thumbEl.style.opacity = '0'
      return
    }
    if (!animate) thumbEl.style.transition = 'none'
    thumbEl.style.width = `${seg.offsetWidth}px`
    thumbEl.style.transform = `translateX(${seg.offsetLeft - thumbEl.offsetLeft}px)`
    thumbEl.style.opacity = '1'
    if (!animate) {
      void thumbEl.offsetWidth // flush the snap before restoring transitions
      thumbEl.style.transition = ''
    }
  }

  // Reposition on mode change (label visibility shifts segment widths too).
  // First run snaps into place; subsequent mode changes slide.
  let primed = false
  createEffect(() => {
    activeMode()
    positionThumb(primed)
    primed = true
  })

  onMount(() => {
    // Web-font swap can change label metrics after first paint.
    if (document.fonts?.ready) void document.fonts.ready.then(() => positionThumb(false))
    // Breakpoints toggle labels / padding, changing segment widths.
    const onResize = (): void => positionThumb(false)
    window.addEventListener('resize', onResize)
    onCleanup(() => window.removeEventListener('resize', onResize))
  })

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
        aria-label={t('home.aria')}
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
          ref={(el) => (segEls.play = el)}
          type="button"
          role="tab"
          aria-selected={props.mode() === 'play' ? 'true' : 'false'}
          data-tip={t('topStrip.modePlay')}
          onClick={() => props.onMode('play')}
        >
          <span class="ts-mode-icon" aria-hidden="true" innerHTML={icons.modePlay()} />
          <span class="ts-mode-label">{t('topStrip.mode.play.label')}</span>
        </button>
        <button
          class="ts-mode-seg"
          classList={{ 'is-active': props.mode() === 'live' }}
          id="ts-mode-live"
          ref={(el) => (segEls.live = el)}
          type="button"
          role="tab"
          aria-selected={props.mode() === 'live' ? 'true' : 'false'}
          data-tip={t('topStrip.modeLive')}
          onClick={() => props.onMode('live')}
        >
          <span class="ts-mode-icon" aria-hidden="true" innerHTML={icons.modeLive()} />
          <span class="ts-mode-label">{t('topStrip.mode.live.label')}</span>
        </button>
        <button
          class="ts-mode-seg"
          classList={{ 'is-active': props.mode() === 'learn' }}
          id="ts-mode-learn"
          ref={(el) => (segEls.learn = el)}
          type="button"
          role="tab"
          aria-selected={props.mode() === 'learn' ? 'true' : 'false'}
          data-tip={t('topStrip.modeLearn')}
          onClick={() => props.onMode('learn')}
        >
          <span class="ts-mode-icon" aria-hidden="true" innerHTML={icons.practice()} />
          <span class="ts-mode-label">{t('topStrip.mode.learn.label')}</span>
        </button>
        <span class="ts-mode-thumb" aria-hidden="true" ref={(el) => (thumbEl = el)} />
      </div>

      <div class="ts-status" id="ts-status" aria-live="polite">
        <span class="ts-status-dot" aria-hidden="true" />
        <span class="ts-status-main">
          <span class="ts-status-kicker" id="ts-context-kicker">
            {props.context().kicker}
          </span>
          <span class="ts-status-title" id="ts-context-title" title={props.context().title}>
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
        {/* Appearance/Customize is pinned near the start of the right cluster
            so the strip's right-edge overflow (the grid never shrinks .ts-end —
            see #top-strip in main.css) clips the contextual pills (export,
            MIDI, tracks) before it ever reaches Appearance. */}
        <span id="ts-customize-slot" />
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
        <button
          class="ts-pill ts-pill--file"
          classList={{
            hidden: !(props.mode() === 'play' && props.hasFile() && !props.isLoadingFile()),
          }}
          id="ts-learn-this"
          type="button"
          aria-label={t('topStrip.learnThis.aria')}
          data-tip={t('topStrip.learnThis.tip')}
          onClick={() => props.onLearnThis()}
        >
          <span innerHTML={icons.practice()} />
          <span>{t('topStrip.learnThis.label')}</span>
        </button>
        <VisualizationSelector
          mode={props.visualizationMode()}
          disabled={props.visualizationDisabled()}
          onChange={(m) => props.onVisualizationChange(m)}
        />
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
          <span>{t('topStrip.export.label')}</span>
        </button>
      </div>
    </div>
  )
}

export function HudView(props: HudProps) {
  return (
    <FloatingHud
      id="hud"
      dragBtnId="hud-drag"
      storageKey="midee.hud"
      classList={() => ({
        'hud--active': props.showPlayHud() || props.showLiveHud(),
        'hud--playing': props.mode() === 'play' && props.status() === 'playing',
        'hud--exporting': props.status() === 'exporting',
        'hud--live': props.showLiveHud(),
        'hud--play': props.showPlayHud(),
      })}
      idleEnabled={() => (props.showPlayHud() && props.playing()) || props.showLiveHud()}
      locked={() => props.sessionRecording() || props.loopActive() || props.metroRunning()}
      wakeRef={props.wakeRef}
      togglePinRef={props.togglePinRef}
      onIdleChange={props.onIdleChange}
      onHasDragged={props.onHasDragged}
      collapsed={props.closed}
      onClose={props.onClose}
      onReopen={props.onReopen}
    >
      <div class="hud-bar">
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
          <span class="time-display" id="hud-time" ref={(el) => props.registerTime(el)}>
            0:00
          </span>
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
            data-tip={t('hud.bpm')}
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
            data-tip={t('hud.bpm')}
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
    </FloatingHud>
  )
}

export function KeyHintView(props: KeyHintProps) {
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
            <span class="kh-label">{t('keyHint.play')}</span>
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
          <span class="kh-label">{t('keyHint.octave')}</span>
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
          <span class="kh-label">{t('keyHint.shortcuts')}</span>
          <div class="kh-shortcuts">
            <span class="kh-combo">
              <kbd>Tab</kbd>
              <span>{t('keyHint.shortcut.record')}</span>
            </span>
            <span class="kh-combo">
              <span class="kh-cap-group">
                <kbd class="kh-cap-sym">⇧</kbd>
                <kbd>L</kbd>
              </span>
              <span>{t('keyHint.shortcut.loop')}</span>
            </span>
            <span class="kh-combo">
              <span class="kh-cap-group">
                <kbd class="kh-cap-sym">⇧</kbd>
                <kbd>U</kbd>
              </span>
              <span>{t('keyHint.shortcut.undo')}</span>
            </span>
            <span class="kh-combo">
              <span class="kh-cap-group">
                <kbd class="kh-cap-sym">⇧</kbd>
                <kbd>C</kbd>
              </span>
              <span>{t('keyHint.shortcut.clear')}</span>
            </span>
            <span class="kh-combo">
              <kbd class="kh-cap-sym">`</kbd>
              <span>{t('keyHint.shortcut.metronome')}</span>
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

// ── Helpers ──────────────────────────────────────────────────────────────

export function getMidiMenuLabel(status: MidiDeviceStatus, deviceName: string): string {
  if (status === 'connected')
    return t('topStrip.midi.connectedMenu', {
      name: deviceName || t('topStrip.midi.connectedDefault'),
    })
  if (status === 'blocked') return t('topStrip.midi.blockedMenu')
  if (status === 'unavailable') return t('topStrip.midi.unavailableMenu')
  return t('topStrip.midi.disconnectedMenu')
}

export function getMidiPillLabel(status: MidiDeviceStatus, deviceName: string): string {
  if (status === 'connected') {
    const n = deviceName.split(',')[0]?.trim()
    return n && n.length < 22 ? n : t('topStrip.midi.pillFallback')
  }
  if (status === 'blocked') return t('topStrip.midi.blockedPill')
  return t('topStrip.midi.pillFallback')
}

export function formatTime(s: number): string {
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${sec.toString().padStart(2, '0')}`
}

export function formatMMSS(s: number): string {
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`
}

export function formatSpeed(s: number): string {
  if (s === 1) return '1x'
  return `${s % 1 === 0 ? s : s.toFixed(2).replace(/0+$/, '')}x`
}

export function loopLabel(state: LiveLooperState, layerCount: number): string {
  switch (state) {
    case 'idle':
      return t('hud.loop.label.idle')
    case 'armed':
      return t('hud.loop.label.armed')
    case 'recording':
      return t('hud.loop.label.recording')
    case 'playing':
      return layerCount > 1
        ? t('hud.loop.label.playingMulti', { count: layerCount })
        : t('hud.loop.label.playing')
    case 'overdubbing':
      return t('hud.loop.label.overdub', { count: layerCount + 1 })
  }
}

const KEY_HINT_HIDDEN_KEY = 'midee.keyHintHidden'

export function loadKeyHintHidden(): boolean {
  return localStorage.getItem(KEY_HINT_HIDDEN_KEY) === 'true'
}

export function saveKeyHintHidden(hidden: boolean): void {
  localStorage.setItem(KEY_HINT_HIDDEN_KEY, String(hidden))
}

const HUD_HAS_DRAGGED_KEY = 'midee.hudHasDragged'

export function loadHudHasDragged(): boolean {
  try {
    return localStorage.getItem(HUD_HAS_DRAGGED_KEY) === '1'
  } catch {
    return false
  }
}

export function saveHudHasDragged(): void {
  try {
    localStorage.setItem(HUD_HAS_DRAGGED_KEY, '1')
  } catch {
    // Ignore — privacy mode just shows the coachmark again next session.
  }
}
