import { createSignal } from 'solid-js'
import { createStore, type SetStoreFunction } from 'solid-js/store'
import { render } from 'solid-js/web'
import type { AppServices } from '../core/services'
import type { VisualizationMode } from '../guitar/types'
import { t } from '../i18n'
import type { LiveLooperState } from '../midi/LiveLooper'
import type { MidiDeviceStatus } from '../midi/MidiInputManager'
import type { AppMode } from '../store/state'
import { watch } from '../store/watch'
import { trackEvent, trackEventSettled } from '../telemetry'
import {
  formatMMSS,
  formatSpeed,
  formatTime,
  getMidiMenuLabel,
  getMidiPillLabel,
  HudView,
  KeyHintView,
  loadHudHasDragged,
  loadKeyHintHidden,
  loopLabel,
  saveHudHasDragged,
  saveKeyHintHidden,
  TopStripView,
  ZOOM_DEFAULT,
} from './ControlsView'
import { DragCoachmark } from './DragCoachmark'
import { isLearnCoachmarkSeen, LearnCoachmark } from './LearnCoachmark'

const SKIP_SECONDS = 10

export { ZOOM_DEFAULT, ZOOM_MAX, ZOOM_MIN } from './ControlsView'

// Grouped UI state with field-level reactivity. Each top-level key is read
// individually in JSX so updates fan out only to the views that actually
// depend on the changed field.
interface UiStoreShape {
  context: { kicker: string; title: string }
  midi: { status: MidiDeviceStatus; deviceName: string }
  session: { recording: boolean; elapsed: number }
  loop: { state: LiveLooperState; layerCount: number; progressDeg: number }
  metro: { running: boolean; bpm: number }
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
  onLearnThis?: () => void
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
  onChordToggle?: () => void
  onOctaveShift?: (delta: number) => void
  onVisualizationChange?: (mode: VisualizationMode) => void
}

export class Controls {
  private topStripEl!: HTMLElement
  private scrubber!: HTMLInputElement
  private timeDisplay!: HTMLElement
  private durationEl!: HTMLElement
  private metroBeatEl!: HTMLElement
  private tracksBtn!: HTMLButtonElement

  private disposeRoot: (() => void) | null = null

  // Content-driven label collapse (see evaluateCompact + the .ts-compact rules
  // in main.css). Observers re-run the measurement on strip resize and on
  // title-text changes (a new song doesn't change the strip's size).
  private titleEl: HTMLElement | null = null
  private compactRO: ResizeObserver | null = null
  private compactMO: MutationObserver | null = null
  private compactRaf = 0

  private isScrubbing = false
  private learnFileName: string | null = null
  private lastDisplaySec = -1
  private lastFillPct = -1
  private unsubs: Array<() => void> = []

  // Escape hatches into FloatingHud's reactive state.
  private hudWake: (() => void) | null = null
  private hudTogglePin: (() => void) | null = null

  // Reactive state — drives the three JSX views.
  private uiStore!: UiStoreShape
  private setUi!: SetStoreFunction<UiStoreShape>
  private readonly setDimTopStrip: (v: boolean) => void
  private readonly setHudIdle: (v: boolean) => void
  private readonly setHudHasDragged: (v: boolean) => void
  private readonly hudHasDraggedSig: () => boolean
  private readonly setInstrumentLoadingSig: (v: boolean) => void
  private readonly setKeyHintCollapsed: (v: boolean) => void
  private readonly setHudClosed: (v: boolean) => void
  private readonly hudClosedSig: () => boolean
  private readonly setOctave: (v: number) => void
  private readonly setVolume: (v: number) => void
  private readonly setSpeed: (v: number) => void
  private readonly setZoom: (v: number) => void

  // Document-level listeners bound at construction.
  private onMouseMoveDoc = (): void => {
    const { store } = this.opts.services
    const m = store.state.mode
    if (m === 'play' || m === 'live') this.wakeUp()
  }
  private onKeyDownDoc = (e: KeyboardEvent): void => this.handleKey(e)

  constructor(private opts: ControlsOptions) {
    const { store } = opts.services

    const [mode, setMode] = createSignal<AppMode>(store.state.mode)
    const [status, setStatus] = createSignal<string>(store.state.status)
    const [hasFile, setHasFile] = createSignal<boolean>(store.state.loadedMidi !== null)
    const [dimTopStrip, setDimTopStrip] = createSignal(false)
    const [hudIdle, setHudIdle] = createSignal(false)
    const [hudHasDragged, setHudHasDragged] = createSignal(loadHudHasDragged())
    // Reactive mirror of the learn-coachmark "seen" flag so the drag
    // coachmark's eligibility re-evaluates the moment Learn fires (the
    // localStorage read alone is not reactive).
    const [learnCoachmarkSeen, setLearnCoachmarkSeen] = createSignal(isLearnCoachmarkSeen())
    const [instrumentLoading, setInstrumentLoading] = createSignal(false)
    const [keyHintCollapsed, setKeyHintCollapsed] = createSignal(loadKeyHintHidden())
    // Session-only: the HUD always starts open on load (not persisted).
    const [hudClosed, setHudClosed] = createSignal(false)
    const [octave, setOctave] = createSignal(4)
    const [volume, setVolumeSig] = createSignal(store.state.volume ?? 0.8)
    const [speed, setSpeedSig] = createSignal(store.state.speed ?? 1)
    const [zoom, setZoomSig] = createSignal(ZOOM_DEFAULT)
    // Reflects the *effective* mode (Learn's force wins over the saved
    // preference) so the selector shows what's actually on screen.
    const [visualizationMode, setVisualizationMode] = createSignal<VisualizationMode>(
      store.effectiveVisualizationMode,
    )
    const [visualizationDisabled, setVisualizationDisabled] = createSignal(
      store.state.visualizationForced !== null,
    )

    const [uiStore, setUi] = createStore<UiStoreShape>({
      context: {
        kicker: t('topStrip.context.ready.kicker'),
        title: t('topStrip.context.ready.title'),
      },
      midi: { status: 'disconnected', deviceName: '' },
      session: { recording: false, elapsed: 0 },
      loop: { state: 'idle', layerCount: 0, progressDeg: 0 },
      metro: { running: false, bpm: 120 },
    })
    this.uiStore = uiStore
    this.setUi = setUi

    void mode
    this.setDimTopStrip = setDimTopStrip
    this.setHudIdle = setHudIdle
    this.setHudHasDragged = setHudHasDragged
    this.hudHasDraggedSig = hudHasDragged
    this.setInstrumentLoadingSig = setInstrumentLoading
    this.setKeyHintCollapsed = setKeyHintCollapsed
    this.setHudClosed = setHudClosed
    this.hudClosedSig = hudClosed
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
            onLearnThis={() => opts.onLearnThis?.()}
            visualizationMode={visualizationMode}
            visualizationDisabled={visualizationDisabled}
            onVisualizationChange={(m) => opts.onVisualizationChange?.(m)}
            registerEl={(el) => {
              this.topStripEl = el
              this.setupCompactObserver(el)
            }}
            registerTracksBtn={(el) => {
              this.tracksBtn = el
            }}
          />
          <LearnCoachmark
            eligible={() =>
              mode() === 'play' && hasFile() && status() !== 'loading' && status() !== 'exporting'
            }
            onShow={() => setLearnCoachmarkSeen(true)}
          />
          <HudView
            mode={mode}
            status={status}
            showPlayHud={() => mode() === 'play' && hasFile() && status() !== 'loading'}
            showLiveHud={() => mode() === 'live'}
            playing={() => status() === 'playing'}
            instrumentLoading={instrumentLoading}
            sessionRecording={() => uiStore.session.recording}
            sessionLabel={() =>
              uiStore.session.recording
                ? formatMMSS(uiStore.session.elapsed)
                : t('hud.session.label.record')
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
            onPlay={() => this.handlePlayClick()}
            onSkipBack={() => this.handleSkip(-SKIP_SECONDS)}
            onSkipFwd={() => this.handleSkip(SKIP_SECONDS)}
            onVolume={(v) => {
              this.setVolume(v)
              store.setState('volume', v)
              trackEventSettled('volume_changed', { volume: Math.round(v * 100) / 100 })
            }}
            onSpeed={(v) => {
              this.setSpeed(v)
              store.setState('speed', v)
              trackEventSettled('speed_changed', { speed: v })
            }}
            onZoom={(v) => {
              this.setZoom(v)
              opts.onZoom?.(v)
              trackEventSettled('zoom_changed', { zoom: Math.round(v) })
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
              const from = opts.services.clock.currentTime
              this.invalidateTimeCache()
              opts.services.clock.seek(t)
              opts.onSeek?.(t)
              trackEvent('seeked', {
                from_s: Math.round(from),
                to_s: Math.round(t),
                method: 'scrub',
              })
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
            wakeRef={(fn) => {
              this.hudWake = fn
            }}
            togglePinRef={(fn) => {
              this.hudTogglePin = fn
            }}
            onIdleChange={(idle) => {
              this.setHudIdle(idle)
              this.setDimTopStrip(idle)
            }}
            onHasDragged={() => {
              if (!this.hudHasDraggedSig()) {
                this.setHudHasDragged(true)
                saveHudHasDragged()
              }
            }}
            closed={hudClosed}
            onClose={() => {
              this.setHudClosed(true)
              this.hudWake?.()
            }}
            onReopen={() => this.setHudClosed(false)}
          />
          {/* Mounted *after* HudView so the `#hud-drag` anchor exists when
              the coachmark's onMount looks it up. */}
          <DragCoachmark
            eligible={() =>
              // Stagger behind the Learn coachmark so two bubbles don't fight
              // for attention. Only show when the HUD is actually visible
              // (drag handle lives on it) and the user hasn't already dragged.
              learnCoachmarkSeen() &&
              !hudHasDragged() &&
              hasFile() &&
              status() !== 'loading' &&
              status() !== 'exporting' &&
              (mode() === 'play' || mode() === 'live') &&
              !hudClosed() &&
              !hudIdle()
            }
            hasDragged={hudHasDragged}
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
      watch(
        () => store.effectiveVisualizationMode,
        (m) => setVisualizationMode(m),
      ),
      watch(
        () => store.state.visualizationForced,
        (forced) => setVisualizationDisabled(forced !== null),
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

  // Push the currently-loaded Learn-mode song name into the topbar context.
  // Called by LearnController when its MIDI store changes — Learn keeps its
  // own state to avoid disturbing Play, so this can't ride the existing
  // `store.state.loadedMidi` watch.
  updateLearnFileName(name: string | null): void {
    if (this.learnFileName === name) return
    this.learnFileName = name
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
    this.disposeRoot?.()
    this.disposeRoot = null
    this.compactRO?.disconnect()
    this.compactRO = null
    this.compactMO?.disconnect()
    this.compactMO = null
    if (this.compactRaf) cancelAnimationFrame(this.compactRaf)
    this.compactRaf = 0
  }

  // ── Private helpers ─────────────────────────────────────────────────

  // Collapse the secondary right-cluster labels to icons only when keeping them
  // would clip the Now-Playing title. Measuring always from the expanded
  // (labels-shown) baseline makes the decision a pure function of strip width +
  // title length, so there's no collapse↔expand oscillation and no hysteresis
  // needed. The strip's own width is fixed by layout, so toggling .ts-compact
  // never re-triggers the ResizeObserver (no feedback loop).
  private setupCompactObserver(strip: HTMLElement): void {
    this.compactRO = new ResizeObserver(() => this.scheduleCompactEval())
    this.compactRO.observe(strip)
    const title = strip.querySelector<HTMLElement>('.ts-status-title')
    if (title) {
      this.titleEl = title
      this.compactMO = new MutationObserver(() => this.scheduleCompactEval())
      this.compactMO.observe(title, { characterData: true, childList: true, subtree: true })
    }
    this.scheduleCompactEval()
  }

  private scheduleCompactEval = (): void => {
    if (this.compactRaf) return // coalesce bursts of resize/mutation into one eval
    this.compactRaf = requestAnimationFrame(() => {
      this.compactRaf = 0
      this.evaluateCompact()
    })
  }

  private evaluateCompact(): void {
    const strip = this.topStripEl
    const title = this.titleEl ?? strip?.querySelector<HTMLElement>('.ts-status-title') ?? null
    if (!strip || !title) return
    this.titleEl = title
    // Reading scrollWidth/clientWidth after dropping .ts-compact forces a
    // synchronous reflow, but the browser only paints after this callback
    // returns — so re-adding the class (when not clipping) is flicker-free.
    strip.classList.remove('ts-compact')
    const clips = title.scrollWidth - title.clientWidth > 1
    strip.classList.toggle('ts-compact', clips)
  }

  private handlePlayClick(): void {
    const { store, clock } = this.opts.services
    if (store.state.mode !== 'play') return
    const s = store.state.status
    if (s === 'playing') {
      clock.pause()
      store.setState('status', 'paused')
      const dur = store.state.duration
      trackEvent('playback_paused', {
        position_s: Math.round(clock.currentTime),
        position_pct: dur > 0 ? Math.round((clock.currentTime / dur) * 100) : 0,
      })
    } else if (s === 'paused' || s === 'ready') {
      clock.play()
      store.setState('status', 'playing')
    }
  }

  private handleSkip(delta: number): void {
    const { store, clock } = this.opts.services
    if (store.state.mode !== 'play') return
    const from = clock.currentTime
    const next =
      delta < 0
        ? Math.max(0, clock.currentTime + delta)
        : Math.min(store.state.duration, clock.currentTime + delta)
    this.invalidateTimeCache()
    clock.seek(next)
    this.opts.onSeek?.(next)
    trackEvent('seeked', { from_s: Math.round(from), to_s: Math.round(next), method: 'skip' })
  }

  private handleKey(e: KeyboardEvent): void {
    const target = e.target as HTMLElement
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return
    const mode = this.opts.services.store.state.mode

    if (e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && e.code === 'KeyP') {
      e.preventDefault()
      this.hudTogglePin?.()
      return
    }

    // Bare H toggles the control bar, but only in the modes where it exists.
    if (
      e.code === 'KeyH' &&
      !e.shiftKey &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey &&
      (mode === 'play' || mode === 'live')
    ) {
      e.preventDefault()
      this.setHudClosed(!this.hudClosedSig())
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
      } else if (e.code === 'KeyR' && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
        // Bare R only — leaves Cmd+R / Shift+Cmd+R for the browser's reload
        // shortcuts and avoids hijacking the user's muscle memory.
        if (this.opts.services.store.state.status !== 'exporting') {
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

      // Shift-only (no Cmd/Ctrl/Alt) so we don't hijack browser shortcuts like
      // Shift+Cmd+R (hard reload).
      if (e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
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

  private bumpBpm(delta: number): void {
    const current = this.uiStore.metro.bpm
    this.opts.onMetronomeBpmChange?.(current + delta)
  }

  private refreshUi(): void {
    const { store } = this.opts.services
    const mode = store.state.mode

    this.renderContext(mode, store.state.loadedMidi?.name ?? null)
  }

  private renderContext(mode: AppMode, fileName: string | null): void {
    const midi = this.uiStore.midi

    if (mode === 'play' && this.opts.services.store.state.status === 'loading') {
      this.setUi('context', {
        kicker: t('topStrip.context.loading.kicker'),
        title: t('topStrip.context.loading.title'),
      })
      return
    }

    if (mode === 'live') {
      this.setUi('context', {
        kicker: t('topStrip.context.live.kicker'),
        title:
          midi.status === 'connected'
            ? midi.deviceName || t('topStrip.context.live.midiSession')
            : t('topStrip.context.live.keyboard'),
      })
      return
    }

    if (mode === 'play') {
      this.setUi('context', {
        kicker: t('topStrip.context.play.kicker'),
        title: fileName ?? t('topStrip.context.play.fallback'),
      })
      return
    }

    if (mode === 'learn') {
      // Show the loaded song name when an exercise is using one, otherwise
      // fall back to the generic Learn label.
      if (this.learnFileName) {
        this.setUi('context', {
          kicker: t('topStrip.context.learning.kicker'),
          title: this.learnFileName,
        })
      } else {
        this.setUi('context', {
          kicker: t('topStrip.context.learn.kicker'),
          title: t('topStrip.context.learn.title'),
        })
      }
      return
    }

    this.setUi('context', {
      kicker: t('topStrip.context.ready.kicker'),
      title: t('topStrip.context.ready.title'),
    })
  }

  private wakeUp(): void {
    this.setDimTopStrip(false)
    this.hudWake?.()
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
