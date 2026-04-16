import type { MidiDeviceStatus } from '../midi/MidiInputManager'

type DropHandler = (file: File) => void

function isMidiFile(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.endsWith('.mid') || lower.endsWith('.midi')
}

export class DropZone {
  private el: HTMLElement
  private dragDepth = 0
  private input!: HTMLInputElement
  private statusEl!: HTMLElement

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
  private docDragOver = (e: DragEvent): void => { e.preventDefault() }
  private docDrop = (e: DragEvent): void => {
    e.preventDefault()
    this.dragDepth = 0
    this.el.classList.remove('drag-over')
    const file = e.dataTransfer?.files[0]
    if (file && isMidiFile(file.name)) this.onDrop(file)
  }

  constructor(
    container: HTMLElement,
    private onDrop: DropHandler,
    private onLiveMode?: () => void,
  ) {
    this.el = this.build()
    container.appendChild(this.el)
    this.bindEvents()
  }

  private build(): HTMLElement {
    const el = document.createElement('div')
    el.id = 'dropzone'
    el.innerHTML = `
      <div class="home-card">
        <span class="home-kicker">Piano roll · visualizer</span>
        <h1 class="home-title">Play <em>notes</em>,<br/>see them bloom.</h1>
        <p class="home-sub">Open a MIDI file to animate it, or go live and play with your keyboard, mouse, or a MIDI controller.</p>

        <div class="home-actions">
          <button class="home-primary-btn" id="home-open" type="button">
            ${ICON_UPLOAD}
            <span>Open MIDI</span>
          </button>
          <button class="home-secondary-btn" id="home-live" type="button">
            ${ICON_MIDI}
            <span>Play live</span>
          </button>
        </div>

        <div class="home-footnotes">
          <div class="home-midi-status" id="home-midi-status">Looking for MIDI…</div>
          <div class="home-drop-hint">Drop <code>.mid</code> anywhere · play with <kbd>A</kbd><kbd>S</kbd><kbd>D</kbd>…</div>
        </div>
        <input type="file" id="midi-input" accept=".mid,.midi" style="display:none" />
      </div>
    `
    this.input = el.querySelector<HTMLInputElement>('#midi-input')!
    this.statusEl = el.querySelector<HTMLElement>('#home-midi-status')!
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

const ICON_UPLOAD = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round">
  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
  <polyline points="17 8 12 3 7 8"/>
  <line x1="12" y1="3" x2="12" y2="15"/>
</svg>`

const ICON_MIDI = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <rect x="2" y="4" width="20" height="16" rx="2"/>
  <line x1="2" y1="14" x2="22" y2="14"/>
  <line x1="7" y1="4" x2="7" y2="14"/>
  <line x1="12" y1="4" x2="12" y2="14"/>
  <line x1="17" y1="4" x2="17" y2="14"/>
  <rect x="5" y="4" width="3" height="6" rx="1" fill="currentColor" stroke="none"/>
  <rect x="10" y="4" width="3" height="6" rx="1" fill="currentColor" stroke="none"/>
  <rect x="15" y="4" width="3" height="6" rx="1" fill="currentColor" stroke="none"/>
</svg>`
