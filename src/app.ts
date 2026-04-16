import { parseMidiFile } from './core/midi/parser'
import { MasterClock } from './core/clock/MasterClock'
import { PianoRollRenderer } from './renderer/PianoRollRenderer'
import { SynthEngine } from './audio/SynthEngine'
import { appState } from './store/state'
import { DropZone } from './ui/DropZone'
import { Controls } from './ui/Controls'
import { TrackPanel } from './ui/TrackPanel'
import { ExportModal } from './ui/ExportModal'
import { KeyboardResizer } from './ui/KeyboardResizer'
import { VideoExporter } from './export/VideoExporter'
import { THEMES, type Theme } from './renderer/theme'
import { MidiInputManager, type MidiNoteEvent } from './midi/MidiInputManager'
import { ComputerKeyboardInput } from './midi/ComputerKeyboardInput'
import { LiveNoteStore } from './midi/LiveNoteStore'

export class App {
  private clock         = new MasterClock()
  private renderer      = new PianoRollRenderer()
  private synth         = new SynthEngine()
  private midiInput!:   MidiInputManager
  private keyboardInput!: ComputerKeyboardInput
  private liveNotes     = new LiveNoteStore()
  private activeMouseNote: number | null = null
  private dropzone!:    DropZone
  private controls!:    Controls
  private trackPanel!:  TrackPanel
  private exportModal!: ExportModal
  private kbdResizer!:  KeyboardResizer
  private loadingEl:    HTMLElement | null = null
  private currentExporter: VideoExporter | null = null

  private themeIndex = 0
  private audioPrimed = false
  private onVisibilityChange = (): void => { if (document.hidden) this.releaseAllLiveNotes() }
  private onWindowBlur = (): void => this.releaseAllLiveNotes()
  private onFirstPointerDown = (): void => this.primeInteractiveAudio()
  private onFirstKeyDown = (): void => this.primeInteractiveAudio()

  async init(): Promise<void> {
    const canvas  = document.querySelector<HTMLCanvasElement>('#pianoroll')!
    const overlay = document.querySelector<HTMLElement>('#ui-overlay')!

    await this.renderer.init(canvas)
    this.renderer.attachClock(this.clock)
    this.renderer.setLiveNoteStore(this.liveNotes)

    this.midiInput = new MidiInputManager(this.clock)
    this.keyboardInput = new ComputerKeyboardInput(this.clock)

    this.dropzone = new DropZone(
      overlay,
      (file) => void this.loadMidi(file),
      () => this.enterLiveMode(),
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
      onRecord:      () => this.exportModal.open(),
      onOpenFile:    () => this.openFilePicker(),
      onModeRequest: (mode) => this.requestMode(mode),
    })

    this.trackPanel = new TrackPanel(overlay, this.renderer, () => this.openFilePicker())

    this.exportModal = new ExportModal(overlay)
    this.exportModal.onStart  = (fps) => void this.startExport(fps)
    this.exportModal.onCancel = () => this.cancelExport()

    this.kbdResizer = new KeyboardResizer(
      overlay,
      () => this.renderer.currentKeyboardHeight,
      (px) => this.renderer.setKeyboardHeight(px),
    )
    this.kbdResizer.restoreSaved()

    this.applyTheme(THEMES[this.themeIndex]!)
    this.controls.updateMidiStatus(this.midiInput.status.value, '')
    this.dropzone.updateMidiStatus(this.midiInput.status.value, '')

    this.clock.subscribe((t) => appState.setCurrentTime(t))

    appState.status.subscribe((status) => {
      if (appState.mode.value === 'file' && status === 'playing') {
        void this.synth.play(this.clock.currentTime)
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
    this.midiInput.noteOn.subscribe((evt) => { if (evt) this.handleLiveNoteOn(evt) })
    this.midiInput.noteOff.subscribe((evt) => { if (evt) this.handleLiveNoteOff(evt) })
    this.keyboardInput.noteOn.subscribe((evt) => { if (evt) this.handleLiveNoteOn(evt) })
    this.keyboardInput.noteOff.subscribe((evt) => { if (evt) this.handleLiveNoteOff(evt) })
    this.keyboardInput.octave.subscribe((o) => this.controls.updateOctave(o))

    // Mouse/touch on the on-screen keyboard
    canvas.addEventListener('pointerdown', this.onCanvasPointerDown)
    canvas.addEventListener('pointerup', this.onCanvasPointerUp)
    canvas.addEventListener('pointercancel', this.onCanvasPointerUp)
    canvas.addEventListener('pointerleave', this.onCanvasPointerUp)

    // Update MIDI button whenever either status or device name changes.
    // Reading the *other* signal's current value avoids a stale-name flash.
    this.midiInput.status.subscribe((status) => {
      this.controls.updateMidiStatus(status, this.midiInput.deviceName.value)
      this.dropzone.updateMidiStatus(status, this.midiInput.deviceName.value)
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

  private handleLiveNoteOn(evt: MidiNoteEvent): void {
    if (appState.status.value === 'exporting') return
    if (appState.mode.value === 'file') return
    if (appState.mode.value === 'home') this.enterLiveMode(false)

    this.synth.liveNoteOn(evt.pitch, evt.velocity)
    this.liveNotes.press(evt.pitch, evt.velocity, evt.clockTime)
    this.renderer.burstParticleAt(evt.pitch)

    const s = appState.status.value
    if (s === 'idle' || s === 'ready' || s === 'paused') {
      this.clock.play()
      appState.startPlaying()
    }
  }

  private handleLiveNoteOff(evt: MidiNoteEvent): void {
    if (appState.mode.value !== 'live') return
    this.synth.liveNoteOff(evt.pitch)
    this.liveNotes.release(evt.pitch, evt.clockTime)
  }

  private onCanvasPointerDown = (e: PointerEvent): void => {
    if (appState.mode.value === 'file') return
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
    this.handleLiveNoteOn({ pitch, velocity: 0.8, clockTime: this.clock.currentTime })
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
      document.title = `${midi.name} · Piano Roll`
      this.dropzone.hide()
    } catch (err) {
      console.error('Failed to load MIDI:', err)
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
  }

  private async startExport(fps: number): Promise<void> {
    const midi = appState.loadedMidi.value
    if (!midi || appState.mode.value !== 'file') return

    const wasPlaying = appState.status.value === 'playing'
    this.clock.pause()
    this.liveNotes.reset()
    this.synth.liveReleaseAll()
    appState.beginExport()
    this.synth.pause()
    this.renderer.pauseAutoRender()

    const exporter = new VideoExporter(this.renderer.canvas)
    this.currentExporter = exporter

    try {
      await exporter.export({
        fps,
        duration: midi.duration,
        onSeek:        (t) => this.clock.seek(t),
        onRenderFrame: (t, dt) => this.renderer.renderManualFrame(t, dt),
        onProgress:    (stage, pct) => this.exportModal.updateProgress(stage, pct),
      })
      this.exportModal.close()
      this.showSuccess('↓ pianoroll.mp4 ready')
    } catch (err) {
      const isCancel = err instanceof DOMException && err.name === 'AbortError'
      if (!isCancel) {
        console.error('Export failed:', err)
        this.showError((err as Error).message || 'Export failed — check console for details.')
      }
      this.exportModal.close()
    } finally {
      this.currentExporter = null
      this.renderer.resumeAutoRender()
      this.clock.seek(0)
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

  private openFilePicker(): void {
    this.dropzone.openFilePicker()
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
    document.title = 'Piano Roll'
  }

  private enterLiveMode(primeAudio = true): void {
    this.resetInteractionState()
    appState.enterLive()
    this.renderer.clearMidi()
    this.trackPanel.close()
    this.dropzone.hide()
    this.keyboardInput.enable()
    document.title = 'Piano Roll · Live'
    if (primeAudio) this.primeInteractiveAudio()
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
    this.keyboardInput.disable()
    document.title = `${midi.name} · Piano Roll`
  }

  private resetInteractionState(): void {
    this.clock.pause()
    this.clock.seek(0)
    this.synth.pause()
    this.synth.seek(0)
    this.liveNotes.reset()
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
    this.renderer.canvas.removeEventListener('pointerup', this.onCanvasPointerUp)
    this.renderer.canvas.removeEventListener('pointercancel', this.onCanvasPointerUp)
    this.renderer.canvas.removeEventListener('pointerleave', this.onCanvasPointerUp)
    this.dropzone.dispose()
    this.controls.dispose()
    this.kbdResizer.dispose()
    this.midiInput.dispose()
    this.keyboardInput.dispose()
    this.clock.dispose()
    this.renderer.destroy()
    this.synth.dispose()
  }
}
