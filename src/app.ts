import { Metronome } from './audio/Metronome'
import { INSTRUMENTS, SynthEngine } from './audio/SynthEngine'
import { MasterClock } from './core/clock/MasterClock'
import { type BusNoteEvent, InputBus } from './core/input/InputBus'
import { lazyHandle } from './core/lazyHandle'
import { parseMidiFile } from './core/midi/parser'
import { detectChord } from './core/music/ChordDetector'
import {
  createLivePerformanceBus,
  type LivePerformanceBus,
} from './core/performance/LivePerformanceBus'
import { booleanPersisted, indexPersisted, numberPersisted } from './core/persistence'
import { fetchSampleMidi, getSample } from './core/samples'
import type { AppServices } from './core/services'
import {
  fitPitchRange,
  pitchSignature,
  resolveExportBitrate,
  resolveExportDims,
  speedToPps,
  trimAudioBuffer,
} from './export/exportMath'
// VideoExporter pulls Mediabunny; OfflineAudioRenderer pulls Tone + instruments.
// Both are dynamic-imported from startExport(). Import order matters: load the
// offline-audio module first when audio is needed — do not block Tone on the
// heavy VideoExporter chunk (see Promise.all removal below).
import type { VideoExporter } from './export/VideoExporter'
import { audioBufferToWav } from './export/wav'
import { GuitarSurface } from './guitar/GuitarSurface'
import type { VisualizationMode } from './guitar/types'
import { setLocale, t } from './i18n'
import { CaptureFanout } from './midi/CaptureFanout'
import { ComputerKeyboardInput } from './midi/ComputerKeyboardInput'
import { LiveLooper, type LiveLooperState } from './midi/LiveLooper'
import { LiveNoteStore } from './midi/LiveNoteStore'
import type { CapturedEvent } from './midi/MidiEncoding'
import { encodeCapturedEvents, midiFileToBytes, triggerMidiDownload } from './midi/MidiEncoding'
import { MidiInputManager } from './midi/MidiInputManager'
import { SessionRecorder } from './midi/SessionRecorder'
import { sessionToMidiFile } from './midi/SessionToMidi'
import type { LearnController } from './modes/LearnController'
import { setNextLiveOpts } from './modes/LiveMode'
import { MODE_CAPTURES_LIVE, type ModeContext } from './modes/ModeController'
import { PARTICLE_STYLES } from './renderer/ParticleSystem'
import { PianoRollRenderer } from './renderer/PianoRollRenderer'
import { SurfaceRouter } from './renderer/SurfaceRouter'
import { THEMES, type Theme } from './renderer/theme'
import type { AppMode, AppStore } from './store/state'
import { watch } from './store/watch'
import {
  categorizeMidiDevice,
  midiLoadErrorType,
  track,
  trackActivation,
  trackEvent,
  trackEventSettled,
  trackMidiLoaded,
  trackMidiLoadFailed,
} from './telemetry'
import { ChordOverlay } from './ui/ChordOverlay'
import { Controls } from './ui/Controls'
import { CustomizeMenu } from './ui/CustomizeMenu'
import { DropZone } from './ui/DropZone'
// Modal classes that the user only reaches on demand (Record button, file
// picker, post-session card) are dynamic-imported in ensureXModal() helpers
// below so their JSX stays out of the initial bundle. The static side keeps
// the type imports for signatures.
import type { ExportSettings } from './ui/ExportModal'
import { InstrumentMenu } from './ui/InstrumentMenu'
import { KeyboardResizer } from './ui/KeyboardResizer'
import type { SessionAction } from './ui/PostSessionModal'
import { showError, showSuccess } from './ui/Toast'
import { TrackPanel } from './ui/TrackPanel'
import { installViewportClassSync } from './ui/utils'
import { whenIdle } from './whenIdle'

// Total note count across all tracks — the content-size signal attached to
// midi_loaded so we can tie which pieces drive retention. Structurally typed
// to avoid coupling this helper to the MidiFile import.
function countNotes(midi: { tracks: ReadonlyArray<{ notes: ReadonlyArray<unknown> }> }): number {
  return midi.tracks.reduce((n, t) => n + t.notes.length, 0)
}

export class App {
  private clock = new MasterClock()
  // Piano is a concrete surface on its own canvas (see index.html),
  // initialized eagerly at boot. Guitar is constructed lazily — the first
  // time `SurfaceRouter` actually needs it — via `createGuitarSurface()` so a
  // piano-only session never pays for a second Pixi/WebGL context. `surfaces`
  // (the `SurfaceRouter`) is what `AppServices.renderer` actually resolves to
  // — piano-specific chrome (particles, keyboard resize, track visibility,
  // mouse-to-pitch, export pitch-fit/zoom) stays pinned to `pianoRenderer`
  // directly since it has no guitar equivalent.
  private pianoRenderer = new PianoRollRenderer()
  private guitarCanvas!: HTMLCanvasElement
  private surfaces = new SurfaceRouter(
    this.pianoRenderer,
    () => this.createGuitarSurface(),
    (from, to) => {
      if (from === 'piano' && to === 'guitar') this.releaseActivePianoPointerNote()
    },
  )
  private synth = new SynthEngine()
  private inputBus = new InputBus()
  midiInput!: MidiInputManager
  keyboardInput!: ComputerKeyboardInput
  private liveNotes = new LiveNoteStore()
  private loopNotes = new LiveNoteStore()
  private liveLooper!: LiveLooper
  private metronome = new Metronome()
  private sessionRec!: SessionRecorder
  private capture!: CaptureFanout
  // Lazy modals: race-safe lazy initialisation via lazyHandle — each is
  // constructed at most once, even under concurrent get() calls.
  private postSessionHandle = lazyHandle(() =>
    import('./ui/PostSessionModal').then(({ PostSessionModal }) => {
      const m = new PostSessionModal(this.overlay)
      m.onAction = (action) => void this.handleSessionAction(action)
      return m
    }),
  )
  private pendingSession: { events: CapturedEvent[]; duration: number } | null = null
  private instrumentMenu!: InstrumentMenu
  private activeMouseNote: number | null = null
  dropzone!: DropZone
  private midiPickerHandle = lazyHandle(() =>
    import('./ui/MidiPickerModal').then(({ MidiPickerModal }) => {
      const m = new MidiPickerModal(this.overlay)
      return m
    }),
  )
  private controls!: Controls
  trackPanel!: TrackPanel
  private exportHandle = lazyHandle(() =>
    import('./ui/ExportModal').then(({ ExportModal }) => {
      const m = new ExportModal(this.overlay)
      m.onStart = (settings) => void this.startExport(settings)
      m.onCancel = () => this.cancelExport()
      return m
    }),
  )
  // Captured in init() so the lazy ensureXModal() helpers can construct
  // without re-querying the DOM.
  private overlay!: HTMLElement
  private kbdResizer!: KeyboardResizer
  private chordOverlay!: ChordOverlay
  private customizeMenu!: CustomizeMenu
  // Shared handles passed into subsystems (Controls today, mode controllers and
  // exercises in follow-up tasks). Assembled once in init() from this.clock,
  // this.synth, etc. so the constructor list stays authoritative.
  // Public so `createApp()` can thread `services`/`store` into AppCtx.
  services!: AppServices
  readonly store: AppStore

  constructor(store: AppStore) {
    this.store = store
  }
  // Learn owns enough lifecycle state (hub, runner, overlay layer) that a
  // long-lived instance is cheapest. But constructing it pulls the entire
  // Learn module graph (LearnHub, ExerciseRunner, IntervalsEngine, …) into
  // the bundle, so we defer construction to first use. The mode context is
  // captured at boot so the lazy constructor doesn't need to re-derive it.
  private learnControllerHandle = lazyHandle(() =>
    import('./modes/LearnController').then(({ LearnController }) => {
      const c = new LearnController(this.modeContext)
      return c
    }),
  )
  private modeContext!: ModeContext
  private loadingEl: HTMLElement | null = null
  private currentExporter: VideoExporter | null = null
  // Throttle chord recomputation: only run when at least this many ms have
  // passed since the last call, OR the active-pitch set materially changed.
  private chordLastRunMs = 0
  private chordLastSig = ''
  private chordOverlayOn = false

  private themeIndex = themeIndexStore.load()
  private instrumentIndex = instrumentIndexStore.load()
  private particleIndex = particleIndexStore.load()
  private audioPrimed = false
  // Analytics one-shot flags. Reset when a new file is loaded so a user
  // who opens MIDI A then MIDI B gets `first_play` events for both.
  private firstPlayLogged = false
  private firstLiveNoteLogged = false
  private firstPedalLogged = false
  private playbackMilestones = new Set<number>()
  // Loop station one-shots, scoped to the page session. We want to know
  // whether users ever reach each step in the loop funnel, not count every
  // state flip — the state machine toggles rapidly during overdub.
  private loopArmedLogged = false
  private loopRecordedLogged = false
  private prevLooperState: LiveLooperState = 'idle'
  // Sustain pedal state managed by LivePerformanceBus — keyboard OR MIDI
  // sources merged with an OR. The bus owns sustained-pitches bookkeeping,
  // repress-release logic, and subscriber fan-out.
  private performanceBus!: LivePerformanceBus
  private onVisibilityChange = (): void => {
    if (document.hidden) this.releaseAllLiveNotes()
  }
  private onWindowBlur = (): void => this.releaseAllLiveNotes()
  private onFirstPointerDown = (): void => this.primeInteractiveAudio()
  private onFirstKeyDown = (): void => this.primeInteractiveAudio()
  // Unsubscribe closures from every Signal.subscribe() in init(). Invoked from
  // dispose() so each Signal's listener set is cleared — otherwise the
  // captured `this` leaks for the lifetime of the surrounding signals.
  private unsubs: Array<() => void> = []

  async init(): Promise<void> {
    const canvas = document.querySelector<HTMLCanvasElement>('#pianoroll')!
    const guitarCanvas = document.querySelector<HTMLCanvasElement>('#guitar-surface')!
    const overlay = document.querySelector<HTMLElement>('#ui-overlay')!
    this.overlay = overlay

    // Flip `body.is-touch` / `body.is-narrow` so CSS can adapt (bottom-sheet
    // popovers, touch-friendly hit targets, etc.).
    installViewportClassSync()

    await this.pianoRenderer.init(canvas)
    // Guitar's canvas element exists in the DOM from boot, but the
    // GuitarSurface/Pixi context behind it is constructed lazily — see
    // `createGuitarSurface()`.
    this.guitarCanvas = guitarCanvas
    this.surfaces.attachClock(this.clock)
    this.surfaces.setLiveNoteStore(this.liveNotes)
    this.surfaces.setLoopNoteStore(this.loopNotes)

    this.midiInput = new MidiInputManager(this.clock)
    this.keyboardInput = new ComputerKeyboardInput(this.clock)

    this.liveLooper = new LiveLooper(
      this.clock,
      {
        onPlaybackNoteOn: (pitch, velocity, ctxTime) => {
          // Audio is sample-accurately scheduled via the AudioContext clock.
          this.synth.scheduleNoteOn(pitch, velocity, ctxTime)
          // Visuals and session capture fire at ~wall time by deferring the
          // work until ctxTime arrives. setTimeout jitter (~1–4 ms) is
          // imperceptible vs. audio, whereas drawing now (up to 150 ms early)
          // would visibly desync the falling notes.
          this.deferToCtxTime(ctxTime, () => {
            this.loopNotes.press(pitch, velocity, this.clock.currentTime)
            this.sessionRec.captureNoteOn(pitch, velocity, this.clock.currentTime)
          })
        },
        onPlaybackNoteOff: (pitch, ctxTime) => {
          this.synth.scheduleNoteOff(pitch, ctxTime)
          this.deferToCtxTime(ctxTime, () => {
            this.loopNotes.release(pitch, this.clock.currentTime)
            this.sessionRec.captureNoteOff(pitch, this.clock.currentTime)
          })
        },
      },
      // Bar-snap when the metronome is running — rounds loop length to the
      // nearest whole bar at current BPM (4/4). Off → freeform length.
      (raw) => {
        if (!this.metronome.running.value) return raw
        const secPerBar = (60 / this.metronome.bpm.value) * 4
        const bars = Math.max(1, Math.round(raw / secPerBar))
        return bars * secPerBar
      },
    )

    this.sessionRec = new SessionRecorder(this.clock)

    // Fan-out that routes capture events to both looper and sessionRec in
    // a single call. Eliminates the duplicated call pairs below.
    this.capture = new CaptureFanout(this.liveLooper, this.sessionRec)

    // LivePerformanceBus owns pedal merge (keyboard OR MIDI), sustained-pitch
    // bookkeeping, and subscriber fan-out for live performance events.
    this.performanceBus = createLivePerformanceBus()

    this.services = {
      store: this.store,
      clock: this.clock,
      synth: this.synth,
      metronome: this.metronome,
      renderer: this.surfaces,
      input: this.inputBus,
    }

    // Wire the LivePerformanceBus fan-out sinks. Audio and visual-key
    // feedback fire unconditionally (every mode). Capture-mode sinks
    // (looper + session + particles) gate on MODE_CAPTURES_LIVE.
    this.unsubs.push(
      this.performanceBus.subscribeNotes(
        // Audio + visual: always fire so every key-press is heard and seen.
        // Identity (sourceId/channel/voiceId) rides along so a surface
        // rendering held live notes (e.g. the guitar fretboard) can tell
        // apart overlapping voices instead of collapsing them by pitch.
        (evt) => {
          this.synth.liveNoteOn(evt.pitch, evt.velocity, evt.voiceId)
          this.liveNotes.press(evt.pitch, evt.velocity, evt.clockTime, {
            ...(evt.sourceId !== undefined ? { sourceId: evt.sourceId } : {}),
            ...(evt.channel !== undefined ? { channel: evt.channel } : {}),
            ...(evt.voiceId !== undefined ? { voiceId: evt.voiceId } : {}),
            ...(evt.string !== undefined ? { string: evt.string } : {}),
            ...(evt.fret !== undefined ? { fret: evt.fret } : {}),
          })
        },
        (evt) => {
          this.synth.liveNoteOff(evt.pitch, evt.voiceId)
        },
      ),
      // Capture-mode note-off subscriber: looper + session recorder capture
      // every note-off (including pedal-sustained releases). Mode-gated so
      // Learn-mode practice doesn't pollute recordings.
      this.performanceBus.subscribeNotes(
        () => {},
        (evt) => {
          if (!MODE_CAPTURES_LIVE[this.store.state.mode]) return
          // Synthetic pedal-up uses clockTime -1; SessionRecorder needs wall times.
          const t = evt.clockTime >= 0 ? evt.clockTime : this.clock.currentTime
          this.capture.captureNoteOff(evt.pitch, t)
        },
      ),
    )

    // Dropzone is shared across modes; its callbacks dispatch by the active
    // mode so Learn keeps its MIDI isolated from Play's.
    this.dropzone = new DropZone(
      overlay,
      (file, source) => {
        if (this.store.state.mode === 'learn') {
          void this.ensureLearnController().then((c) => c.loadMidiFromFile(file, source))
        } else {
          void this.loadMidi(file, source)
        }
      },
      () => this.enterLiveMode(),
      (sampleId) => {
        if (this.store.state.mode === 'learn') {
          void this.ensureLearnController().then((c) => c.loadSample(sampleId))
        } else {
          void this.loadSample(sampleId)
        }
      },
      () => this.store.setState('mode', 'learn'),
    )

    this.controls = new Controls({
      container: overlay,
      services: this.services,
      onSeek: (t) => {
        this.synth.seek(t)
        this.liveNotes.reset()
      },
      onZoom: (pps) => this.pianoRenderer.setZoom(pps),
      onThemeCycle: () => this.cycleTheme(),
      onMidiConnect: () => void this.connectMidi(),
      onOpenTracks: () => this.trackPanel.toggle(),
      onRecord: () => {
        // First-time vs repeat opens are derivable in PostHog funnels via
        // "first occurrence per user" — no need for a duplicate event.
        track('export_opened', { has_midi: this.store.state.loadedMidi !== null })
        void this.openExportModal()
      },
      onOpenFile: () => this.openFilePicker(),
      onModeRequest: (mode) => this.requestMode(mode),
      onLearnThis: () => this.enterLearnWithCurrentMidi(),
      onHome: () => this.enterHomeMode(),
      onInstrumentCycle: () => this.cycleInstrument(),
      onParticleCycle: () => this.cycleParticleStyle(),
      onLoopToggle: () => this.liveLooper.toggle(),
      onLoopClear: () => {
        const layers = this.liveLooper.layerCount.value
        this.liveLooper.clear()
        if (layers > 0) track('loop_cleared', { layers })
      },
      onLoopSave: () => void this.saveLoopAsMidi(),
      onLoopUndo: () => {
        const before = this.liveLooper.layerCount.value
        this.liveLooper.undo()
        if (before > 0) track('loop_undone', { layers_before: before })
      },
      onMetronomeToggle: () => {
        this.metronome.toggle()
        trackEvent('metronome_toggled', { on: this.metronome.running.value })
      },
      onMetronomeBpmChange: (bpm) => {
        this.metronome.setBpm(bpm)
        metronomeBpmStore.save(this.metronome.bpm.value)
        trackEventSettled('tempo_changed', { bpm: this.metronome.bpm.value })
      },
      onSessionToggle: () => this.toggleSessionRecord(),
      onChordToggle: () => this.toggleChordOverlay(),
      onOctaveShift: (delta) => {
        if (delta < 0) this.keyboardInput.shiftOctaveDown()
        else this.keyboardInput.shiftOctaveUp()
      },
      onVisualizationChange: (mode) => this.setVisualizationMode(mode),
    })

    const pushLoop = (): void =>
      this.controls.updateLoopState(this.liveLooper.state.value, this.liveLooper.layerCount.value)
    this.unsubs.push(
      this.liveLooper.state.subscribe((s) => {
        this.trackLoopTransition(s)
        pushLoop()
      }),
      this.liveLooper.layerCount.subscribe(pushLoop),
    )
    pushLoop()

    this.metronome.setBpm(metronomeBpmStore.load())
    const pushMetronome = (): void =>
      this.controls.updateMetronome(this.metronome.running.value, this.metronome.bpm.value)
    this.unsubs.push(
      this.metronome.running.subscribe(pushMetronome),
      this.metronome.bpm.subscribe(pushMetronome),
      this.metronome.beatCount.subscribe((count) => {
        if (count === 0) return
        const isDownbeat = (count - 1) % 4 === 0
        this.controls.pulseMetronomeBeat(isDownbeat)
      }),
    )
    pushMetronome()

    const pushSession = (): void =>
      this.controls.updateSessionRecording(
        this.sessionRec.recording.value,
        this.sessionRec.elapsed.value,
      )
    this.unsubs.push(
      this.sessionRec.recording.subscribe(pushSession),
      this.sessionRec.elapsed.subscribe(pushSession),
      this.liveLooper.progress.subscribe((p) => this.controls.updateLoopProgress(p)),
    )
    pushSession()

    this.trackPanel = new TrackPanel(
      overlay,
      this.pianoRenderer.currentTheme,
      (id, visible) => this.surfaces.setTrackVisible(id, visible),
      (id, enabled) => {
        this.synth.setTrackEnabled(id, enabled)
        trackEvent('track_toggled', { enabled })
      },
      () => this.openFilePicker(),
    )
    this.trackPanel.setTrigger(this.controls.tracksButton)

    this.instrumentMenu = new InstrumentMenu(this.controls.instrumentSlot, overlay)
    this.instrumentMenu.onSelect = (id) => this.setInstrumentById(id)
    this.unsubs.push(
      this.synth.loadingInstrument.subscribe((id) => {
        this.instrumentMenu.setLoading(id)
        this.controls.setInstrumentLoading(id !== null)
      }),
    )
    this.instrumentMenu.setLoading(this.synth.loadingInstrument.value)
    this.controls.setInstrumentLoading(this.synth.loadingInstrument.value !== null)

    // ExportModal / PostSessionModal / MidiPickerModal are constructed lazily
    // (see ensureXModal helpers further down) — none of them are visible at
    // boot, and keeping them out of the initial chunk shaves ~835 LOC of JSX
    // off the first-paint bundle.

    this.kbdResizer = new KeyboardResizer(
      overlay,
      () => this.pianoRenderer.currentKeyboardHeight,
      (px) => this.pianoRenderer.setKeyboardHeight(px),
    )
    this.kbdResizer.restoreSaved()

    this.chordOverlay = new ChordOverlay(this.controls.chordSlot)
    this.chordOverlayOn = chordOverlayStore.load()
    this.applyChordOverlayVisibility()
    // File mode actively plays a MIDI — the chord chip would just narrate
    // what the user is already hearing without contributing to "play along"
    // affordances. Keep it scoped to live/home where it confirms what the
    // player is sounding.
    this.unsubs.push(
      watch(
        () => this.store.state.mode,
        () => this.applyChordOverlayVisibility(),
      ),
    )

    // Customization popover bundles theme / particles / chord toggle —
    // collapses three topbar pills into a single trigger.
    this.customizeMenu = new CustomizeMenu(
      this.controls.customizeSlot,
      overlay,
      THEMES,
      PARTICLE_STYLES,
      {
        onSelectTheme: (idx) => this.setThemeByIndex(idx),
        onSelectParticle: (idx) => this.setParticleByIndex(idx),
        onToggleChord: () => this.toggleChordOverlay(),
        // Locale change is rare, and almost every part of the UI was built
        // with the previous locale baked in via template literals. Reload
        // is the simplest correct path: persistence happens in setLocale,
        // boot picks it up, the next paint is fully translated. No stale
        // strings, no in-place re-render machinery to maintain.
        onSelectLocale: (code) => {
          void setLocale(code).then(() => window.location.reload())
        },
      },
    )
    this.customizeMenu.setChord(this.chordOverlayOn)

    this.applyTheme(THEMES[this.themeIndex]!)
    this.applyInstrument()
    this.applyParticleStyle()

    // Idle-time warmups. None of these affect first paint — they trade
    // background bandwidth for "feels instant" on first-click flows. All
    // share the default deadline; on a typical browser they fire in the
    // same idle frame ~150-300 ms after boot, kicking off network fetches
    // in parallel.
    //   • synth piano samples → first-note latency
    //   • @tonejs/midi → sample-card click + record-export
    //   • modal chunks → first export / file-picker / post-session click
    //   • LearnController (only when Learn is enabled) → first Learn entry
    whenIdle(() => this.synth.preloadDefault())
    whenIdle(() => void import('@tonejs/midi'))
    whenIdle(() => {
      void import('./ui/ExportModal')
      void import('./ui/PostSessionModal')
      void import('./ui/MidiPickerModal')
    })
    whenIdle(() => void this.ensureLearnController())

    this.controls.updateMidiStatus(this.midiInput.status.value, '')
    this.dropzone.updateMidiStatus(this.midiInput.status.value, '')

    this.unsubs.push(
      this.clock.subscribe((t) => {
        // Export drives this same clock via seek() at frame cadence — those
        // emissions are the encoder sweeping the timeline, not the user
        // watching. Without this gate a load→export flow logs the 30/60/120s
        // milestones (and the playback_30s activation) for a piece nobody
        // played back.
        if (this.store.state.status === 'exporting') return
        // Engagement milestones are mode-agnostic (watched ≥30s counts as
        // a real user regardless of where the clock was ticking).
        for (const m of [30, 60, 120]) {
          if (t >= m && !this.playbackMilestones.has(m)) {
            this.playbackMilestones.add(m)
            track('playback_milestone', { seconds: m, mode: this.store.state.mode })
            if (m === 30) trackActivation('playback_30s')
          }
        }
        this.maybeUpdateChordOverlay(t)
      }),
    )
    this.unsubs.push(
      watch(
        () => this.store.state.status,
        (status) => {
          // Drives the synth for Play/Live only. Learn runs its own status
          // signal on `LearnState` and drives the synth from `LearnController`
          // so the two modes never race for control of the scheduler.
          const mode = this.store.state.mode
          if (mode === 'play' && status === 'playing') {
            void this.synth.play(this.clock.currentTime)
            if (!this.firstPlayLogged) {
              this.firstPlayLogged = true
              const midi = this.store.state.loadedMidi
              track('first_play', {
                mode,
                duration_s: midi ? Math.round(midi.duration) : null,
              })
            }
          } else if (status === 'paused') {
            this.synth.pause()
            if (mode === 'live') {
              this.liveNotes.releaseAll(this.clock.currentTime)
              this.synth.liveReleaseAll()
            }
          }
        },
      ),
      watch(
        () => this.store.state.volume,
        (v) => this.synth.setVolume(v),
      ),
      watch(
        () => this.store.state.speed,
        (s) => {
          this.clock.speed = s
          this.synth.setSpeed(s)
        },
      ),
    )

    // ── Live input wiring (MIDI device + computer keyboard) ───────────────
    // Each source re-publishes into the shared InputBus so downstream
    // consumers (the live-note handler here, and later exercise runners)
    // see one fan-out point instead of three. Pedal sources are kept
    // per-source because the bus merges them with an OR.
    this.unsubs.push(
      this.midiInput.noteOn.subscribe((evt) => {
        if (evt) this.inputBus.emitNoteOn(evt, 'midi')
      }),
      this.midiInput.noteOff.subscribe((evt) => {
        if (evt) this.inputBus.emitNoteOff(evt, 'midi')
      }),
      this.midiInput.pedal.subscribe((down) => {
        this.inputBus.emitPedal(down, 'midi')
        if (down) {
          this.performanceBus.routePedalDown('midi')
          if (!this.firstPedalLogged) {
            this.firstPedalLogged = true
            track('pedal_used', { source: 'midi' })
          }
        } else {
          this.performanceBus.routePedalUp('midi')
        }
      }),
      this.keyboardInput.noteOn.subscribe((evt) => {
        if (evt) this.inputBus.emitNoteOn(evt, 'keyboard')
      }),
      this.keyboardInput.noteOff.subscribe((evt) => {
        if (evt) this.inputBus.emitNoteOff(evt, 'keyboard')
      }),
      this.keyboardInput.pedal.subscribe((down) => {
        this.inputBus.emitPedal(down, 'keyboard')
        if (down) {
          this.performanceBus.routePedalDown('keyboard')
          if (!this.firstPedalLogged) {
            this.firstPedalLogged = true
            track('pedal_used', { source: 'keyboard' })
          }
        } else {
          this.performanceBus.routePedalUp('keyboard')
        }
      }),
      this.keyboardInput.octave.subscribe((o) => this.controls.updateOctave(o)),
      this.inputBus.noteOn.subscribe((evt) => {
        if (evt) this.handleLiveNoteOn(evt)
      }),
      this.inputBus.noteOff.subscribe((evt) => {
        if (evt) this.handleLiveNoteOff(evt)
      }),
      // Fretboard taps/clicks on the guitar surface — only fires while its
      // canvas is visible and receiving pointer/keyboard events (see
      // `FretboardInteraction`). Subscribed once on the router's stable
      // `surfaceHits` signal (not the concrete, lazily-constructed
      // GuitarSurface) so this keeps working across guitar being torn down
      // and rebuilt and across mode switches. Re-publishes onto the same
      // InputBus as MIDI and computer-keyboard input so audio, live state,
      // capture, and reset all see one fan-out point regardless of source.
      this.surfaces.surfaceHits.subscribe((hit) => {
        if (!hit) return
        const evt = {
          pitch: hit.pitch,
          velocity: hit.velocity,
          clockTime: this.clock.currentTime,
          sourceId: hit.sourceId,
          voiceId: hit.voiceId,
          ...(hit.channel !== undefined ? { channel: hit.channel } : {}),
          ...(hit.string !== undefined ? { string: hit.string } : {}),
          ...(hit.fret !== undefined ? { fret: hit.fret } : {}),
        }
        if (hit.type === 'note-on') this.inputBus.emitNoteOn(evt, 'guitar')
        else this.inputBus.emitNoteOff(evt, 'guitar')
      }),
    )

    // Mouse/touch on the on-screen keyboard — down to press, move to slide
    // between keys (glissando), up/cancel/leave to release.
    canvas.addEventListener('pointerdown', this.onCanvasPointerDown)
    canvas.addEventListener('pointermove', this.onCanvasPointerMove)
    canvas.addEventListener('pointerup', this.onCanvasPointerUp)
    canvas.addEventListener('pointercancel', this.onCanvasPointerUp)
    canvas.addEventListener('pointerleave', this.onCanvasPointerUp)

    // Update MIDI button whenever either status or device name changes.
    // Reading the *other* signal's current value avoids a stale-name flash.
    this.unsubs.push(
      this.midiInput.status.subscribe((status) => {
        this.controls.updateMidiStatus(status, this.midiInput.deviceName.value)
        this.dropzone.updateMidiStatus(status, this.midiInput.deviceName.value)
        if (status === 'connected') {
          // Vendor enum instead of raw device name — cardinality-friendly and
          // avoids leaking user-customised device labels.
          track('midi_device_connected', {
            vendor: categorizeMidiDevice(this.midiInput.deviceName.value),
          })
        }
      }),
      this.midiInput.deviceName.subscribe((name) => {
        this.controls.updateMidiStatus(this.midiInput.status.value, name)
        this.dropzone.updateMidiStatus(this.midiInput.status.value, name)
      }),
    )

    // Release all held notes when the page loses focus (prevents stuck notes)
    document.addEventListener('visibilitychange', this.onVisibilityChange)
    window.addEventListener('blur', this.onWindowBlur)
    window.addEventListener('pointerdown', this.onFirstPointerDown, { passive: true })
    window.addEventListener('keydown', this.onFirstKeyDown, { capture: true, passive: true })

    this.modeContext = {
      services: this.services,
      overlay,
      trackPanel: this.trackPanel,
      dropzone: this.dropzone,
      keyboardInput: this.keyboardInput,
      midiInput: this.midiInput,
      resetInteractionState: () => this.resetInteractionState(),
      openFilePicker: () => this.openFilePicker(),
      primeInteractiveAudio: () => this.primeInteractiveAudio(),
      setLearnFileName: (name) => this.controls.updateLearnFileName(name),
    }

    // Visualization surface: apply whatever's effective at boot (saved
    // preference — Learn can't be forcing anything yet), then keep it in
    // sync with every subsequent change (user selection or Learn force).
    this.applyVisualizationMode(this.store.effectiveVisualizationMode)
    this.unsubs.push(
      watch(
        () => this.store.effectiveVisualizationMode,
        (mode) => this.applyVisualizationMode(mode),
      ),
    )

    // Start in home. <HomeMode/>'s onMount handles the side effects.
    this.services.store.enterHome()
    void this.autoConnectMidi()
  }

  // Switches which concrete surface is on screen. Never touches the
  // selected output instrument (synth) — visualization and audio are
  // orthogonal by design (see docs on VisualizationSurface). Fire-and-forget:
  // the watch() call site is synchronous, and SurfaceRouter.setMode already
  // resolves latest-request-wins internally, so a rapid run of calls here is
  // safe to leave un-awaited — each just races to update the same router.
  private applyVisualizationMode(mode: VisualizationMode): void {
    void this.switchVisualizationSurface(mode)
  }

  private async switchVisualizationSurface(mode: VisualizationMode): Promise<void> {
    if (mode === 'guitar' && this.surfaces.currentMode === 'piano') {
      this.releaseActivePianoPointerNote()
    }
    try {
      await this.surfaces.setMode(mode, this.clock.currentTime)
    } catch (err) {
      // Guitar's first-ever init failed (e.g. WebGL unavailable). Never leave
      // this as an unhandled rejection, and never flip `visualization-guitar`
      // body state for a switch that didn't actually happen.
      console.error('Failed to switch visualization surface:', err)
      // Only roll back when the failure came from the user's own saved
      // preference — a Learn-mode force has no preference to roll back, and
      // clobbering it here would fight Learn's own state ownership.
      if (
        this.store.state.visualizationForced === null &&
        this.store.state.visualizationMode === 'guitar'
      ) {
        this.store.setVisualizationMode('piano')
      }
      return
    }
    // Derive from the router's actual resulting mode rather than the `mode`
    // this call requested — a stale call that lost a latest-wins race
    // resolves without throwing (SurfaceRouter no-ops it), and body state
    // must track whichever switch really landed.
    document.body.classList.toggle('visualization-guitar', this.surfaces.currentMode === 'guitar')
  }

  // Lazy factory passed to `SurfaceRouter` — constructs and initializes the
  // guitar Pixi/WebGL context only the first time it's actually needed, so a
  // piano-only session never pays for a second canvas context. `SurfaceRouter`
  // caches the resulting surface (and, on failure, retries from scratch on
  // the next switch attempt — see `ensureGuitar()`), so this runs at most
  // once per successful construction.
  private async createGuitarSurface(): Promise<GuitarSurface> {
    const surface = new GuitarSurface()
    await surface.init(this.guitarCanvas)
    return surface
  }

  // Topbar selector callback — persists the user's choice. Application to
  // the surface happens via the `effectiveVisualizationMode` watch above, so
  // a Learn-mode force (which wins over the raw preference) never gets
  // fought by this call.
  private setVisualizationMode(mode: VisualizationMode): void {
    this.store.setVisualizationMode(mode)
  }

  private releaseAllLiveNotes(): void {
    const now = this.clock.currentTime
    this.liveNotes.releaseAll(now)
    this.synth.liveReleaseAll()
    // Emergency reset: clear all pedal state and release sustained pitches
    // so the bus doesn't think the pedal is still held when the user returns.
    this.performanceBus.forceReleaseAll(now)
  }

  // Called whenever a new MIDI is loaded so the telemetry flags scoped to
  // "this piece" fire for the next one too. `first_play` re-arms, playback
  // milestones reset so 30/60/120s fire again for the new file.
  private resetPlaybackTelemetry(): void {
    this.firstPlayLogged = false
    this.playbackMilestones.clear()
  }

  // Loop funnel: fire once-per-session on `armed` and first `playing`, and
  // fire `loop_layer_added` every time an overdub passes commits as a new
  // layer (overdubbing → playing). Skipping transitions that just return to
  // `idle` keeps the event stream tied to user intent, not UI housekeeping.
  private trackLoopTransition(next: LiveLooperState): void {
    const prev = this.prevLooperState
    this.prevLooperState = next
    if (!this.loopArmedLogged && (next === 'armed' || next === 'recording')) {
      this.loopArmedLogged = true
      track('loop_armed')
    }
    if (!this.loopRecordedLogged && next === 'playing' && prev === 'recording') {
      this.loopRecordedLogged = true
      track('loop_recorded', { layers: this.liveLooper.layerCount.value })
    }
    if (next === 'playing' && prev === 'overdubbing') {
      track('loop_layer_added', { layers: this.liveLooper.layerCount.value })
    }
  }

  private handleLiveNoteOn(evt: BusNoteEvent): void {
    if (this.store.state.status === 'exporting') return
    const mode = this.store.state.mode
    const captures = MODE_CAPTURES_LIVE[mode]
    if (mode === 'home') this.enterLiveMode(false)

    if (!this.firstLiveNoteLogged) {
      this.firstLiveNoteLogged = true
      track('first_live_note', { source: evt.source })
      trackActivation('live_note')
    }

    // Route through the bus: repress-release (note-off sinks, then on),
    // sustained-pitches bookkeeping, and note-on fan-out to audio+visual sinks.
    // Capture uses the bus's note-off path only — no duplicate captureNoteOff
    // here (routeNoteOn already fans off to subscribers).
    this.performanceBus.routeNoteOn(evt)

    // Looper + session captures are live-performance concerns — practice
    // key-presses (Learn) should not pollute a saved session recording.
    if (captures) {
      this.pianoRenderer.burstParticleAt(evt.pitch)
      this.capture.captureNoteOn(evt.pitch, evt.velocity, evt.clockTime)
    }

    // Live mode's "tap a note to start the session" shortcut.
    if (mode === 'live') {
      const s = this.store.state.status
      if (s === 'idle' || s === 'ready' || s === 'paused') {
        this.clock.play()
        this.store.setState('status', 'playing')
      }
    }
  }

  private handleLiveNoteOff(evt: BusNoteEvent): void {
    const mode = this.store.state.mode
    if (mode === 'home') return

    // Visual key-up always fires — the roll reflects hand motion even while
    // audio keeps ringing under the pedal. Release by voiceId when the
    // source provided one (MIDI/keyboard/guitar all do) so overlapping
    // same-pitch voices from different sources/strings don't release each
    // other's held note; fall back to pitch for sources that don't (mouse).
    if (evt.voiceId) this.liveNotes.releaseVoice(evt.voiceId, evt.clockTime)
    else this.liveNotes.release(evt.pitch, evt.clockTime)

    // Route through the bus. When pedal is down the bus bookmarks the pitch;
    // when pedal lifts, bus subscribers fire for audio+visual release and
    // captures. When pedal is not down, subscribers fire immediately.
    this.performanceBus.routeNoteOff(evt)
  }

  private onCanvasPointerDown = (e: PointerEvent): void => {
    if (this.store.state.status === 'exporting') return
    const pitch = this.pianoRenderer.pitchAtClientPoint(e.clientX, e.clientY)
    if (pitch === null) return

    this.primeInteractiveAudio()
    if (this.store.state.mode === 'home') this.enterLiveMode(false)
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    e.preventDefault()

    if (this.activeMouseNote !== null) {
      this.inputBus.emitNoteOff(
        { pitch: this.activeMouseNote, velocity: 0, clockTime: this.clock.currentTime },
        'touch',
      )
    }
    this.activeMouseNote = pitch
    this.inputBus.emitNoteOn({ pitch, velocity: 0.8, clockTime: this.clock.currentTime }, 'touch')
  }

  private onCanvasPointerMove = (e: PointerEvent): void => {
    // Only react while the user is actively pressing — this is the glissando
    // path, not a hover state.
    if (this.activeMouseNote === null) return
    if (this.store.state.status === 'exporting') return
    const pitch = this.pianoRenderer.pitchAtClientPoint(e.clientX, e.clientY)
    if (pitch === null || pitch === this.activeMouseNote) return
    const prev = this.activeMouseNote
    this.activeMouseNote = pitch
    this.inputBus.emitNoteOff(
      { pitch: prev, velocity: 0, clockTime: this.clock.currentTime },
      'touch',
    )
    this.inputBus.emitNoteOn({ pitch, velocity: 0.8, clockTime: this.clock.currentTime }, 'touch')
  }

  private onCanvasPointerUp = (): void => {
    this.releaseActivePianoPointerNote()
  }

  private releaseActivePianoPointerNote(): void {
    if (this.activeMouseNote === null) return
    const pitch = this.activeMouseNote
    this.activeMouseNote = null
    this.inputBus.emitNoteOff({ pitch, velocity: 0, clockTime: this.clock.currentTime }, 'touch')
  }

  private async connectMidi(): Promise<void> {
    this.primeInteractiveAudio()
    // Once a user denies the prompt, browsers remember the choice and
    // `requestMIDIAccess()` resolves silently — clicking the button again
    // does nothing visible. Detect that case and surface a help message
    // so the user knows they need to reset the permission via the browser
    // (lock icon → Site settings → MIDI devices → Allow).
    const wasBlocked = this.midiInput.status.value === 'blocked'
    track('midi_permission_requested', { was_blocked: wasBlocked })
    const ok = await this.midiInput.requestAccess()
    if (ok) {
      track('midi_permission_granted')
      return
    }
    if (this.midiInput.status.value === 'blocked') {
      track('midi_permission_denied', { was_blocked: wasBlocked })
      const msg = wasBlocked ? t('error.midi.permissionBlocked') : t('error.midi.permissionDenied')
      this.showError(msg)
    }
  }

  private async autoConnectMidi(): Promise<void> {
    await this.midiInput.requestAccess({ silent: true })
  }

  // Play-mode MIDI loader. Learn has its own loader on LearnController that
  // never touches AppState — see the mode dispatch at the DropZone callback.
  private async loadMidi(file: File, source: 'drag' | 'picker' = 'picker'): Promise<void> {
    const previousMode = this.store.state.mode
    const previousMidi = this.store.state.loadedMidi
    this.resetInteractionState()
    this.store.beginPlayLoad()
    this.surfaces.clearMidi()
    this.showLoading()

    try {
      const midi = await parseMidiFile(file)
      this.synth.load(midi).catch((err) => {
        console.error('SynthEngine.load failed:', err)
        // Visuals load but there's no sound — a silent session-killer that
        // produced zero telemetry before.
        trackEvent('synth_load_failed', { source })
      })
      // completePlayLoad flips mode to 'play'; <PlayMode/>'s effect then
      // drives renderer.loadMidi, trackPanel.render, document.title, and
      // dropzone.hide off the new loadedMidi.
      this.store.completePlayLoad(midi)
      this.resetPlaybackTelemetry()
      trackMidiLoaded({
        source,
        trackCount: midi.tracks.length,
        noteCount: countNotes(midi),
        durationS: Math.round(midi.duration),
        fileSizeKb: Math.round(file.size / 1024),
      })
    } catch (err) {
      console.error('Failed to load MIDI:', err)
      // Bucket the cause (not free-text — cardinality + PII) so we can see
      // which files break instead of lumping everything as 'parse'.
      trackMidiLoadFailed({
        source,
        errorType: await midiLoadErrorType(err, file),
        fileExt: file.name.split('.').pop()?.toLowerCase() ?? null,
        fileSizeKb: Math.round(file.size / 1024),
      })
      if (previousMode === 'play' && previousMidi) {
        // Manual surface restore — the one place that can't lean on
        // <PlayMode/>'s effect: `loadedMidi` still holds the same
        // `previousMidi` reference (beginPlayLoad doesn't clear it), so the
        // effect never re-fires, yet clearMidi() above already wiped the
        // renderer.
        this.store.enterPlay()
        this.surfaces.loadMidi(previousMidi)
        this.trackPanel.render(previousMidi)
        this.dropzone.hide()
      } else if (previousMode === 'live') {
        this.enterLiveMode(false)
      } else if (previousMode === 'home') this.enterHomeMode()
      else this.store.setState('status', 'ready')
      const msg =
        err instanceof Error && err.name === 'EmptyMidiError'
          ? t('error.midi.empty')
          : t('error.midi.parseFailed')
      this.showError(msg)
    } finally {
      this.hideLoading()
    }
  }

  private cycleTheme(): void {
    this.setThemeByIndex((this.themeIndex + 1) % THEMES.length)
  }

  private setThemeByIndex(idx: number): void {
    if (idx < 0 || idx >= THEMES.length || idx === this.themeIndex) return
    this.themeIndex = idx
    this.applyTheme(THEMES[idx]!)
    themeIndexStore.save(idx)
    trackEvent('theme_changed', { theme: THEMES[idx]!.name })
  }

  private cycleInstrument(): void {
    const from = INSTRUMENTS[this.instrumentIndex]?.id
    this.instrumentIndex = (this.instrumentIndex + 1) % INSTRUMENTS.length
    this.applyInstrument()
    instrumentIndexStore.save(this.instrumentIndex)
    trackEvent('instrument_changed', {
      from,
      to: INSTRUMENTS[this.instrumentIndex]!.id,
      method: 'cycle',
    })
  }

  private setInstrumentById(id: string): void {
    const idx = INSTRUMENTS.findIndex((i) => i.id === id)
    if (idx < 0 || idx === this.instrumentIndex) return
    const from = INSTRUMENTS[this.instrumentIndex]?.id
    this.instrumentIndex = idx
    this.applyInstrument()
    instrumentIndexStore.save(this.instrumentIndex)
    trackEvent('instrument_changed', { from, to: id, method: 'menu' })
  }

  private applyInstrument(): void {
    const info = INSTRUMENTS[this.instrumentIndex]!
    this.controls.updateInstrument(t(info.nameKey))
    this.instrumentMenu?.setCurrent(info.id)
    void this.synth.setInstrument(info.id)
  }

  private cycleParticleStyle(): void {
    this.setParticleByIndex((this.particleIndex + 1) % PARTICLE_STYLES.length)
  }

  private setParticleByIndex(idx: number): void {
    if (idx < 0 || idx >= PARTICLE_STYLES.length || idx === this.particleIndex) return
    this.particleIndex = idx
    this.applyParticleStyle()
    particleIndexStore.save(idx)
    trackEvent('particle_changed', { style: PARTICLE_STYLES[idx]!.id })
  }

  private applyParticleStyle(): void {
    const info = PARTICLE_STYLES[this.particleIndex]!
    this.pianoRenderer.setParticleStyle(info.id)
    this.customizeMenu?.setParticle(this.particleIndex)
  }

  private async startExport(settings: ExportSettings): Promise<void> {
    const midi = this.store.state.loadedMidi
    if (!midi || this.store.state.mode !== 'play') return
    // startExport only fires from ExportModal's onStart callback, so the
    // modal exists. Capture the live ref once so progress/close calls below
    // don't need optional-chaining ceremony.
    const exportModal = this.exportHandle.peek()
    if (!exportModal) return

    const exportStartedAt = performance.now()
    // One settings shape shared across started / completed / failed so the
    // funnel can be sliced by social-format settings without a join. `stage`
    // is advanced as the pipeline progresses and reported on failure.
    const exportBase = {
      output: settings.output,
      resolution: settings.resolution,
      fps: settings.fps,
      focus: settings.focus,
      speed: settings.speed,
      midi_duration_s: Math.round(midi.duration),
    }
    let exportStage: 'serialize' | 'audio_render' | 'video_encode' = 'serialize'
    track('export_started', exportBase)
    trackActivation('export_started')

    // MIDI-only output skips all render/encode work — just re-serialise the
    // loaded MidiFile to .mid bytes. Especially useful after "Open in file
    // mode" from a live session, where the raw .mid was never downloaded.
    if (settings.output === 'midi') {
      const bytes = await midiFileToBytes(midi)
      triggerMidiDownload(bytes, `${sanitiseFilename(midi.name)}.mid`)
      exportModal.close()
      this.showSuccess(`↓ ${sanitiseFilename(midi.name)}.mid`)
      track('export_completed', {
        ...exportBase,
        elapsed_ms: Math.round(performance.now() - exportStartedAt),
      })
      return
    }

    const wasPlaying = this.store.state.status === 'playing'
    // Snapshot the playhead so we can restore position after export instead of
    // snapping back to t=0.
    const resumeAt = this.clock.currentTime
    this.clock.pause()
    this.liveNotes.reset()
    this.synth.liveReleaseAll()
    this.store.setState('status', 'exporting')
    this.synth.pause()
    // The metronome schedules clicks on its own look-ahead timer against the
    // *global* Tone context — left running, it would keep scheduling straight
    // through OfflineAudioRenderer's setContext() swap into the offline
    // render. Stop it for the duration; restored in the finally below.
    const metronomeWasRunning = this.metronome.running.value
    this.metronome.stop()

    const needsVideo = settings.output !== 'audio-only'
    const needsAudio = settings.output !== 'video-only'

    // WAV/MP3 render entirely offline and never touch a visualization surface
    // — no lease, no pause/resize. Video capture pins exactly one surface for
    // the whole export via a lease so a visualization switch requested
    // mid-export can't swap the canvas out from under the encoder; any switch
    // attempted while the lease is held is deferred by SurfaceRouter and
    // replayed (latest request wins) once we release() below.
    const lease = needsVideo ? this.surfaces.acquireCaptureLease() : null
    // Only the leased surface needs to stop ticking for capture — the other
    // one is already paused+hidden from being inactive (see SurfaceRouter).
    lease?.surface.pauseAutoRender()
    const exportingPiano = lease !== null && lease.surface === this.pianoRenderer

    // Only resize the canvas when we're actually rendering video.
    const originalCanvas = lease?.surface.canvasSize ?? null
    const target = needsVideo ? resolveExportDims(settings.resolution) : null
    const resized =
      lease !== null &&
      target !== null &&
      originalCanvas !== null &&
      (target.width !== originalCanvas.width || target.height !== originalCanvas.height)
    if (resized && lease) {
      lease.surface.resize(target.width, target.height, 1)
    }

    // Snapshot viewport state so we can restore after export. Vertical/Square
    // exports optionally zoom onto the piece's pitch range + override scroll
    // speed for a more cinematic feel; landscape exports leave both untouched.
    // Piano-only: the guitar surface has no pitch-range/zoom concept — its
    // fretboard layout already adapts to whatever canvas dimensions it gets.
    const originalPps = this.pianoRenderer.currentPixelsPerSecond
    const originalRange = this.pianoRenderer.pitchRange
    const isSocialFormat =
      exportingPiano &&
      needsVideo &&
      (settings.resolution === 'vertical' || settings.resolution === 'square')
    let pitchChanged = false
    let ppsChanged = false
    if (isSocialFormat) {
      if (settings.focus === 'fit') {
        const fit = fitPitchRange(midi)
        this.pianoRenderer.setPitchRange(fit.min, fit.max)
        pitchChanged = true
      }
      const pps = speedToPps(settings.speed)
      if (pps !== originalPps) {
        this.pianoRenderer.setZoom(pps)
        ppsChanged = true
      }
    }

    const filename =
      settings.output === 'audio-only' ? `midee.${settings.audioFormat}` : 'midee.mp4'

    try {
      let audioBuffer: AudioBuffer | undefined
      if (needsAudio) {
        // Load without VideoExporter: that chunk embeds Mediabunny (~tens of kB
        // parsed) and must not run before / in parallel with offline audio setup.
        const { renderAudioOffline } = await import('./audio/OfflineAudioRenderer')
        exportStage = 'audio_render'
        exportModal.updateProgress('Rendering audio', 0)
        try {
          // Per-stage progress: pct flows straight through. The bar resets
          // between stages; the stage label makes that explicit.
          audioBuffer = await renderAudioOffline({
            midi,
            instrumentId: INSTRUMENTS[this.instrumentIndex]!.id,
            volume: this.store.state.volume,
            disabledTrackIds: this.synth.getDisabledTrackIds(),
            onRenderAudioProgressMode: (d) => exportModal.setRenderAudioProgressMode(d),
            onProgress: (pct) => exportModal.updateProgress('Rendering audio', pct),
          })
        } catch (err) {
          console.error('Offline audio render failed:', err)
          // Audio-only has nothing to export without it — surface the error.
          if (settings.output === 'audio-only') throw err
          // av / video-only continue silently without sound — a real quality
          // hit that was previously invisible. Mark it as a degradation.
          trackEvent('export_degraded', { stage: 'audio_render', output: settings.output })
          this.showError(t('error.audio.renderFailed'))
        }
      }

      // Audio-only ships WAV or MP3 — both are macOS-Gatekeeper-safe legacy audio
      // types (unlike the MP4-container .m4a this replaced) and need no codec. Trim
      // the offline render's tail to midi.duration first so the file isn't ~1.5s too
      // long, then download directly — no VideoExporter. MP3's encoder (lamejs) is
      // dynamic-imported so it stays out of the initial bundle.
      if (settings.output === 'audio-only') {
        if (!audioBuffer) throw new Error('Audio-only export requires a rendered audio buffer')
        const trimmed = trimAudioBuffer(audioBuffer, midi.duration)
        let bytes: Uint8Array
        let mime: string
        if (settings.audioFormat === 'wav') {
          bytes = audioBufferToWav(trimmed)
          mime = 'audio/wav'
        } else {
          const { audioBufferToMp3 } = await import('./export/mp3')
          bytes = audioBufferToMp3(trimmed)
          mime = 'audio/mpeg'
        }
        const url = URL.createObjectURL(new Blob([bytes.slice().buffer], { type: mime }))
        const a = document.createElement('a')
        a.href = url
        a.download = filename
        a.click()
        setTimeout(() => URL.revokeObjectURL(url), 5000)
        exportModal.close()
        this.showSuccess(`↓ ${t('toast.export.ready', { filename })}`)
        track('export_completed', {
          ...exportBase,
          elapsed_ms: Math.round(performance.now() - exportStartedAt),
        })
        return
      }

      exportStage = 'video_encode'
      // needsVideo is true on every path that reaches here (audio-only
      // returned above), so the lease was always acquired — this guard is
      // just for narrowing.
      if (!lease) throw new Error('video export requires a capture lease')
      const { VideoExporter } = await import('./export/VideoExporter')
      if (import.meta.env.VITE_ENABLE_E2E === '1') {
        lease.surface.canvas.dataset.e2eCaptureSource =
          lease.surface === this.pianoRenderer ? 'piano' : 'guitar'
      }
      const exporter = new VideoExporter(lease.surface.canvas)
      this.currentExporter = exporter

      const exportAudio =
        audioBuffer && settings.output === 'av'
          ? trimAudioBuffer(audioBuffer, midi.duration)
          : audioBuffer

      await exporter.export({
        fps: settings.fps,
        duration: midi.duration,
        mode: settings.output,
        filename,
        bitrate: resolveExportBitrate(settings.resolution),
        ...(exportAudio ? { audio: exportAudio } : {}),
        onSeek: (t) => this.clock.seek(t),
        onRenderFrame: (t, dt) => lease.surface.renderManualFrame(t, dt),
        onProgress: (stage, pct) => exportModal.updateProgress(stage, pct),
      })
      exportModal.close()
      this.showSuccess(`↓ ${t('toast.export.ready', { filename })}`)
      track('export_completed', {
        ...exportBase,
        elapsed_ms: Math.round(performance.now() - exportStartedAt),
      })
    } catch (err) {
      const isCancel = err instanceof DOMException && err.name === 'AbortError'
      if (!isCancel) {
        console.error('Export failed:', err)
        this.showError((err as Error).message || t('error.export.generic'))
      }
      track(isCancel ? 'export_cancelled' : 'export_failed', {
        ...exportBase,
        stage: exportStage,
        elapsed_ms: Math.round(performance.now() - exportStartedAt),
      })
      exportModal.close()
    } finally {
      this.currentExporter = null
      if (resized && lease && originalCanvas) {
        // Match window dimensions instead of the stale originalCanvas values
        // in case the window was resized while we were exporting.
        lease.surface.resize(window.innerWidth, window.innerHeight, originalCanvas.resolution)
      }
      if (pitchChanged) this.pianoRenderer.setPitchRange(originalRange.min, originalRange.max)
      if (ppsChanged) this.pianoRenderer.setZoom(originalPps)
      lease?.surface.resumeAutoRender()
      // Restore the real playhead before replaying a deferred visualization
      // request. Export swept the clock through synthetic frame times; the
      // newly active surface must render at the restored time, not that stale
      // request-time export position.
      this.clock.seek(resumeAt)
      if (lease) {
        try {
          await lease.release(this.clock.currentTime)
        } catch (err) {
          console.error('Deferred visualization switch failed:', err)
          document.body.classList.toggle(
            'visualization-guitar',
            this.surfaces.currentMode === 'guitar',
          )
          if (
            this.store.state.visualizationForced === null &&
            this.store.state.visualizationMode === 'guitar'
          ) {
            this.store.setVisualizationMode('piano')
          }
        }
      }
      if (metronomeWasRunning) this.metronome.start()
      this.store.setState('status', 'ready')
      if (wasPlaying) {
        this.clock.play()
        this.store.setState('status', 'playing')
      }
    }
  }

  private cancelExport(): void {
    this.currentExporter?.cancel()
  }

  // Entry point for every "open MIDI" action — top strip button, track panel,
  // play-mode entry without a loaded file, learn-hub upload CTA. Routes through
  // the unified `MidiPickerModal` (drop / file picker / samples).
  //
  // `target` pins the destination at *call time*, not at file-pick time. This
  // matters because `requestMode('play')` from Learn opens the picker without
  // flipping the mode (we don't want a half-set-up Play surface flashing while
  // the user is still choosing). If we read `store.state.mode` inside the
  // file callback, it would still be 'learn' and the file would route to
  // LearnController instead of Play. Explicit target avoids the race.
  openFilePicker(target?: 'play' | 'learn'): void {
    const resolveTarget = (): 'play' | 'learn' =>
      target ?? (this.store.state.mode === 'learn' ? 'learn' : 'play')
    void this.midiPickerHandle.get().then((modal) => {
      modal.open({
        onFile: (file) => {
          if (resolveTarget() === 'learn') {
            void this.ensureLearnController().then((c) => c.loadMidiFromFile(file, 'picker'))
          } else {
            void this.loadMidi(file, 'picker')
          }
        },
        onSample: (id) => {
          if (resolveTarget() === 'learn') {
            void this.ensureLearnController().then((c) => c.loadSample(id))
          } else {
            void this.loadSample(id)
          }
        },
      })
    })
  }

  // Thin delegation wrapper — AppCtx exposes this method so callers
  // (createApp.ts, Solid mode components) don't need to know about the
  // lazyHandle indirection.
  ensureLearnController(): Promise<LearnController> {
    return this.learnControllerHandle.get()
  }

  private openExportModal(): void {
    void this.exportHandle.get().then((m) => m.open())
  }

  // Play-mode sample loader. Learn has its own via LearnController.loadSample.
  private async loadSample(sampleId: string): Promise<void> {
    const sample = getSample(sampleId)
    if (!sample) return
    this.primeInteractiveAudio()
    let midi: Awaited<ReturnType<typeof fetchSampleMidi>>
    try {
      midi = await fetchSampleMidi(sample)
    } catch (err) {
      console.error('[loadSample] fetch failed', err)
      trackEvent('sample_load_failed', { sample_id: sampleId, target: 'play' })
      this.showError(t('error.sample.fetchFailed'))
      return
    }
    this.loadSessionAsFile(midi)
    this.resetPlaybackTelemetry()
    trackMidiLoaded({
      source: 'sample',
      sampleId,
      trackCount: midi.tracks.length,
      noteCount: countNotes(midi),
      durationS: Math.round(midi.duration),
    })
    // Samples are a "watch it" gesture — start playback as soon as the synth
    // is ready. Sample click counts as the user gesture that unlocks audio.
    setTimeout(() => {
      if (this.store.state.mode === 'play' && this.store.state.status !== 'playing') {
        this.clock.play()
        this.store.setState('status', 'playing')
      }
    }, 250)
  }

  private requestMode(mode: Exclude<AppMode, 'home'>): void {
    if (mode === 'live') {
      this.enterLiveMode()
      return
    }
    if (mode === 'learn') {
      // Re-clicking Learn while already inside an exercise pops back to the
      // hub. closeActiveExercise is idempotent (no-op when no runner) so this
      // is safe to call regardless of prior state.
      const lc = this.learnControllerHandle.peek()
      if (this.store.state.mode === 'learn' && lc) {
        lc.closeActiveExercise('abandoned')
        return
      }
      this.store.setState('mode', 'learn')
      return
    }
    if (this.store.state.loadedMidi) {
      this.enterPlayMode()
      return
    }
    // Pin the target — without it, the picker would read `state.mode` at
    // file-pick time and (if we came here from Learn) route the file back
    // into Learn instead of opening it in Play. The user clicked Play; honor
    // that even if their mode hasn't flipped yet.
    this.openFilePicker('play')
  }

  // Hands the currently-loaded Play MIDI off to Learn and switches modes.
  // Queueing on the controller (instead of relying on Learn re-reading
  // `loadedMidi`) keeps Learn's MIDI store decoupled from Play's — the whole
  // reason LearnController has its own `learnState` in the first place.
  private enterLearnWithCurrentMidi(): void {
    const midi = this.store.state.loadedMidi
    if (!midi) return
    track('learn_from_play', { duration_s: Math.round(midi.duration) })
    void this.ensureLearnController().then((c) => {
      c.queueMidi(midi)
      this.store.setState('mode', 'learn')
    })
  }

  // Thin delegators: each flips the store and lets Solid's mode shell run
  // the side effects (onMount in HomeMode/PlayMode/LiveMode/LearnMode).
  private enterHomeMode(): void {
    this.store.enterHome()
  }

  private enterLiveMode(primeAudio = true): void {
    setNextLiveOpts({ primeAudio })
    this.store.enterLive()
  }

  private enterPlayMode(): void {
    this.store.enterPlay()
  }

  // Schedules a UI side-effect to run at (roughly) the AudioContext time
  // `ctxTime`. Used so the visual press of a loop-played note lands with the
  // audio instead of up to 150 ms early when the scheduler runs ahead.
  private deferToCtxTime(ctxTime: number, fn: () => void): void {
    const ctxNow = this.synth.audioContextTime
    const delayMs = Math.max(0, (ctxTime - ctxNow) * 1000)
    if (delayMs < 2) {
      fn()
      return
    }
    setTimeout(fn, delayMs)
  }

  private toggleSessionRecord(): void {
    if (!this.sessionRec.recording.value) {
      this.primeInteractiveAudio()
      this.sessionRec.start()
      track('session_started')
      return
    }
    const { events, duration } = this.sessionRec.stop()
    if (events.length === 0) {
      this.showError(t('toast.recording.empty'))
      track('session_record_empty')
      return
    }
    // Hold the recording in memory and let the user pick next steps — saving
    // a .mid, flipping into file mode to visualize + export MP4, or tossing it.
    this.pendingSession = { events, duration }
    const noteCount = events.reduce((n, e) => n + (e.type === 'on' ? 1 : 0), 0)
    void this.postSessionHandle.get().then((m) => m.open(duration, noteCount))
    track('session_recorded', { duration_s: Math.round(duration), notes: noteCount })
  }

  private async handleSessionAction(action: SessionAction): Promise<void> {
    const pending = this.pendingSession
    // onAction only fires from inside the modal; if it ran, the modal exists.
    this.postSessionHandle.peek()?.close()
    if (!pending) return

    track('session_action', { action, duration_s: Math.round(pending.duration) })

    if (action === 'discard') {
      this.pendingSession = null
      return
    }

    if (action === 'download') {
      const bytes = await encodeCapturedEvents(pending.events, {
        bpm: this.metronomeBpm(),
        closeOrphansAt: pending.duration,
        midiName: 'midee session',
        trackName: 'Live performance',
      })
      triggerMidiDownload(bytes, 'midee-session.mid')
      this.showSuccess(`↓ ${t('toast.session.saved', { seconds: Math.round(pending.duration) })}`)
      this.pendingSession = null
      return
    }

    if (action === 'open-in-file') {
      const midi = sessionToMidiFile(
        pending.events,
        pending.duration,
        this.metronomeBpm(),
        `Live session · ${Math.round(pending.duration)}s`,
      )
      this.pendingSession = null
      this.loadSessionAsFile(midi)
    }
  }

  // Drops the live-session MidiFile into the same play-mode pipeline used by
  // imported .mid files — so it immediately plays back as a rolling piano roll
  // with MP4 / WAV export available. Same contract as loadMidi(): after
  // completePlayLoad, <PlayMode/>'s effect owns the surface side effects
  // (renderer.loadMidi, trackPanel.render, dropzone.hide,
  // keyboardInput.enable, document.title) — don't repeat them here.
  private loadSessionAsFile(midi: import('./core/midi/types').MidiFile): void {
    this.resetInteractionState()
    this.store.beginPlayLoad()
    this.surfaces.clearMidi()
    this.synth.load(midi).catch((err) => console.error('SynthEngine.load failed:', err))
    this.store.completePlayLoad(midi)
    this.resetPlaybackTelemetry()
  }

  private async saveLoopAsMidi(): Promise<void> {
    const snap = this.liveLooper.snapshot()
    if (snap.events.length === 0) return
    const bytes = await encodeCapturedEvents(snap.events, {
      bpm: this.metronomeBpm(),
      closeOrphansAt: snap.duration,
      midiName: 'midee loop',
      trackName: 'Loop',
    })
    triggerMidiDownload(bytes, 'midee-loop.mid')
    this.showSuccess(`↓ ${t('toast.loop.saved')}`)
    track('loop_saved', {
      duration_s: Math.round(snap.duration),
      layers: this.liveLooper.layerCount.value,
    })
  }

  private metronomeBpm(): number {
    return this.metronome.bpm.value
  }

  // ── Chord overlay ──────────────────────────────────────────────────────
  private toggleChordOverlay(): void {
    this.chordOverlayOn = !this.chordOverlayOn
    this.applyChordOverlayVisibility()
    this.customizeMenu?.setChord(this.chordOverlayOn)
    chordOverlayStore.save(this.chordOverlayOn)
    track('chord_overlay_toggled', { on: this.chordOverlayOn })
    if (this.chordOverlayOn && this.chordOverlay.isVisible) {
      // Force a fresh reading on toggle-on so the user sees a chord (or "—")
      // immediately, even if the clock isn't ticking right now. Only the
      // throttle timestamp is reset — chordLastSig must stay in lockstep
      // with the overlay's displayed reading (see maybeUpdateChordOverlay),
      // so if the held pitches changed while the overlay was off this call
      // sees a signature mismatch and repaints.
      this.chordLastRunMs = 0
      this.maybeUpdateChordOverlay(this.clock.currentTime)
    }
  }

  // Effective visibility = user's saved preference AND current mode supports it.
  // Play mode is excluded — the chord readout is a "what am I playing?" cue,
  // not a passive playback annotation.
  private applyChordOverlayVisibility(): void {
    const allowedHere = this.store.state.mode !== 'play'
    this.chordOverlay.setVisible(this.chordOverlayOn && allowedHere)
  }

  // Builds the active-pitch set from the right sources for the current mode,
  // detects a chord, and pushes it to the overlay. Gated on the overlay being
  // *visible* — not just the saved preference — because in play mode (where
  // the overlay never shows) collectActivePitches scans every elapsed note,
  // and the preference defaults to on for everyone. The whole body sits
  // behind the ~70ms throttle for the same reason: chords don't change at
  // 60 fps, so the worst-case readout latency is imperceptible while the
  // per-tick scan is not free on long files.
  //
  // Invariant: `chordLastSig` always matches what the overlay displays —
  // they are only ever written together below. Callers must not reset the
  // signature independently or a skipped update leaves a stale reading.
  private maybeUpdateChordOverlay(time: number): void {
    if (!this.chordOverlayOn || !this.chordOverlay.isVisible) return
    const now = performance.now()
    if (now - this.chordLastRunMs < 70) return
    this.chordLastRunMs = now
    const pitches = this.collectActivePitches(time)
    const sig = pitchSignature(pitches)
    if (sig === this.chordLastSig) return
    this.chordLastSig = sig
    this.chordOverlay.update(detectChord(pitches))
  }

  private collectActivePitches(currentTime: number): Set<number> {
    const set = new Set<number>()
    const mode = this.store.state.mode

    // Live performance — what the player and looper are pressing right now.
    // Learn counts here too: the user plays along, so the chord readout should
    // narrate their held notes (the visibility gate already allows non-play).
    if (mode === 'live' || mode === 'home' || mode === 'learn') {
      for (const [pitch] of this.liveNotes.heldNotes) set.add(pitch)
      for (const [pitch] of this.loopNotes.heldNotes) set.add(pitch)
      return set
    }

    if (mode === 'play') {
      // Play mode — every visible-track note overlapping the playhead, plus
      // any live-keyboard notes the user is playing alongside the file.
      const midi = this.store.state.loadedMidi
      if (midi) {
        for (const track of midi.tracks) {
          if (!this.pianoRenderer.isTrackVisible(track.id)) continue
          if (track.isDrum) continue
          for (const note of track.notes) {
            if (note.time > currentTime) break
            if (note.time + note.duration > currentTime) set.add(note.pitch)
          }
        }
      }
      for (const [pitch] of this.liveNotes.heldNotes) set.add(pitch)
    }
    return set
  }

  resetInteractionState(): void {
    this.releaseActivePianoPointerNote()
    this.clock.pause()
    this.clock.seek(0)
    this.synth.pause()
    this.synth.seek(0)
    this.liveNotes.reset()
    this.loopNotes.reset()
    this.liveLooper.clear()
    this.sessionRec.cancel()
    this.metronome.stop()
    this.synth.liveReleaseAll()
    this.closeTransientOverlays()
  }

  // Dismiss every modal-style overlay so mode switches and fresh-load flows
  // don't leave a stale picker / export / post-session card floating over the
  // new surface. Idempotent — `.close()` is a no-op when the modal is already
  // hidden. Popovers (instrument menu, customize) close themselves on the
  // outside click that triggered the transition.
  private closeTransientOverlays(): void {
    this.exportHandle.peek()?.close()
    this.postSessionHandle.peek()?.close()
    this.midiPickerHandle.peek()?.close()
  }

  primeInteractiveAudio(): void {
    if (this.audioPrimed) return
    this.audioPrimed = true
    this.clock.prime()
    this.synth.primeLiveInput()
    window.removeEventListener('pointerdown', this.onFirstPointerDown)
    window.removeEventListener('keydown', this.onFirstKeyDown, true)
  }

  private applyTheme(theme: Theme): void {
    this.surfaces.setTheme(theme)
    this.customizeMenu?.setTheme(this.themeIndex)
    this.trackPanel?.setTheme(theme)
    const accent = theme.uiAccentCSS
    document.documentElement.style.setProperty('--accent', accent)
    document.documentElement.style.setProperty('--accent-soft', `${accent}2e`)
    document.documentElement.style.setProperty('--accent-glow', `${accent}66`)
  }

  private showLoading(): void {
    this.loadingEl = document.createElement('div')
    this.loadingEl.id = 'loading-overlay'
    this.loadingEl.innerHTML = `
      <div class="loading-inner">
        <div class="loading-spinner"></div>
        <div class="loading-text">Loading…</div>
      </div>
    `
    document.querySelector('#ui-overlay')!.appendChild(this.loadingEl)
  }

  private hideLoading(): void {
    this.loadingEl?.remove()
    this.loadingEl = null
  }

  private showError(message: string): void {
    showError(message)
  }

  private showSuccess(message: string): void {
    showSuccess(message)
  }

  dispose(): void {
    for (const unsub of this.unsubs) unsub()
    this.unsubs = []
    this.releaseActivePianoPointerNote()
    this.releaseAllLiveNotes()
    document.removeEventListener('visibilitychange', this.onVisibilityChange)
    window.removeEventListener('blur', this.onWindowBlur)
    window.removeEventListener('pointerdown', this.onFirstPointerDown)
    window.removeEventListener('keydown', this.onFirstKeyDown, true)
    this.pianoRenderer.canvas.removeEventListener('pointerdown', this.onCanvasPointerDown)
    this.pianoRenderer.canvas.removeEventListener('pointermove', this.onCanvasPointerMove)
    this.pianoRenderer.canvas.removeEventListener('pointerup', this.onCanvasPointerUp)
    this.pianoRenderer.canvas.removeEventListener('pointercancel', this.onCanvasPointerUp)
    this.pianoRenderer.canvas.removeEventListener('pointerleave', this.onCanvasPointerUp)
    this.dropzone.dispose()
    this.controls.dispose()
    this.kbdResizer.dispose()
    this.midiInput.dispose()
    this.keyboardInput.dispose()
    this.liveLooper.dispose()
    this.sessionRec.dispose()
    this.metronome.dispose()
    this.chordOverlay.dispose()
    this.customizeMenu.dispose()
    this.clock.dispose()
    this.surfaces.destroy()
    this.synth.dispose()
  }
}

// User-preference persistence. Each entry exposes load()/save() backed by
// localStorage. Defined here (not in persistence.ts) because the defaults
// depend on runtime values — current theme list, instrument list, etc.
const themeIndexStore = indexPersisted(
  'midee.themeIndex',
  Math.max(
    0,
    THEMES.findIndex((t) => t.name === 'Sunset'),
  ),
  THEMES.length,
)
// New visitors default to Upright (1.2 MB of self-hosted samples) so first-load
// is fast. Returning users keep whatever they had, including Salamander Grand.
const instrumentIndexStore = indexPersisted(
  'midee.instrumentIndex',
  Math.max(
    0,
    INSTRUMENTS.findIndex((i) => i.id === 'upright'),
  ),
  INSTRUMENTS.length,
)
const particleIndexStore = indexPersisted(
  'midee.particleIndex',
  Math.max(
    0,
    PARTICLE_STYLES.findIndex((s) => s.id === 'embers'),
  ),
  PARTICLE_STYLES.length,
)
const metronomeBpmStore = numberPersisted('midee.metronomeBpm', 120, 40, 240)
// Chord readout defaults *on*: it's the headline live-mode cue. The
// boolean store treats "no preference" as the fallback (true), and only
// an explicit "false" turns it off.
const chordOverlayStore = booleanPersisted('midee.chordOverlay', true)

// Strips characters that misbehave in filenames across Windows/macOS/Linux.
// Falls back to a constant if the result is empty.
function sanitiseFilename(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|]+/g, ' ').trim()
  return cleaned.length > 0 ? cleaned : 'midee'
}
