import { parseMidiFile } from './core/midi/parser'
import { MasterClock } from './core/clock/MasterClock'
import { PianoRollRenderer } from './renderer/PianoRollRenderer'
import { PARTICLE_STYLES } from './renderer/ParticleSystem'
import { SynthEngine, INSTRUMENTS } from './audio/SynthEngine'
import { Metronome } from './audio/Metronome'
import { appState } from './store/state'
import { DropZone } from './ui/DropZone'
import { Controls } from './ui/Controls'
import { TrackPanel } from './ui/TrackPanel'
import { ExportModal, type ExportSettings, type ExportResolution } from './ui/ExportModal'
import { KeyboardResizer } from './ui/KeyboardResizer'
import { VideoExporter } from './export/VideoExporter'
import { renderAudioOffline } from './audio/OfflineAudioRenderer'
import { THEMES, type Theme } from './renderer/theme'
import { MidiInputManager, type MidiNoteEvent } from './midi/MidiInputManager'
import { ComputerKeyboardInput } from './midi/ComputerKeyboardInput'
import { LiveNoteStore } from './midi/LiveNoteStore'
import { LoopEngine } from './midi/LoopEngine'
import { SessionRecorder } from './midi/SessionRecorder'
import { encodeCapturedEvents, midiFileToBytes, triggerMidiDownload } from './midi/MidiEncoding'
import type { CapturedEvent } from './midi/MidiEncoding'
import { sessionToMidiFile } from './midi/SessionToMidi'
import { PostSessionModal, type SessionAction } from './ui/PostSessionModal'
import { InstrumentMenu } from './ui/InstrumentMenu'
import { installViewportClassSync } from './ui/utils'
import { getSample, fetchSampleMidi } from './core/samples'
import { track, trackActivation, categorizeMidiDevice } from './analytics'

export class App {
  private clock         = new MasterClock()
  private renderer      = new PianoRollRenderer()
  private synth         = new SynthEngine()
  private midiInput!:   MidiInputManager
  private keyboardInput!: ComputerKeyboardInput
  private liveNotes     = new LiveNoteStore()
  private loopNotes     = new LiveNoteStore()
  private loopEngine!:  LoopEngine
  private metronome     = new Metronome()
  private sessionRec!:  SessionRecorder
  private postSessionModal!: PostSessionModal
  private pendingSession: { events: CapturedEvent[]; duration: number } | null = null
  private instrumentMenu!: InstrumentMenu
  private activeMouseNote: number | null = null
  private dropzone!:    DropZone
  private controls!:    Controls
  private trackPanel!:  TrackPanel
  private exportModal!: ExportModal
  private kbdResizer!:  KeyboardResizer
  private loadingEl:    HTMLElement | null = null
  private currentExporter: VideoExporter | null = null

  private themeIndex = loadThemeIndex()
  private instrumentIndex = loadInstrumentIndex()
  private particleIndex = loadParticleIndex()
  private audioPrimed = false
  // Analytics one-shot flags. Reset when a new file is loaded so a user
  // who opens MIDI A then MIDI B gets `first_play` events for both.
  private firstPlayLogged = false
  private firstLiveNoteLogged = false
  private playbackMilestones = new Set<number>()
  private onVisibilityChange = (): void => { if (document.hidden) this.releaseAllLiveNotes() }
  private onWindowBlur = (): void => this.releaseAllLiveNotes()
  private onFirstPointerDown = (): void => this.primeInteractiveAudio()
  private onFirstKeyDown = (): void => this.primeInteractiveAudio()

  async init(): Promise<void> {
    const canvas  = document.querySelector<HTMLCanvasElement>('#pianoroll')!
    const overlay = document.querySelector<HTMLElement>('#ui-overlay')!

    // Flip `body.is-touch` / `body.is-narrow` so CSS can adapt (bottom-sheet
    // popovers, touch-friendly hit targets, etc.).
    installViewportClassSync()

    await this.renderer.init(canvas)
    this.renderer.attachClock(this.clock)
    this.renderer.setLiveNoteStore(this.liveNotes)
    this.renderer.setLoopNoteStore(this.loopNotes)

    this.midiInput = new MidiInputManager(this.clock)
    this.keyboardInput = new ComputerKeyboardInput(this.clock)

    this.loopEngine = new LoopEngine(
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

    this.dropzone = new DropZone(
      overlay,
      (file) => void this.loadMidi(file),
      () => this.enterLiveMode(),
      (sampleId) => this.loadSample(sampleId),
    )

    this.controls = new Controls({
      container:     overlay,
      state:         appState,
      clock:         this.clock,
      onSeek:        (t) => { this.synth.seek(t); this.liveNotes.reset() },
      onZoom:        (pps) => this.renderer.setZoom(pps),
      onThemeCycle:  () => this.cycleTheme(),
      onMidiConnect: () => void this.connectMidi(),
      onOpenTracks:  () => this.trackPanel.toggle(),
      onRecord:      () => {
        // First-time vs repeat opens are derivable in PostHog funnels via
        // "first occurrence per user" — no need for a duplicate event.
        track('export_opened', { has_midi: appState.loadedMidi.value !== null })
        this.exportModal.open()
      },
      onOpenFile:    () => this.openFilePicker(),
      onModeRequest: (mode) => this.requestMode(mode),
      onHome:        () => this.enterHomeMode(),
      onInstrumentCycle: () => this.cycleInstrument(),
      onParticleCycle:   () => this.cycleParticleStyle(),
      onLoopToggle:      () => this.loopEngine.toggle(),
      onLoopClear:       () => this.loopEngine.clear(),
      onLoopSave:        () => this.saveLoopAsMidi(),
      onLoopUndo:        () => this.loopEngine.undo(),
      onMetronomeToggle:     () => this.metronome.toggle(),
      onMetronomeBpmChange:  (bpm) => {
        this.metronome.setBpm(bpm)
        saveMetronomeBpm(this.metronome.bpm.value)
      },
      onSessionToggle:       () => this.toggleSessionRecord(),
      onHudPinChange:        (pinned) => saveHudPinned(pinned),
    })

    this.controls.setHudPinned(loadHudPinned())

    const pushLoop = (): void => this.controls.updateLoopState(
      this.loopEngine.state.value,
      this.loopEngine.layerCount.value,
    )
    this.loopEngine.state.subscribe(pushLoop)
    this.loopEngine.layerCount.subscribe(pushLoop)
    pushLoop()

    this.metronome.setBpm(loadMetronomeBpm())
    const pushMetronome = (): void => this.controls.updateMetronome(
      this.metronome.running.value,
      this.metronome.bpm.value,
    )
    this.metronome.running.subscribe(pushMetronome)
    this.metronome.bpm.subscribe(pushMetronome)
    this.metronome.beatCount.subscribe((count) => {
      if (count === 0) return
      const isDownbeat = ((count - 1) % 4) === 0
      this.controls.pulseMetronomeBeat(isDownbeat)
    })
    pushMetronome()

    const pushSession = (): void => this.controls.updateSessionRecording(
      this.sessionRec.recording.value,
      this.sessionRec.elapsed.value,
    )
    this.sessionRec.recording.subscribe(pushSession)
    this.sessionRec.elapsed.subscribe(pushSession)
    this.loopEngine.progress.subscribe((p) => this.controls.updateLoopProgress(p))
    pushSession()

    // Keep the HUD visible whenever something is actively running — session
    // capture, any loop state, or the metronome. Prevents auto-hide from
    // stealing the transport mid-take.
    const recomputeActivity = (): void => {
      const recording = this.sessionRec.recording.value
      const loopActive = this.loopEngine.state.value !== 'idle'
      const metroOn = this.metronome.running.value
      this.controls.setHudActivityLock(recording || loopActive || metroOn)
    }
    this.sessionRec.recording.subscribe(recomputeActivity)
    this.loopEngine.state.subscribe(recomputeActivity)
    this.metronome.running.subscribe(recomputeActivity)
    recomputeActivity()

    this.trackPanel = new TrackPanel(overlay, this.renderer, () => this.openFilePicker())
    this.trackPanel.setTrigger(this.controls.tracksButton)

    this.instrumentMenu = new InstrumentMenu(this.controls.instrumentSlot, overlay)
    this.instrumentMenu.onSelect = (id) => this.setInstrumentById(id)
    this.synth.loadingInstrument.subscribe((id) => {
      this.instrumentMenu.setLoading(id)
      this.controls.setInstrumentLoading(id !== null)
    })
    this.instrumentMenu.setLoading(this.synth.loadingInstrument.value)
    this.controls.setInstrumentLoading(this.synth.loadingInstrument.value !== null)

    this.exportModal = new ExportModal(overlay)
    this.exportModal.onStart  = (settings) => void this.startExport(settings)
    this.exportModal.onCancel = () => this.cancelExport()

    this.postSessionModal = new PostSessionModal(overlay)
    this.postSessionModal.onAction = (action) => this.handleSessionAction(action)

    this.kbdResizer = new KeyboardResizer(
      overlay,
      () => this.renderer.currentKeyboardHeight,
      (px) => this.renderer.setKeyboardHeight(px),
    )
    this.kbdResizer.restoreSaved()

    this.applyTheme(THEMES[this.themeIndex]!)
    this.applyInstrument()
    this.applyParticleStyle()

    // Kick off piano sample download in the background — safe at boot since
    // we don't touch AudioContext yet. Makes the first note feel instant.
    const w = window as unknown as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void }
    if (typeof w.requestIdleCallback === 'function') {
      w.requestIdleCallback(() => this.synth.preloadDefault(), { timeout: 2000 })
    } else {
      setTimeout(() => this.synth.preloadDefault(), 600)
    }

    this.controls.updateMidiStatus(this.midiInput.status.value, '')
    this.dropzone.updateMidiStatus(this.midiInput.status.value, '')

    this.clock.subscribe((t) => {
      appState.setCurrentTime(t)
      // Engagement milestones — cross once per loaded file. The 30s mark
      // doubles as the activation trigger: watched ≥30s = real user.
      for (const m of [30, 60, 120]) {
        if (t >= m && !this.playbackMilestones.has(m)) {
          this.playbackMilestones.add(m)
          track('playback_milestone', { seconds: m, mode: appState.mode.value })
          if (m === 30) trackActivation('playback_30s')
        }
      }
    })

    appState.status.subscribe((status) => {
      if (appState.mode.value === 'file' && status === 'playing') {
        void this.synth.play(this.clock.currentTime)
        if (!this.firstPlayLogged) {
          this.firstPlayLogged = true
          const midi = appState.loadedMidi.value
          track('first_play', {
            mode: 'file',
            duration_s: midi ? Math.round(midi.duration) : null,
          })
        }
      } else if (status === 'paused') {
        this.synth.pause()
        if (appState.mode.value === 'live') {
          this.liveNotes.releaseAll(this.clock.currentTime)
          this.synth.liveReleaseAll()
        }
      }
    })

    appState.volume.subscribe((v) => this.synth.setVolume(v))
    appState.speed.subscribe((s) => {
      this.clock.speed = s
      this.synth.setSpeed(s)
    })

    // ── Live input wiring (MIDI device + computer keyboard) ───────────────
    this.midiInput.noteOn.subscribe((evt) => { if (evt) this.handleLiveNoteOn(evt, 'midi') })
    this.midiInput.noteOff.subscribe((evt) => { if (evt) this.handleLiveNoteOff(evt) })
    this.keyboardInput.noteOn.subscribe((evt) => { if (evt) this.handleLiveNoteOn(evt, 'keyboard') })
    this.keyboardInput.noteOff.subscribe((evt) => { if (evt) this.handleLiveNoteOff(evt) })
    this.keyboardInput.octave.subscribe((o) => this.controls.updateOctave(o))

    // Mouse/touch on the on-screen keyboard — down to press, move to slide
    // between keys (glissando), up/cancel/leave to release.
    canvas.addEventListener('pointerdown', this.onCanvasPointerDown)
    canvas.addEventListener('pointermove', this.onCanvasPointerMove)
    canvas.addEventListener('pointerup', this.onCanvasPointerUp)
    canvas.addEventListener('pointercancel', this.onCanvasPointerUp)
    canvas.addEventListener('pointerleave', this.onCanvasPointerUp)

    // Update MIDI button whenever either status or device name changes.
    // Reading the *other* signal's current value avoids a stale-name flash.
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
    })
    this.midiInput.deviceName.subscribe((name) => {
      this.controls.updateMidiStatus(this.midiInput.status.value, name)
      this.dropzone.updateMidiStatus(this.midiInput.status.value, name)
    })

    // Release all held notes when the page loses focus (prevents stuck notes)
    document.addEventListener('visibilitychange', this.onVisibilityChange)
    window.addEventListener('blur', this.onWindowBlur)
    window.addEventListener('pointerdown', this.onFirstPointerDown, { passive: true })
    window.addEventListener('keydown', this.onFirstKeyDown, { passive: true })

    this.enterHomeMode()
    void this.autoConnectMidi()
  }

  private releaseAllLiveNotes(): void {
    this.liveNotes.releaseAll(this.clock.currentTime)
    this.synth.liveReleaseAll()
  }

  private handleLiveNoteOn(evt: MidiNoteEvent, source: 'midi' | 'keyboard' | 'touch' = 'midi'): void {
    if (appState.status.value === 'exporting') return
    // Home → first note dissolves into live mode. File mode plays-along alongside
    // whatever scheduled MIDI is running (or paused), which is the point.
    if (appState.mode.value === 'home') this.enterLiveMode(false)

    if (!this.firstLiveNoteLogged) {
      this.firstLiveNoteLogged = true
      track('first_live_note', { source })
      trackActivation('live_note')
    }

    this.synth.liveNoteOn(evt.pitch, evt.velocity)
    this.liveNotes.press(evt.pitch, evt.velocity, evt.clockTime)
    this.renderer.burstParticleAt(evt.pitch)
    this.loopEngine.captureNoteOn(evt.pitch, evt.velocity, evt.clockTime)
    this.sessionRec.captureNoteOn(evt.pitch, evt.velocity, evt.clockTime)

    // Live mode's "tap a note to start the session" shortcut — don't hijack
    // file mode's transport, which the user drives with the play button.
    if (appState.mode.value === 'live') {
      const s = appState.status.value
      if (s === 'idle' || s === 'ready' || s === 'paused') {
        this.clock.play()
        appState.startPlaying()
      }
    }
  }

  private handleLiveNoteOff(evt: MidiNoteEvent): void {
    const mode = appState.mode.value
    if (mode !== 'live' && mode !== 'file') return
    this.synth.liveNoteOff(evt.pitch)
    this.liveNotes.release(evt.pitch, evt.clockTime)
    this.loopEngine.captureNoteOff(evt.pitch, evt.clockTime)
    this.sessionRec.captureNoteOff(evt.pitch, evt.clockTime)
  }

  private onCanvasPointerDown = (e: PointerEvent): void => {
    if (appState.status.value === 'exporting') return
    const pitch = this.renderer.pitchAtClientPoint(e.clientX, e.clientY)
    if (pitch === null) return

    this.primeInteractiveAudio()
    if (appState.mode.value === 'home') this.enterLiveMode(false)
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    e.preventDefault()

    if (this.activeMouseNote !== null) {
      this.handleLiveNoteOff({ pitch: this.activeMouseNote, velocity: 0, clockTime: this.clock.currentTime })
    }
    this.activeMouseNote = pitch
    this.handleLiveNoteOn({ pitch, velocity: 0.8, clockTime: this.clock.currentTime }, 'touch')
  }

  private onCanvasPointerMove = (e: PointerEvent): void => {
    // Only react while the user is actively pressing — this is the glissando
    // path, not a hover state.
    if (this.activeMouseNote === null) return
    if (appState.status.value === 'exporting') return
    const pitch = this.renderer.pitchAtClientPoint(e.clientX, e.clientY)
    if (pitch === null || pitch === this.activeMouseNote) return
    const prev = this.activeMouseNote
    this.activeMouseNote = pitch
    this.handleLiveNoteOff({ pitch: prev, velocity: 0, clockTime: this.clock.currentTime })
    this.handleLiveNoteOn({ pitch, velocity: 0.8, clockTime: this.clock.currentTime }, 'touch')
  }

  private onCanvasPointerUp = (): void => {
    if (this.activeMouseNote === null) return
    const pitch = this.activeMouseNote
    this.activeMouseNote = null
    this.handleLiveNoteOff({ pitch, velocity: 0, clockTime: this.clock.currentTime })
  }

  private async connectMidi(): Promise<void> {
    this.primeInteractiveAudio()
    await this.midiInput.requestAccess()
  }

  private async autoConnectMidi(): Promise<void> {
    await this.midiInput.requestAccess({ silent: true })
  }

  private async loadMidi(file: File): Promise<void> {
    const previousMode = appState.mode.value
    const previousMidi = appState.loadedMidi.value
    this.resetInteractionState()
    appState.beginFileLoad()
    this.renderer.clearMidi()
    this.showLoading()

    try {
      const midi = await parseMidiFile(file)
      this.synth.load(midi).catch((err) => console.error('SynthEngine.load failed:', err))
      appState.completeFileLoad(midi)
      this.renderer.loadMidi(midi)
      this.trackPanel.render(midi)
      document.title = `${midi.name} · midee`
      this.dropzone.hide()
      this.firstPlayLogged = false
      this.playbackMilestones.clear()
      track('midi_loaded', {
        source: 'file_picker',
        track_count: midi.tracks.length,
        duration_s: Math.round(midi.duration),
        file_size_kb: Math.round(file.size / 1024),
      })
    } catch (err) {
      console.error('Failed to load MIDI:', err)
      // Only failure path for loadMidi is parsing — bucket as such so we
      // avoid sending free-text error messages (high cardinality + PII risk).
      track('midi_load_failed', { source: 'file_picker', error_type: 'parse' })
      if (previousMode === 'file' && previousMidi) {
        appState.enterFile()
        this.renderer.loadMidi(previousMidi)
        this.trackPanel.render(previousMidi)
        this.dropzone.hide()
      } else if (previousMode === 'live') {
        this.enterLiveMode(false)
      } else if (previousMode === 'home') this.enterHomeMode()
      else appState.setReady()
      this.showError('Could not read that file — make sure it\'s a valid MIDI.')
    } finally {
      this.hideLoading()
    }
  }

  private cycleTheme(): void {
    this.themeIndex = (this.themeIndex + 1) % THEMES.length
    this.applyTheme(THEMES[this.themeIndex]!)
    saveThemeIndex(this.themeIndex)
  }

  private cycleInstrument(): void {
    this.instrumentIndex = (this.instrumentIndex + 1) % INSTRUMENTS.length
    this.applyInstrument()
    saveInstrumentIndex(this.instrumentIndex)
  }

  private setInstrumentById(id: string): void {
    const idx = INSTRUMENTS.findIndex(i => i.id === id)
    if (idx < 0 || idx === this.instrumentIndex) return
    const from = INSTRUMENTS[this.instrumentIndex]?.id
    this.instrumentIndex = idx
    this.applyInstrument()
    saveInstrumentIndex(this.instrumentIndex)
    track('instrument_changed', { from, to: id })
  }

  private applyInstrument(): void {
    const info = INSTRUMENTS[this.instrumentIndex]!
    this.controls.updateInstrument(info.name)
    this.instrumentMenu?.setCurrent(info.id)
    void this.synth.setInstrument(info.id)
  }

  private cycleParticleStyle(): void {
    this.particleIndex = (this.particleIndex + 1) % PARTICLE_STYLES.length
    this.applyParticleStyle()
    saveParticleIndex(this.particleIndex)
  }

  private applyParticleStyle(): void {
    const info = PARTICLE_STYLES[this.particleIndex]!
    this.renderer.setParticleStyle(info.id)
    this.controls.updateParticleStyle(info.name)
  }

  private async startExport(settings: ExportSettings): Promise<void> {
    const midi = appState.loadedMidi.value
    if (!midi || appState.mode.value !== 'file') return

    const exportStartedAt = performance.now()
    track('export_started', {
      output: settings.output,
      resolution: settings.resolution,
      fps: settings.fps,
      focus: settings.focus,
      speed: settings.speed,
      midi_duration_s: Math.round(midi.duration),
    })
    trackActivation('export_started')

    // MIDI-only output skips all render/encode work — just re-serialise the
    // loaded MidiFile to .mid bytes. Especially useful after "Open in file
    // mode" from a live session, where the raw .mid was never downloaded.
    if (settings.output === 'midi') {
      const bytes = midiFileToBytes(midi)
      triggerMidiDownload(bytes, `${sanitiseFilename(midi.name)}.mid`)
      this.exportModal.close()
      this.showSuccess(`↓ ${sanitiseFilename(midi.name)}.mid`)
      track('export_completed', {
        output: 'midi',
        elapsed_ms: Math.round(performance.now() - exportStartedAt),
      })
      return
    }

    const wasPlaying = appState.status.value === 'playing'
    // Snapshot the playhead so we can restore position after export instead of
    // snapping back to t=0.
    const resumeAt = this.clock.currentTime
    this.clock.pause()
    this.liveNotes.reset()
    this.synth.liveReleaseAll()
    appState.beginExport()
    this.synth.pause()
    this.renderer.pauseAutoRender()

    const needsVideo = settings.output !== 'audio-only'
    const needsAudio = settings.output !== 'video-only'

    // Only resize the canvas when we're actually rendering video.
    const originalCanvas = this.renderer.canvasSize
    const target = needsVideo ? resolveExportDims(settings.resolution) : null
    const resized = target !== null &&
      (target.width !== originalCanvas.width || target.height !== originalCanvas.height)
    if (resized) {
      this.renderer.resize(target.width, target.height, 1)
    }

    // Snapshot viewport state so we can restore after export. Vertical/Square
    // exports optionally zoom onto the piece's pitch range + override scroll
    // speed for a more cinematic feel; landscape exports leave both untouched.
    const originalPps = this.renderer.currentPixelsPerSecond
    const originalRange = this.renderer.pitchRange
    const isSocialFormat = needsVideo &&
      (settings.resolution === 'vertical' || settings.resolution === 'square')
    let pitchChanged = false
    let ppsChanged = false
    if (isSocialFormat) {
      if (settings.focus === 'fit') {
        const fit = fitPitchRange(midi)
        this.renderer.setPitchRange(fit.min, fit.max)
        pitchChanged = true
      }
      const pps = speedToPps(settings.speed)
      if (pps !== originalPps) {
        this.renderer.setZoom(pps)
        ppsChanged = true
      }
    }

    const filename = settings.output === 'audio-only'
      ? 'midee.m4a'
      : 'midee.mp4'

    const exporter = new VideoExporter(this.renderer.canvas)
    this.currentExporter = exporter

    try {
      let audioBuffer: AudioBuffer | undefined
      if (needsAudio) {
        this.exportModal.updateProgress('Rendering audio', 0)
        try {
          audioBuffer = await renderAudioOffline({
            midi,
            instrumentId: INSTRUMENTS[this.instrumentIndex]!.id,
            volume:       appState.volume.value,
          })
        } catch (err) {
          console.error('Offline audio render failed:', err)
          // Audio-only has nothing to export without it — surface the error.
          if (settings.output === 'audio-only') throw err
          this.showError('Audio render failed — MP4 will be silent.')
        }
      }

      await exporter.export({
        fps:           settings.fps,
        duration:      midi.duration,
        mode:          settings.output,
        filename,
        ...(audioBuffer ? { audio: audioBuffer } : {}),
        onSeek:        (t) => this.clock.seek(t),
        onRenderFrame: (t, dt) => this.renderer.renderManualFrame(t, dt),
        onProgress:    (stage, pct) => this.exportModal.updateProgress(stage, pct),
      })
      this.exportModal.close()
      this.showSuccess(`↓ ${filename} ready`)
      track('export_completed', {
        output: settings.output,
        resolution: settings.resolution,
        fps: settings.fps,
        elapsed_ms: Math.round(performance.now() - exportStartedAt),
      })
    } catch (err) {
      const isCancel = err instanceof DOMException && err.name === 'AbortError'
      if (!isCancel) {
        console.error('Export failed:', err)
        this.showError((err as Error).message || 'Export failed — check console for details.')
      }
      track(isCancel ? 'export_cancelled' : 'export_failed', {
        output: settings.output,
        resolution: settings.resolution,
        elapsed_ms: Math.round(performance.now() - exportStartedAt),
      })
      this.exportModal.close()
    } finally {
      this.currentExporter = null
      if (resized) {
        // Match window dimensions instead of the stale originalCanvas values
        // in case the window was resized while we were exporting.
        this.renderer.resize(window.innerWidth, window.innerHeight, originalCanvas.resolution)
      }
      if (pitchChanged) this.renderer.setPitchRange(originalRange.min, originalRange.max)
      if (ppsChanged) this.renderer.setZoom(originalPps)
      this.renderer.resumeAutoRender()
      this.clock.seek(resumeAt)
      appState.setReady()
      if (wasPlaying) {
        this.clock.play()
        appState.startPlaying()
      }
    }
  }

  private cancelExport(): void {
    this.currentExporter?.cancel()
  }

  // Entry point for every "open MIDI" action — top strip button, track panel,
  // mode-transition fallbacks. Samples already live on the home card, so the
  // button goes straight to the native file picker instead of routing through
  // a redundant modal.
  private openFilePicker(): void {
    this.dropzone.openFilePicker()
  }

  private async loadSample(sampleId: string): Promise<void> {
    const sample = getSample(sampleId)
    if (!sample) return
    this.primeInteractiveAudio()
    let midi
    try {
      midi = await fetchSampleMidi(sample)
    } catch (err) {
      console.error('[loadSample] fetch failed', err)
      this.showError('Could not load that sample — check your network and try again.')
      return
    }
    this.loadSessionAsFile(midi)
    this.firstPlayLogged = false
    this.playbackMilestones.clear()
    track('midi_loaded', {
      source: 'sample',
      sample_id: sampleId,
      track_count: midi.tracks.length,
      duration_s: Math.round(midi.duration),
    })
    // Samples are a "watch it" gesture — start playback as soon as the synth
    // is ready. Sample click counts as the user gesture that unlocks audio.
    setTimeout(() => {
      if (appState.mode.value === 'file' && appState.status.value !== 'playing') {
        this.clock.play()
        appState.startPlaying()
      }
    }, 250)
  }

  private requestMode(mode: 'file' | 'live'): void {
    if (mode === 'live') {
      this.enterLiveMode()
      return
    }

    if (appState.loadedMidi.value) {
      this.enterFileMode()
      return
    }

    this.openFilePicker()
  }

  private enterHomeMode(): void {
    this.resetInteractionState()
    appState.enterHome()
    this.renderer.clearMidi()
    this.trackPanel.close()
    this.dropzone.show()
    // Keep computer keyboard live — pressing a note from the home screen
    // seamlessly dissolves into live mode.
    this.keyboardInput.enable()
    document.title = 'midee — drop a MIDI, watch it sing'
  }

  private enterLiveMode(primeAudio = true): void {
    const wasAlreadyLive = appState.mode.value === 'live'
    this.resetInteractionState()
    appState.enterLive()
    this.renderer.clearMidi()
    this.trackPanel.close()
    this.dropzone.hide()
    this.keyboardInput.enable()
    document.title = 'midee · live'
    if (primeAudio) this.primeInteractiveAudio()
    if (!wasAlreadyLive) {
      track('live_mode_entered', {
        midi_connected: this.midiInput.status.value === 'connected',
      })
    }
  }

  private enterFileMode(): void {
    const midi = appState.loadedMidi.value
    if (!midi) {
      this.openFilePicker()
      return
    }
    this.resetInteractionState()
    appState.enterFile()
    this.renderer.loadMidi(midi)
    this.trackPanel.render(midi)
    this.dropzone.hide()
    // Typing keyboard stays enabled — users can play along with the file.
    this.keyboardInput.enable()
    document.title = `${midi.name} · midee`
  }

  // Schedules a UI side-effect to run at (roughly) the AudioContext time
  // `ctxTime`. Used so the visual press of a loop-played note lands with the
  // audio instead of up to 150 ms early when the scheduler runs ahead.
  private deferToCtxTime(ctxTime: number, fn: () => void): void {
    const ctxNow = this.synth.audioContextTime
    const delayMs = Math.max(0, (ctxTime - ctxNow) * 1000)
    if (delayMs < 2) { fn(); return }
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
      this.showError('Nothing recorded — play a few notes while Record is on.')
      track('session_record_empty')
      return
    }
    // Hold the recording in memory and let the user pick next steps — saving
    // a .mid, flipping into file mode to visualize + export MP4, or tossing it.
    this.pendingSession = { events, duration }
    const noteCount = events.reduce((n, e) => n + (e.type === 'on' ? 1 : 0), 0)
    this.postSessionModal.open(duration, noteCount)
    track('session_recorded', { duration_s: Math.round(duration), notes: noteCount })
  }

  private handleSessionAction(action: SessionAction): void {
    const pending = this.pendingSession
    this.postSessionModal.close()
    if (!pending) return

    track('session_action', { action, duration_s: Math.round(pending.duration) })

    if (action === 'discard') {
      this.pendingSession = null
      return
    }

    if (action === 'download') {
      const bytes = encodeCapturedEvents(pending.events, {
        bpm:            this.metronomeBpm(),
        closeOrphansAt: pending.duration,
        midiName:       'midee session',
        trackName:      'Live performance',
      })
      triggerMidiDownload(bytes, 'midee-session.mid')
      this.showSuccess(`↓ midee-session.mid · ${Math.round(pending.duration)}s`)
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

  // Drops the live-session MidiFile into the same file-mode pipeline used by
  // imported .mid files — so it immediately plays back as a rolling piano roll
  // with MP4/M4A export available.
  private loadSessionAsFile(midi: import('./core/midi/types').MidiFile): void {
    this.resetInteractionState()
    appState.beginFileLoad()
    this.renderer.clearMidi()
    this.synth.load(midi).catch((err) => console.error('SynthEngine.load failed:', err))
    appState.completeFileLoad(midi)
    this.renderer.loadMidi(midi)
    this.trackPanel.render(midi)
    this.dropzone.hide()
    // Typing keyboard stays on — users can play along with their own session.
    this.keyboardInput.enable()
    document.title = `${midi.name} · midee`
  }

  private saveLoopAsMidi(): void {
    const snap = this.loopEngine.snapshot()
    if (snap.events.length === 0) return
    const bytes = encodeCapturedEvents(snap.events, {
      bpm:            this.metronomeBpm(),
      closeOrphansAt: snap.duration,
      midiName:       'midee loop',
      trackName:      'Loop',
    })
    triggerMidiDownload(bytes, 'midee-loop.mid')
    this.showSuccess('↓ midee-loop.mid')
    track('loop_saved', {
      duration_s: Math.round(snap.duration),
      layers: this.loopEngine.layerCount.value,
    })
  }

  private metronomeBpm(): number {
    return this.metronome.bpm.value
  }

  private resetInteractionState(): void {
    this.clock.pause()
    this.clock.seek(0)
    this.synth.pause()
    this.synth.seek(0)
    this.liveNotes.reset()
    this.loopNotes.reset()
    this.loopEngine.clear()
    this.sessionRec.cancel()
    this.metronome.stop()
    this.synth.liveReleaseAll()
  }

  private primeInteractiveAudio(): void {
    if (this.audioPrimed) return
    this.audioPrimed = true
    this.clock.prime()
    this.synth.primeLiveInput()
    window.removeEventListener('pointerdown', this.onFirstPointerDown)
    window.removeEventListener('keydown', this.onFirstKeyDown)
  }

  private applyTheme(theme: Theme): void {
    this.renderer.setTheme(theme)
    this.controls.updateThemeDot(theme.uiAccentCSS)
    this.controls.updateThemeLabel(theme.name)
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
    this.showToast(message, 'toast', 4000)
  }

  private showSuccess(message: string): void {
    this.showToast(message, 'toast toast--success', 3500)
  }

  private showToast(message: string, className: string, duration: number): void {
    const el = document.createElement('div')
    el.className = className
    el.textContent = message
    document.body.appendChild(el)
    setTimeout(() => el.remove(), duration)
  }

  dispose(): void {
    this.releaseAllLiveNotes()
    document.removeEventListener('visibilitychange', this.onVisibilityChange)
    window.removeEventListener('blur', this.onWindowBlur)
    window.removeEventListener('pointerdown', this.onFirstPointerDown)
    window.removeEventListener('keydown', this.onFirstKeyDown)
    this.renderer.canvas.removeEventListener('pointerdown', this.onCanvasPointerDown)
    this.renderer.canvas.removeEventListener('pointermove', this.onCanvasPointerMove)
    this.renderer.canvas.removeEventListener('pointerup', this.onCanvasPointerUp)
    this.renderer.canvas.removeEventListener('pointercancel', this.onCanvasPointerUp)
    this.renderer.canvas.removeEventListener('pointerleave', this.onCanvasPointerUp)
    this.dropzone.dispose()
    this.controls.dispose()
    this.kbdResizer.dispose()
    this.midiInput.dispose()
    this.keyboardInput.dispose()
    this.loopEngine.dispose()
    this.sessionRec.dispose()
    this.metronome.dispose()
    this.clock.dispose()
    this.renderer.destroy()
    this.synth.dispose()
  }
}

const THEME_STORAGE_KEY = 'midee.themeIndex'
const INSTRUMENT_STORAGE_KEY = 'midee.instrumentIndex'
const PARTICLE_STORAGE_KEY = 'midee.particleIndex'
const METRONOME_BPM_KEY = 'midee.metronomeBpm'
const HUD_PINNED_KEY = 'midee.hudPinned'

function loadThemeIndex(): number {
  const defaultIdx = THEMES.findIndex(t => t.name === 'Sunset')
  const fallback = defaultIdx >= 0 ? defaultIdx : 0
  const raw = localStorage.getItem(THEME_STORAGE_KEY)
  if (raw === null) return fallback
  const n = Number(raw)
  return Number.isInteger(n) && n >= 0 && n < THEMES.length ? n : fallback
}

function saveThemeIndex(index: number): void {
  localStorage.setItem(THEME_STORAGE_KEY, String(index))
}

function loadInstrumentIndex(): number {
  // New visitors default to Upright (light self-hosted samples, 1.2 MB) so
  // first-load is fast. Returning users with a saved preference keep whatever
  // they had, including the heavy Salamander Grand.
  const defaultIdx = INSTRUMENTS.findIndex(i => i.id === 'upright')
  const fallback = defaultIdx >= 0 ? defaultIdx : 0
  const raw = localStorage.getItem(INSTRUMENT_STORAGE_KEY)
  if (raw === null) return fallback
  const n = Number(raw)
  return Number.isInteger(n) && n >= 0 && n < INSTRUMENTS.length ? n : fallback
}

function saveInstrumentIndex(index: number): void {
  localStorage.setItem(INSTRUMENT_STORAGE_KEY, String(index))
}

function loadParticleIndex(): number {
  const defaultIndex = PARTICLE_STYLES.findIndex(s => s.id === 'embers')
  const fallback = defaultIndex >= 0 ? defaultIndex : 0
  const raw = localStorage.getItem(PARTICLE_STORAGE_KEY)
  if (raw === null) return fallback
  const n = Number(raw)
  return Number.isInteger(n) && n >= 0 && n < PARTICLE_STYLES.length ? n : fallback
}

function saveParticleIndex(index: number): void {
  localStorage.setItem(PARTICLE_STORAGE_KEY, String(index))
}

function loadMetronomeBpm(): number {
  const raw = localStorage.getItem(METRONOME_BPM_KEY)
  if (raw === null) return 120
  const n = Number(raw)
  return Number.isFinite(n) && n >= 40 && n <= 240 ? Math.round(n) : 120
}

function saveMetronomeBpm(bpm: number): void {
  localStorage.setItem(METRONOME_BPM_KEY, String(bpm))
}

// Scans the MIDI's notes for min/max pitch and pads outward by a few keys so
// the visible range feels natural rather than clipping right at the extremes.
// Clamps to the MIDI-usable octaves on 88-key piano.
function fitPitchRange(midi: import('./core/midi/types').MidiFile): { min: number; max: number } {
  let lo = 108, hi = 21
  for (const track of midi.tracks) {
    for (const n of track.notes) {
      if (n.pitch < lo) lo = n.pitch
      if (n.pitch > hi) hi = n.pitch
    }
  }
  if (hi < lo) return { min: 21, max: 108 }
  // Pad ~3 semitones each side; widen if the range is tiny so cards don't
  // look like a single-octave slice on a half-chorused piece.
  const pad = Math.max(3, Math.round((hi - lo) * 0.12))
  return {
    min: Math.max(21, lo - pad),
    max: Math.min(108, hi + pad),
  }
}

function speedToPps(speed: 'compact' | 'standard' | 'drama'): number {
  switch (speed) {
    case 'compact':  return 300
    case 'standard': return 200
    case 'drama':    return 120
  }
}

// Strips characters that misbehave in filenames across Windows/macOS/Linux.
// Falls back to a constant if the result is empty.
function sanitiseFilename(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|]+/g, ' ').trim()
  return cleaned.length > 0 ? cleaned : 'midee'
}

function loadHudPinned(): boolean {
  return localStorage.getItem(HUD_PINNED_KEY) === 'true'
}

function saveHudPinned(pinned: boolean): void {
  localStorage.setItem(HUD_PINNED_KEY, String(pinned))
}

// Resolves a user-facing resolution preset to concrete pixel dimensions.
// Returns `null` when the preset means "keep whatever the canvas currently is"
// so the caller can skip the resize entirely.
function resolveExportDims(preset: ExportResolution): { width: number; height: number } | null {
  switch (preset) {
    case '720p':     return { width: 1280, height: 720 }
    case '1080p':    return { width: 1920, height: 1080 }
    case 'vertical': return { width: 1080, height: 1920 }
    case 'square':   return { width: 1080, height: 1080 }
    case 'match':    return null
  }
}
