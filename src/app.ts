import { parseMidiFile } from './core/midi/parser'
import { MasterClock } from './core/clock/MasterClock'
import { PianoRollRenderer } from './renderer/PianoRollRenderer'
import { SynthEngine } from './audio/SynthEngine'
import { appState } from './store/state'
import { DropZone } from './ui/DropZone'
import { Controls } from './ui/Controls'
import { TrackList } from './ui/TrackList'
import { VideoExporter } from './export/VideoExporter'
import { THEMES, darkTheme } from './renderer/theme'

export class App {
  private clock    = new MasterClock()
  private renderer = new PianoRollRenderer()
  private synth    = new SynthEngine()
  private dropzone!: DropZone
  private controls!: Controls
  private trackList!: TrackList
  private loadingEl: HTMLElement | null = null

  private themeIndex = 0

  async init(): Promise<void> {
    const canvas  = document.querySelector<HTMLCanvasElement>('#pianoroll')!
    const overlay = document.querySelector<HTMLElement>('#ui-overlay')!

    await this.renderer.init(canvas)
    this.renderer.attachClock(this.clock)

    this.dropzone = new DropZone(overlay, (file) => void this.loadMidi(file))

    this.controls = new Controls({
      container: overlay,
      state: appState,
      clock: this.clock,
      onSeek: (t) => this.synth.seek(t),
      onLoadNew: () => this.showDropZone(),
      onZoom: (pps) => this.renderer.setZoom(pps),
      onThemeCycle: () => this.cycleTheme(),
      onExport: () => void this.startExport(),
    })

    this.trackList = new TrackList(overlay, this.renderer)

    // Initialize theme dot to match default theme
    this.controls.updateThemeDot(darkTheme.uiAccentCSS)

    this.clock.subscribe((t) => appState.currentTime.set(t))

    appState.status.subscribe((status) => {
      if (status === 'playing') void this.synth.play(this.clock.currentTime)
      else if (status === 'paused') this.synth.pause()
    })

    appState.volume.subscribe((v) => this.synth.setVolume(v))
    appState.speed.subscribe((s) => {
      this.clock.speed = s
      this.synth.setSpeed(s)
    })

    this.dropzone.show()
    this.controls.hide()
  }

  private async loadMidi(file: File): Promise<void> {
    this.clock.pause()
    this.clock.seek(0)
    appState.status.set('loading')
    this.showLoading()

    try {
      const midi = await parseMidiFile(file)
      appState.midi.set(midi)
      appState.duration.set(midi.duration)

      void this.synth.load(midi)
      this.renderer.loadMidi(midi)
      this.trackList.render(midi)
      this.controls.setFileName(midi.name)

      appState.status.set('ready')
      this.dropzone.hide()
      this.controls.show()
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

  private async startExport(): Promise<void> {
    const midi = appState.midi.value
    if (!midi) return

    const wasPlaying = appState.status.value === 'playing'
    this.clock.pause()
    appState.status.set('exporting')
    this.synth.pause()

    const overlay = this.showExportOverlay()

    try {
      this.renderer.pauseAutoRender()

      const exporter = new VideoExporter(this.renderer.canvas)
      await exporter.export({
        duration: midi.duration,
        onSeek: (t) => this.clock.seek(t),
        onRenderFrame: (t, dt) => this.renderer.renderManualFrame(t, dt),
        onProgress: (stage, pct) => {
          this.updateExportOverlay(overlay, stage, pct)
        },
      })
    } catch (err) {
      console.error('Export failed:', err)
      this.showError('Export failed — check console for details.')
    } finally {
      this.renderer.resumeAutoRender()
      this.clock.seek(0)
      overlay.remove()
      appState.status.set('ready')
      if (wasPlaying) {
        this.clock.play()
        appState.status.set('playing')
      }
    }
  }

  private showDropZone(): void {
    this.clock.pause()
    appState.status.set('idle')
    this.controls.hide()
    this.trackList.hide()
    this.dropzone.show()
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

  private showExportOverlay(): HTMLElement {
    const el = document.createElement('div')
    el.id = 'export-overlay'
    el.innerHTML = `
      <div class="export-inner">
        <div class="export-spinner"></div>
        <div class="export-stage">Capturing…</div>
        <div class="export-progress-wrap">
          <div class="export-progress-bar" style="width:0%"></div>
        </div>
        <div class="export-pct">0%</div>
      </div>
    `
    document.querySelector('#ui-overlay')!.appendChild(el)
    return el
  }

  private updateExportOverlay(el: HTMLElement, stage: string, pct: number): void {
    const bar = el.querySelector<HTMLElement>('.export-progress-bar')
    const stageEl = el.querySelector<HTMLElement>('.export-stage')
    const pctEl = el.querySelector<HTMLElement>('.export-pct')
    if (bar) bar.style.width = `${Math.round(pct * 100)}%`
    if (stageEl) stageEl.textContent = `${stage}…`
    if (pctEl) pctEl.textContent = `${Math.round(pct * 100)}%`
  }

  private showError(message: string): void {
    const el = document.createElement('div')
    el.className = 'toast'
    el.textContent = message
    document.body.appendChild(el)
    setTimeout(() => el.remove(), 4000)
  }

  dispose(): void {
    this.clock.dispose()
    this.renderer.destroy()
    this.synth.dispose()
  }
}
