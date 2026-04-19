import { categorizeMidiDevice, track, trackActivation } from './analytics'
import { Metronome } from './audio/Metronome'
import { INSTRUMENTS, SynthEngine } from './audio/SynthEngine'
import { MasterClock } from './core/clock/MasterClock'
import { parseMidiFile } from './core/midi/parser'
import { booleanPersisted, indexPersisted, numberPersisted } from './core/persistence'
import { fetchSampleMidi, getSample } from './core/samples'
// VideoExporter + OfflineAudioRenderer pull in mp4-muxer and an offline Tone
// context (~60 KB combined). They're only reachable via the Export button, so
// we dynamic-import them in startExport() and let Vite split them out of the
// main chunk. Types stay as type-only imports — no runtime cost.
import type { VideoExporter } from './export/VideoExporter'
import { ComputerKeyboardInput } from './midi/ComputerKeyboardInput'
import { LiveNoteStore } from './midi/LiveNoteStore'
import { LoopEngine } from './midi/LoopEngine'
import type { CapturedEvent } from './midi/MidiEncoding'
import { encodeCapturedEvents, midiFileToBytes, triggerMidiDownload } from './midi/MidiEncoding'
import { MidiInputManager, type MidiNoteEvent } from './midi/MidiInputManager'
import { SessionRecorder } from './midi/SessionRecorder'
import { sessionToMidiFile } from './midi/SessionToMidi'
import { PARTICLE_STYLES } from './renderer/ParticleSystem'
import { PianoRollRenderer } from './renderer/PianoRollRenderer'
import { THEMES, type Theme } from './renderer/theme'
import { appState } from './store/state'
import { Controls } from './ui/Controls'
import { DropZone } from './ui/DropZone'
import { ExportModal, type ExportResolution, type ExportSettings } from './ui/ExportModal'
import { InstrumentMenu } from './ui/InstrumentMenu'
import { KeyboardResizer } from './ui/KeyboardResizer'
import { PostSessionModal, type SessionAction } from './ui/PostSessionModal'
import { TrackPanel } from './ui/TrackPanel'
import { installViewportClassSync } from './ui/utils'
import { detectChord } from './core/music/ChordDetector'
import { PracticeEngine, type PracticeStatus } from './core/practice/PracticeEngine'
import { ChordOverlay } from './ui/ChordOverlay'
import { CustomizeMenu } from './ui/CustomizeMenu'

export class App {
  private clock = new MasterClock()
  private renderer = new PianoRollRenderer()
  private synth = new SynthEngine()
  private midiInput!: MidiInputManager
  private keyboardInput!: ComputerKeyboardInput
  private liveNotes = new LiveNoteStore()
  private loopNotes = new LiveNoteStore()
  private loopEngine!: LoopEngine
  private metronome = new Metronome()
  private sessionRec!: SessionRecorder
  private postSessionModal!: PostSessionModal
  private pendingSession: { events: CapturedEvent[]; duration: number } | null = null
  private instrumentMenu!: InstrumentMenu
  private activeMouseNote: number | null = null
  private dropzone!: DropZone
  private controls!: Controls
  private trackPanel!: TrackPanel
  private exportModal!: ExportModal
  private kbdResizer!: KeyboardResizer
  private chordOverlay!: ChordOverlay
  private customizeMenu!: CustomizeMenu
  private practiceEngine!: PracticeEngine
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
  // Sustain pedal state. When `pedalDown`, note-offs are added to
  // `sustainedPitches` and the audio release is deferred until pedal-up.
  // Visual/recording paths still fire on key-up so the roll reflects
  // what the player's hands actually did.
  // Two independent sources (hardware CC64 + spacebar stand-in) are merged
  // with an OR so either can engage sustain without fighting the other.
  private pedalDown = false
  private midiPedalDown = false
  private keyPedalDown = false
  private sustainedPitches = new Set<number>()
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
      container: overlay,
      state: appState,
      clock: this.clock,
      onSeek: (t) => {
        this.synth.seek(t)
        this.liveNotes.reset()
        this.practiceEngine?.notifySeek(t)
      },
      onZoom: (pps) => this.renderer.setZoom(pps),
      onThemeCycle: () => this.cycleTheme(),
      onMidiConnect: () => void this.connectMidi(),
      onOpenTracks: () => this.trackPanel.toggle(),
      onRecord: () => {
        // First-time vs repeat opens are derivable in PostHog funnels via
        // "first occurrence per user" — no need for a duplicate event.
        track('export_opened', { has_midi: appState.loadedMidi.value !== null })
        this.exportModal.open()
      },
      onOpenFile: () => this.openFilePicker(),
      onModeRequest: (mode) => this.requestMode(mode),
      onHome: () => this.enterHomeMode(),
      onInstrumentCycle: () => this.cycleInstrument(),
      onParticleCycle: () => this.cycleParticleStyle(),
      onLoopToggle: () => this.loopEngine.toggle(),
      onLoopClear: () => this.loopEngine.clear(),
      onLoopSave: () => this.saveLoopAsMidi(),
      onLoopUndo: () => this.loopEngine.undo(),
      onMetronomeToggle: () => this.metronome.toggle(),
      onMetronomeBpmChange: (bpm) => {
        this.metronome.setBpm(bpm)
        metronomeBpmStore.save(this.metronome.bpm.value)
      },
      onSessionToggle: () => this.toggleSessionRecord(),
      onHudPinChange: (pinned) => hudPinnedStore.save(pinned),
      onChordToggle: () => this.toggleChordOverlay(),
      onPracticeToggle: () => this.togglePracticeMode(),
    })

    this.controls.setHudPinned(hudPinnedStore.load())

    const pushLoop = (): void =>
      this.controls.updateLoopState(this.loopEngine.state.value, this.loopEngine.layerCount.value)
    this.unsubs.push(
      this.loopEngine.state.subscribe(pushLoop),
      this.loopEngine.layerCount.subscribe(pushLoop),
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
      this.loopEngine.progress.subscribe((p) => this.controls.updateLoopProgress(p)),
    )
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
    this.unsubs.push(
      this.sessionRec.recording.subscribe(recomputeActivity),
      this.loopEngine.state.subscribe(recomputeActivity),
      this.metronome.running.subscribe(recomputeActivity),
    )
    recomputeActivity()

    this.trackPanel = new TrackPanel(overlay, this.renderer, () => this.openFilePicker())
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

    this.exportModal = new ExportModal(overlay)
    this.exportModal.onStart = (settings) => void this.startExport(settings)
    this.exportModal.onCancel = () => this.cancelExport()

    this.postSessionModal = new PostSessionModal(overlay)
    this.postSessionModal.onAction = (action) => this.handleSessionAction(action)

    this.kbdResizer = new KeyboardResizer(
      overlay,
      () => this.renderer.currentKeyboardHeight,
      (px) => this.renderer.setKeyboardHeight(px),
    )
    this.kbdResizer.restoreSaved()

    this.chordOverlay = new ChordOverlay(this.controls.chordSlot)
    this.chordOverlayOn = chordOverlayStore.load()
    this.applyChordOverlayVisibility()
    // File mode actively plays a MIDI — the chord chip would just narrate
    // what the user is already hearing without contributing to "play along"
    // affordances. Keep it scoped to live/home where it confirms what the
    // player is sounding.
    this.unsubs.push(appState.mode.subscribe(() => this.applyChordOverlayVisibility()))

    // Customization popover bundles theme / particles / chord toggle —
    // collapses three topbar pills into a single trigger.
    this.customizeMenu = new CustomizeMenu(
      this.controls.customizeSlot,
      overlay,
      THEMES,
      PARTICLE_STYLES,
      {
        onSelectTheme:    (idx) => this.setThemeByIndex(idx),
        onSelectParticle: (idx) => this.setParticleByIndex(idx),
        onToggleChord:    () => this.toggleChordOverlay(),
      },
    )
    this.customizeMenu.setChord(this.chordOverlayOn)

    this.practiceEngine = new PracticeEngine(this.clock, {
      onWaitStart: () => this.onPracticeWaitStart(),
      onWaitEnd:   (resumeAt) => this.onPracticeWaitEnd(resumeAt),
    })
    this.unsubs.push(this.practiceEngine.status.subscribe((s) => this.onPracticeStatusChange(s)))
    this.controls.updatePracticeState(false, false)

    this.applyTheme(THEMES[this.themeIndex]!)
    this.applyInstrument()
    this.applyParticleStyle()

    // Kick off piano sample download in the background — safe at boot since
    // we don't touch AudioContext yet. Makes the first note feel instant.
    const w = window as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void
    }
    if (typeof w.requestIdleCallback === 'function') {
      w.requestIdleCallback(() => this.synth.preloadDefault(), { timeout: 2000 })
    } else {
      setTimeout(() => this.synth.preloadDefault(), 600)
    }

    this.controls.updateMidiStatus(this.midiInput.status.value, '')
    this.dropzone.updateMidiStatus(this.midiInput.status.value, '')

    this.unsubs.push(
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
        this.maybeUpdateChordOverlay(t)
      }),
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
      }),
      appState.volume.subscribe((v) => this.synth.setVolume(v)),
      appState.speed.subscribe((s) => {
        this.clock.speed = s
        this.synth.setSpeed(s)
      }),
    )

    // ── Live input wiring (MIDI device + computer keyboard) ───────────────
    this.unsubs.push(
      this.midiInput.noteOn.subscribe((evt) => {
        if (evt) this.handleLiveNoteOn(evt, 'midi')
      }),
      this.midiInput.noteOff.subscribe((evt) => {
        if (evt) this.handleLiveNoteOff(evt)
      }),
      this.midiInput.pedal.subscribe((down) => {
        this.midiPedalDown = down
        this.applyPedalState('midi')
      }),
      this.keyboardInput.noteOn.subscribe((evt) => {
        if (evt) this.handleLiveNoteOn(evt, 'keyboard')
      }),
      this.keyboardInput.noteOff.subscribe((evt) => {
        if (evt) this.handleLiveNoteOff(evt)
      }),
      this.keyboardInput.pedal.subscribe((down) => {
        this.keyPedalDown = down
        this.applyPedalState('keyboard')
      }),
      this.keyboardInput.octave.subscribe((o) => this.controls.updateOctave(o)),
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
    window.addEventListener('keydown', this.onFirstKeyDown, { passive: true })

    this.enterHomeMode()
    void this.autoConnectMidi()
  }

  private releaseAllLiveNotes(): void {
    const now = this.clock.currentTime
    this.liveNotes.releaseAll(now)
    this.synth.liveReleaseAll()
    // Any pedal-sustained pitches have open note-ons in the loop/session
    // streams. Close them at `now` (tab-hide / blur time) — otherwise the
    // next time the player comes back, the next note-off closes the wrong
    // event and the recorded phrase has an impossible duration.
    for (const pitch of this.sustainedPitches) {
      this.loopEngine.captureNoteOff(pitch, now)
      this.sessionRec.captureNoteOff(pitch, now)
    }
    this.sustainedPitches.clear()
    this.pedalDown = false
    this.midiPedalDown = false
    this.keyPedalDown = false
  }

  // Called whenever a new MIDI is loaded so the telemetry flags scoped to
  // "this piece" fire for the next one too. `first_play` re-arms, playback
  // milestones reset so 30/60/120s fire again for the new file.
  private resetPlaybackTelemetry(): void {
    this.firstPlayLogged = false
    this.playbackMilestones.clear()
  }

  private handleLiveNoteOn(
    evt: MidiNoteEvent,
    source: 'midi' | 'keyboard' | 'touch' = 'midi',
  ): void {
    if (appState.status.value === 'exporting') return
    // Home → first note dissolves into live mode. File mode plays-along alongside
    // whatever scheduled MIDI is running (or paused), which is the point.
    if (appState.mode.value === 'home') this.enterLiveMode(false)

    if (!this.firstLiveNoteLogged) {
      this.firstLiveNoteLogged = true
      track('first_live_note', { source })
      trackActivation('live_note')
    }

    // Re-pressing a pitch that was pedal-sustained: the new attack takes
    // over. Emit the sustained note's note-off into loop/session first so
    // their streams don't end up with overlapping note-ons for one pitch,
    // and clear the sustain flag so pedal-up later doesn't fire a stale
    // release on a note that's currently ringing.
    if (this.sustainedPitches.has(evt.pitch)) {
      this.loopEngine.captureNoteOff(evt.pitch, evt.clockTime)
      this.sessionRec.captureNoteOff(evt.pitch, evt.clockTime)
      this.sustainedPitches.delete(evt.pitch)
    }
    this.synth.liveNoteOn(evt.pitch, evt.velocity)
    this.liveNotes.press(evt.pitch, evt.velocity, evt.clockTime)
    this.renderer.burstParticleAt(evt.pitch)
    this.loopEngine.captureNoteOn(evt.pitch, evt.velocity, evt.clockTime)
    this.sessionRec.captureNoteOn(evt.pitch, evt.velocity, evt.clockTime)

    // Practice mode (file mode only, while waiting): each correct press
    // chips away at the pending chord; the engine releases the clock when
    // every required pitch has landed.
    if (this.practiceEngine?.isWaiting) {
      this.practiceEngine.notePressed(evt.pitch)
    }

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
    // The visual piano-roll reflects actual hand motion — key-up is key-up
    // in live mode, even while the audio keeps ringing under the pedal.
    this.liveNotes.release(evt.pitch, evt.clockTime)
    if (this.pedalDown) {
      // Pedal held: defer audio release AND the loop/session note-off so
      // the recorded duration matches what the player actually heard.
      // Both stream-captures fire together at pedal-up (or at a re-press).
      this.sustainedPitches.add(evt.pitch)
    } else {
      this.synth.liveNoteOff(evt.pitch)
      this.loopEngine.captureNoteOff(evt.pitch, evt.clockTime)
      this.sessionRec.captureNoteOff(evt.pitch, evt.clockTime)
    }
  }

  private applyPedalState(source: 'midi' | 'keyboard'): void {
    const down = this.midiPedalDown || this.keyPedalDown
    if (down === this.pedalDown) return
    this.pedalDown = down
    if (down) {
      if (!this.firstPedalLogged) {
        this.firstPedalLogged = true
        track('pedal_used', { source })
      }
      return
    }
    // Pedal-up: release everything the damper was holding. Still-held keys
    // aren't in this set, so they keep ringing as expected. Fire the
    // loop/session note-offs here too — their durations are pedal-informed,
    // so the captured streams match what the player heard.
    const now = this.clock.currentTime
    for (const pitch of this.sustainedPitches) {
      this.synth.liveNoteOff(pitch)
      this.loopEngine.captureNoteOff(pitch, now)
      this.sessionRec.captureNoteOff(pitch, now)
    }
    this.sustainedPitches.clear()
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
      this.handleLiveNoteOff({
        pitch: this.activeMouseNote,
        velocity: 0,
        clockTime: this.clock.currentTime,
      })
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
    // Once a user denies the prompt, browsers remember the choice and
    // `requestMIDIAccess()` resolves silently — clicking the button again
    // does nothing visible. Detect that case and surface a help message
    // so the user knows they need to reset the permission via the browser
    // (lock icon → Site settings → MIDI devices → Allow).
    const wasBlocked = this.midiInput.status.value === 'blocked'
    const ok = await this.midiInput.requestAccess()
    if (!ok && this.midiInput.status.value === 'blocked') {
      const msg = wasBlocked
        ? 'MIDI is blocked. Click the 🔒 icon in your address bar → Site settings → allow MIDI, then reload.'
        : 'MIDI permission denied. Click again, or enable it via the 🔒 icon in your address bar.'
      this.showError(msg)
    }
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
      this.practiceEngine?.loadMidi(midi)
      document.title = `${midi.name} · midee`
      this.dropzone.hide()
      this.resetPlaybackTelemetry()
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
      const msg =
        err instanceof Error && err.name === 'EmptyMidiError'
          ? 'That MIDI has no notes in it.'
          : "Could not read that file — make sure it's a valid MIDI."
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
  }

  private cycleInstrument(): void {
    this.instrumentIndex = (this.instrumentIndex + 1) % INSTRUMENTS.length
    this.applyInstrument()
    instrumentIndexStore.save(this.instrumentIndex)
  }

  private setInstrumentById(id: string): void {
    const idx = INSTRUMENTS.findIndex((i) => i.id === id)
    if (idx < 0 || idx === this.instrumentIndex) return
    const from = INSTRUMENTS[this.instrumentIndex]?.id
    this.instrumentIndex = idx
    this.applyInstrument()
    instrumentIndexStore.save(this.instrumentIndex)
    track('instrument_changed', { from, to: id })
  }

  private applyInstrument(): void {
    const info = INSTRUMENTS[this.instrumentIndex]!
    this.controls.updateInstrument(info.name)
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
  }

  private applyParticleStyle(): void {
    const info = PARTICLE_STYLES[this.particleIndex]!
    this.renderer.setParticleStyle(info.id)
    this.customizeMenu?.setParticle(this.particleIndex)
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
    const resized =
      target !== null &&
      (target.width !== originalCanvas.width || target.height !== originalCanvas.height)
    if (resized) {
      this.renderer.resize(target.width, target.height, 1)
    }

    // Snapshot viewport state so we can restore after export. Vertical/Square
    // exports optionally zoom onto the piece's pitch range + override scroll
    // speed for a more cinematic feel; landscape exports leave both untouched.
    const originalPps = this.renderer.currentPixelsPerSecond
    const originalRange = this.renderer.pitchRange
    const isSocialFormat =
      needsVideo && (settings.resolution === 'vertical' || settings.resolution === 'square')
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

    const filename = settings.output === 'audio-only' ? 'midee.m4a' : 'midee.mp4'

    // Lazy-load the export chunk — first export pays a ~60 KB one-time cost;
    // users who never export don't pay it at all.
    const [{ VideoExporter }, { renderAudioOffline }] = await Promise.all([
      import('./export/VideoExporter'),
      import('./audio/OfflineAudioRenderer'),
    ])
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
            volume: appState.volume.value,
          })
        } catch (err) {
          console.error('Offline audio render failed:', err)
          // Audio-only has nothing to export without it — surface the error.
          if (settings.output === 'audio-only') throw err
          this.showError('Audio render failed — MP4 will be silent.')
        }
      }

      await exporter.export({
        fps: settings.fps,
        duration: midi.duration,
        mode: settings.output,
        filename,
        ...(audioBuffer ? { audio: audioBuffer } : {}),
        onSeek: (t) => this.clock.seek(t),
        onRenderFrame: (t, dt) => this.renderer.renderManualFrame(t, dt),
        onProgress: (stage, pct) => this.exportModal.updateProgress(stage, pct),
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
    let midi: Awaited<ReturnType<typeof fetchSampleMidi>>
    try {
      midi = await fetchSampleMidi(sample)
    } catch (err) {
      console.error('[loadSample] fetch failed', err)
      this.showError('Could not load that sample — check your network and try again.')
      return
    }
    this.loadSessionAsFile(midi)
    this.resetPlaybackTelemetry()
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
    this.practiceEngine?.setEnabled(false)
    this.practiceEngine?.loadMidi(null)
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
    this.practiceEngine?.setEnabled(false)
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
    this.practiceEngine?.loadMidi(midi)
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
        bpm: this.metronomeBpm(),
        closeOrphansAt: pending.duration,
        midiName: 'midee session',
        trackName: 'Live performance',
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
    this.practiceEngine?.loadMidi(midi)
    this.dropzone.hide()
    // Typing keyboard stays on — users can play along with their own session.
    this.keyboardInput.enable()
    document.title = `${midi.name} · midee`
  }

  private saveLoopAsMidi(): void {
    const snap = this.loopEngine.snapshot()
    if (snap.events.length === 0) return
    const bytes = encodeCapturedEvents(snap.events, {
      bpm: this.metronomeBpm(),
      closeOrphansAt: snap.duration,
      midiName: 'midee loop',
      trackName: 'Loop',
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

  // ── Chord overlay ──────────────────────────────────────────────────────
  private toggleChordOverlay(): void {
    this.chordOverlayOn = !this.chordOverlayOn
    this.applyChordOverlayVisibility()
    this.customizeMenu?.setChord(this.chordOverlayOn)
    chordOverlayStore.save(this.chordOverlayOn)
    track('chord_overlay_toggled', { on: this.chordOverlayOn })
    if (this.chordOverlayOn && this.chordOverlay.isVisible) {
      // Force a fresh reading on toggle-on so the user sees a chord (or "—")
      // immediately, even if the clock isn't ticking right now.
      this.chordLastSig = ''
      this.chordLastRunMs = 0
      this.maybeUpdateChordOverlay(this.clock.currentTime)
    }
  }

  // Effective visibility = user's saved preference AND current mode supports it.
  // File mode is excluded — the chord readout is a "what am I playing?" cue,
  // not a passive playback annotation.
  private applyChordOverlayVisibility(): void {
    const allowedHere = appState.mode.value !== 'file'
    this.chordOverlay.setVisible(this.chordOverlayOn && allowedHere)
  }

  // Builds the active-pitch set from the right sources for the current mode,
  // detects a chord, and pushes it to the overlay. Throttled to ~70ms because
  // chords don't change at 60 fps and the per-frame cost on long files is
  // wasted otherwise.
  private maybeUpdateChordOverlay(time: number): void {
    if (!this.chordOverlayOn) return
    const now = performance.now()
    const pitches = this.collectActivePitches(time)
    const sig = pitchSignature(pitches)
    if (sig === this.chordLastSig && now - this.chordLastRunMs < 250) return
    if (sig !== this.chordLastSig || now - this.chordLastRunMs >= 70) {
      this.chordLastSig = sig
      this.chordLastRunMs = now
      const reading = detectChord(pitches)
      this.chordOverlay.update(reading)
    }
  }

  private collectActivePitches(currentTime: number): Set<number> {
    const set = new Set<number>()
    const mode = appState.mode.value

    // Live performance — what the player and looper are pressing right now.
    if (mode === 'live' || mode === 'home') {
      for (const [pitch] of this.liveNotes.heldNotes) set.add(pitch)
      for (const [pitch] of this.loopNotes.heldNotes) set.add(pitch)
      return set
    }

    if (mode === 'file') {
      // File mode — every visible-track note overlapping the playhead, plus
      // any live-keyboard notes the user is playing alongside the file.
      const midi = appState.loadedMidi.value
      if (midi) {
        for (const track of midi.tracks) {
          if (!this.renderer.isTrackVisible(track.id)) continue
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

  // ── Practice (Synthesia-style wait) mode ───────────────────────────────
  private togglePracticeMode(): void {
    if (appState.mode.value !== 'file') {
      this.showError('Practice mode is only available while playing a MIDI file.')
      return
    }
    if (!appState.loadedMidi.value) {
      this.openFilePicker()
      return
    }
    // Re-seed visible-track filter before flipping the toggle so the very
    // first wait already respects whatever the user has muted via the
    // tracks panel.
    this.practiceEngine.setVisibleTracks(this.collectVisibleTrackIds())
    const enabled = this.practiceEngine.toggle()
    track(enabled ? 'practice_mode_enabled' : 'practice_mode_disabled')
  }

  private collectVisibleTrackIds(): string[] | null {
    const midi = appState.loadedMidi.value
    if (!midi) return null
    return midi.tracks.filter(t => this.renderer.isTrackVisible(t.id)).map(t => t.id)
  }

  private onPracticeWaitStart(): void {
    // Mirror engine pause into appState/synth so audio releases and the
    // status pill flips. The seek-to-onset is implicit — the engine engages
    // at exactly step.time; we don't snap because the strike line already
    // sits flush with the keyboard.
    this.clock.pause()
    appState.pausePlayback()
  }

  private onPracticeWaitEnd(resumeAt: number): void {
    // Nudge past the chord onset so the audio scheduler doesn't re-trigger
    // the notes the user just played. status → 'playing' triggers the synth
    // to schedule from the new clock time downstream.
    this.clock.seek(resumeAt)
    this.clock.play()
    appState.startPlaying()
  }

  private onPracticeStatusChange(s: PracticeStatus): void {
    this.controls.updatePracticeState(s.enabled, s.waiting)
    this.renderer.setPracticeHints(
      s.enabled ? s.pending : null,
      s.enabled ? s.accepted : null,
    )
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
    this.customizeMenu?.setTheme(this.themeIndex)
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
    for (const unsub of this.unsubs) unsub()
    this.unsubs = []
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
    this.practiceEngine.dispose()
    this.chordOverlay.dispose()
    this.customizeMenu.dispose()
    this.clock.dispose()
    this.renderer.destroy()
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
const hudPinnedStore = booleanPersisted('midee.hudPinned', false)
// Chord readout defaults *on*: it's the headline live-mode cue. The
// boolean store treats "no preference" as the fallback (true), and only
// an explicit "false" turns it off.
const chordOverlayStore = booleanPersisted('midee.chordOverlay', true)

// Scans the MIDI's notes for min/max pitch and pads outward by a few keys so
// the visible range feels natural rather than clipping right at the extremes.
// Clamps to the MIDI-usable octaves on 88-key piano.
function fitPitchRange(midi: import('./core/midi/types').MidiFile): { min: number; max: number } {
  let lo = 108,
    hi = 21
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
    case 'compact':
      return 300
    case 'standard':
      return 200
    case 'drama':
      return 120
  }
}

// Strips characters that misbehave in filenames across Windows/macOS/Linux.
// Falls back to a constant if the result is empty.
function sanitiseFilename(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|]+/g, ' ').trim()
  return cleaned.length > 0 ? cleaned : 'midee'
}

// Stable string for an active-pitch set so the chord overlay can short-circuit
// recomputation when nothing changed between frames.
function pitchSignature(pitches: Set<number>): string {
  if (pitches.size === 0) return ''
  return Array.from(pitches)
    .sort((a, b) => a - b)
    .join('.')
}

// Resolves a user-facing resolution preset to concrete pixel dimensions.
// Returns `null` when the preset means "keep whatever the canvas currently is"
// so the caller can skip the resize entirely.
function resolveExportDims(preset: ExportResolution): { width: number; height: number } | null {
  switch (preset) {
    case '720p':
      return { width: 1280, height: 720 }
    case '1080p':
      return { width: 1920, height: 1080 }
    case 'vertical':
      return { width: 1080, height: 1920 }
    case 'square':
      return { width: 1080, height: 1080 }
    case 'match':
      return null
  }
}
