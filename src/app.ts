import { parseMidiFile } from './core/midi/parser'
import { MasterClock } from './core/clock/MasterClock'
import { PianoRollRenderer } from './renderer/PianoRollRenderer'
import { SynthEngine } from './audio/SynthEngine'
import { appState } from './store/state'
import { DropZone } from './ui/DropZone'
import { Controls } from './ui/Controls'
import { TrackPanel } from './ui/TrackPanel'
import { ExportModal } from './ui/ExportModal'
import { VideoExporter } from './export/VideoExporter'
import { THEMES } from './renderer/theme'
import { MidiInputManager } from './midi/MidiInputManager'
import { LiveNoteStore } from './midi/LiveNoteStore'

export class App {
  private clock         = new MasterClock()
  private renderer      = new PianoRollRenderer()
  private synth         = new SynthEngine()
  private midiInput!:   MidiInputManager
  private liveNotes     = new LiveNoteStore()
  private dropzone!:    DropZone
  private controls!:    Controls
  private trackPanel!:  TrackPanel
  private exportModal!: ExportModal
  private loadingEl:    HTMLElement | null = null
  private currentExporter: VideoExporter | null = null

  private themeIndex = 0
  private onVisibilityChange = (): void => { if (document.hidden) this.releaseAllLiveNotes() }
  private onWindowBlur = (): void => this.releaseAllLiveNotes()

  async init(): Promise<void> {
    const canvas  = document.querySelector<HTMLCanvasElement>('#pianoroll')!
    const overlay = document.querySelector<HTMLElement>('#ui-overlay')!

    await this.renderer.init(canvas)
    this.renderer.attachClock(this.clock)
    this.renderer.setLiveNoteStore(this.liveNotes)

    this.midiInput = new MidiInputManager(this.clock)

    this.dropzone = new DropZone(
      overlay,
      (file) => void this.loadMidi(file),
      () => this.enterLiveMode(),
    )

    this.controls = new Controls({
      container:     overlay,
      state:         appState,
      clock:         this.clock,
      onSeek:        (t) => { this.synth.seek(t); this.liveNotes.releaseAll() },
      onZoom:        (pps) => this.renderer.setZoom(pps),
      onThemeCycle:  () => this.cycleTheme(),
      onMidiConnect: () => void this.connectMidi(),
      onOpenTracks:  () => this.trackPanel.toggle(),
      onRecord:      () => this.exportModal.open(),
    })

    this.trackPanel = new TrackPanel(overlay, this.renderer, () => this.showDropZone())

    this.exportModal = new ExportModal(overlay)
    this.exportModal.onStart  = (fps) => void this.startExport(fps)
    this.exportModal.onCancel = () => this.cancelExport()

    // Initialize theme dot and MIDI button to reflect initial state
    this.controls.updateThemeDot(THEMES[0]!.uiAccentCSS)
    this.controls.updateMidiStatus(this.midiInput.status.value, '')

    this.clock.subscribe((t) => appState.currentTime.set(t))

    appState.status.subscribe((status) => {
      if (status === 'playing') {
        void this.synth.play(this.clock.currentTime)
      } else if (status === 'paused') {
        this.synth.pause()
        this.liveNotes.releaseAll()
        this.synth.liveReleaseAll()
      }
    })

    appState.volume.subscribe((v) => this.synth.setVolume(v))
    appState.speed.subscribe((s) => {
      this.clock.speed = s
      this.synth.setSpeed(s)
    })

    // ── MIDI keyboard input wiring ────────────────────────────────────────
    this.midiInput.noteOn.subscribe((evt) => {
      if (!evt) return
      if (appState.status.value === 'exporting') return

      this.synth.liveNoteOn(evt.pitch, evt.velocity)
      this.liveNotes.press(evt.pitch, evt.velocity, evt.clockTime)
      this.renderer.burstParticleAt(evt.pitch)

      // Auto-start clock on first note if idle/ready/paused
      const s = appState.status.value
      if (s === 'idle' || s === 'ready' || s === 'paused') {
        this.clock.play()
        appState.status.set('playing')
      }
    })

    this.midiInput.noteOff.subscribe((evt) => {
      if (!evt) return
      this.synth.liveNoteOff(evt.pitch)
      this.liveNotes.release(evt.pitch)
    })

    // Update MIDI button whenever either status or device name changes.
    // Reading the *other* signal's current value avoids a stale-name flash.
    this.midiInput.status.subscribe((status) => {
      this.controls.updateMidiStatus(status, this.midiInput.deviceName.value)
    })
    this.midiInput.deviceName.subscribe((name) => {
      this.controls.updateMidiStatus(this.midiInput.status.value, name)
    })

    // Release all held notes when the page loses focus (prevents stuck notes)
    document.addEventListener('visibilitychange', this.onVisibilityChange)
    window.addEventListener('blur', this.onWindowBlur)

    this.dropzone.show()
  }

  private releaseAllLiveNotes(): void {
    this.liveNotes.releaseAll()
    this.synth.liveReleaseAll()
  }

  private async connectMidi(): Promise<void> {
    await this.synth.ensureInstrument()
    await this.midiInput.requestAccess()
  }

  private async loadMidi(file: File): Promise<void> {
    this.clock.pause()
    this.clock.seek(0)
    this.liveNotes.reset()
    this.synth.liveReleaseAll()
    appState.status.set('loading')
    this.showLoading()

    try {
      const midi = await parseMidiFile(file)
      appState.midi.set(midi)
      appState.duration.set(midi.duration)

      this.synth.load(midi).catch((err) => console.error('SynthEngine.load failed:', err))
      this.renderer.loadMidi(midi)
      this.trackPanel.render(midi)
      this.controls.setFileName(midi.name)
      document.title = `${midi.name} · Piano Roll`

      appState.status.set('ready')   // triggers Controls subscriber → shows HUD
      this.dropzone.hide()
    } catch (err) {
      console.error('Failed to load MIDI:', err)
      appState.status.set('idle')
      this.showError('Could not read that file — make sure it\'s a valid MIDI.')
    } finally {
      this.hideLoading()
    }
  }

  private cycleTheme(): void {
    this.themeIndex = (this.themeIndex + 1) % THEMES.length
    const theme = THEMES[this.themeIndex]!
    this.renderer.setTheme(theme)
    this.controls.updateThemeDot(theme.uiAccentCSS)
    document.documentElement.style.setProperty('--accent', theme.uiAccentCSS)
    document.documentElement.style.setProperty('--accent-soft', `${theme.uiAccentCSS}2e`)
    document.documentElement.style.setProperty('--accent-glow', `${theme.uiAccentCSS}66`)
  }

  private async startExport(fps: number): Promise<void> {
    const midi = appState.midi.value
    if (!midi) return

    const wasPlaying = appState.status.value === 'playing'
    this.clock.pause()
    this.releaseAllLiveNotes()
    appState.status.set('exporting')
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
      appState.status.set('ready')
      if (wasPlaying) {
        this.clock.play()
        appState.status.set('playing')
      }
    }
  }

  private cancelExport(): void {
    this.currentExporter?.cancel()
  }

  private showDropZone(): void {
    this.clock.pause()
    appState.status.set('idle')   // triggers Controls subscriber → hides HUD
    this.trackPanel.close()
    this.dropzone.show()
    document.title = 'Piano Roll'
  }

  private enterLiveMode(): void {
    this.dropzone.hide()
    this.controls.setLiveTitle()
    appState.status.set('ready')  // triggers Controls subscriber → shows HUD
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
    this.controls.dispose()
    this.midiInput.dispose()
    this.clock.dispose()
    this.renderer.destroy()
    this.synth.dispose()
  }
}
