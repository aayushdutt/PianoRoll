import type { MidiDeviceStatus } from '../midi/MidiInputManager'
import { icons } from './icons'
import { SamplesGrid } from './SamplesGrid'

type DropHandler = (file: File) => void
type SampleHandler = (sampleId: string) => void

function isMidiFile(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.endsWith('.mid') || lower.endsWith('.midi')
}

export class DropZone {
  private el: HTMLElement
  private dragDepth = 0
  private input!: HTMLInputElement
  private statusEl!: HTMLElement
  private coarsePointerMq: MediaQueryList | null = null
  private onCoarseChange: ((e: MediaQueryListEvent) => void) | null = null

  private docDragEnter = (e: DragEvent): void => {
    if (!hasFiles(e)) return
    this.dragDepth++
    this.el.classList.add('drag-over')
  }
  private docDragLeave = (e: DragEvent): void => {
    if (!hasFiles(e)) return
    this.dragDepth = Math.max(0, this.dragDepth - 1)
    if (this.dragDepth === 0) this.el.classList.remove('drag-over')
  }
  private docDragOver = (e: DragEvent): void => {
    e.preventDefault()
  }
  private docDrop = (e: DragEvent): void => {
    e.preventDefault()
    this.dragDepth = 0
    this.el.classList.remove('drag-over')
    const file = e.dataTransfer?.files[0]
    if (file && isMidiFile(file.name)) this.onDrop(file)
  }

  private samples: SamplesGrid

  constructor(
    container: HTMLElement,
    private onDrop: DropHandler,
    private onLiveMode?: () => void,
    private onSample?: SampleHandler,
  ) {
    this.samples = new SamplesGrid()
    this.samples.onSelect = (id) => this.onSample?.(id)
    this.el = this.build()
    container.appendChild(this.el)
    this.bindEvents()
  }

  private build(): HTMLElement {
    const el = document.createElement('div')
    el.id = 'dropzone'
    el.innerHTML = `
      <div class="home-card">
        <span class="home-kicker">midee · MIDI visualizer</span>
        <h1 class="home-title">Play <em>notes</em>,<br/>see them bloom.</h1>
        <p class="home-sub">Open a MIDI file to animate it, or go live and play with your keyboard, mouse, or a MIDI controller.</p>

        <div class="home-actions">
          <button class="home-primary-btn" id="home-open" type="button">
            ${icons.upload(13)}
            <span>Open MIDI</span>
          </button>
          <button class="home-secondary-btn" id="home-live" type="button">
            ${icons.midi(13)}
            <span>Play live</span>
          </button>
        </div>

        <div class="home-samples">
          <div class="home-samples-label">or explore a sample</div>
          <div class="home-samples-mount" id="home-samples-mount"></div>
        </div>

        <div class="home-footnotes">
          <div class="home-midi-status" id="home-midi-status">Looking for MIDI…</div>
          <div class="home-drop-hint">Drop <code>.mid</code> anywhere · play with <kbd>A</kbd><kbd>S</kbd><kbd>D</kbd>…</div>
        </div>
        <nav class="home-meta-links" aria-label="midee links">
          <a href="/blog/" class="home-meta-link" aria-label="Read the blog" title="Blog">
            ${icons.blog()}
          </a>
          <a href="https://github.com/aayushdutt/midee" class="home-meta-link" aria-label="Source on GitHub" title="GitHub" target="_blank" rel="noopener noreferrer">
            ${icons.github()}
          </a>
          <a href="https://discord.gg/7As2NHHd" class="home-meta-link" aria-label="Join the Discord community" title="Discord" target="_blank" rel="noopener noreferrer">
            ${icons.discord()}
          </a>
        </nav>
        <input type="file" id="midi-input" accept=".mid,.midi" style="display:none" />
      </div>
    `
    this.input = el.querySelector<HTMLInputElement>('#midi-input')!
    this.statusEl = el.querySelector<HTMLElement>('#home-midi-status')!
    el.querySelector<HTMLElement>('#home-samples-mount')!.appendChild(this.samples.root)
    return el
  }

  private bindEvents(): void {
    this.input.addEventListener('change', () => {
      const file = this.input.files?.[0]
      if (file && isMidiFile(file.name)) this.onDrop(file)
      this.input.value = ''
    })

    this.el.querySelector<HTMLButtonElement>('#home-open')!.addEventListener('click', () => {
      this.openFilePicker()
    })

    const liveBtn = this.el.querySelector<HTMLButtonElement>('#home-live')!
    if (this.onLiveMode) {
      liveBtn.addEventListener('click', () => this.onLiveMode?.())
    } else {
      liveBtn.classList.add('hidden')
    }

    document.addEventListener('dragenter', this.docDragEnter)
    document.addEventListener('dragleave', this.docDragLeave)
    document.addEventListener('dragover', this.docDragOver)
    document.addEventListener('drop', this.docDrop)

    // Mirror coarse-pointer state onto the dropzone root so the CSS agent can
    // swap in a touch-optimised layout without changing our markup.
    if (typeof window !== 'undefined' && window.matchMedia) {
      this.coarsePointerMq = window.matchMedia('(pointer: coarse)')
      this.el.classList.toggle('dropzone--touch', this.coarsePointerMq.matches)
      this.onCoarseChange = (e) => this.el.classList.toggle('dropzone--touch', e.matches)
      this.coarsePointerMq.addEventListener('change', this.onCoarseChange)
    }
  }

  updateMidiStatus(status: MidiDeviceStatus, deviceName: string): void {
    this.statusEl.dataset['midiStatus'] = status
    this.statusEl.textContent = getHomeMidiStatus(status, deviceName)
  }

  openFilePicker(): void {
    this.input.click()
  }

  show(): void {
    this.el.classList.remove('dz--hidden')
  }

  hide(): void {
    this.el.classList.add('dz--hidden')
  }

  dispose(): void {
    document.removeEventListener('dragenter', this.docDragEnter)
    document.removeEventListener('dragleave', this.docDragLeave)
    document.removeEventListener('dragover', this.docDragOver)
    document.removeEventListener('drop', this.docDrop)
    if (this.coarsePointerMq && this.onCoarseChange) {
      this.coarsePointerMq.removeEventListener('change', this.onCoarseChange)
    }
  }
}

function hasFiles(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes('Files')
}

function getHomeMidiStatus(status: MidiDeviceStatus, deviceName: string): string {
  if (status === 'connected') return deviceName || 'MIDI device ready'
  if (status === 'blocked') return 'Enable MIDI from the top bar'
  if (status === 'unavailable') return 'Web MIDI unavailable in this browser'
  return 'No MIDI device — keyboard & mouse work too'
}
