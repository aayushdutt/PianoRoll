type DropHandler = (file: File) => void

function isMidiFile(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.endsWith('.mid') || lower.endsWith('.midi')
}

export class DropZone {
  private el: HTMLElement
  private dragDepth = 0

  constructor(container: HTMLElement, private onDrop: DropHandler) {
    this.el = this.build()
    container.appendChild(this.el)
    this.bindEvents()
  }

  private build(): HTMLElement {
    const el = document.createElement('div')
    el.id = 'dropzone'
    el.innerHTML = `
      <div class="dropzone-card">
        <div class="dropzone-icon">
          <svg width="52" height="52" viewBox="0 0 52 52" fill="none">
            <rect x="3"  y="16" width="10" height="32" rx="3.5" fill="currentColor"/>
            <rect x="21" y="4"  width="10" height="44" rx="3.5" fill="currentColor"/>
            <rect x="39" y="10" width="10" height="28" rx="3.5" fill="currentColor" opacity="0.55"/>
            <rect x="0"  y="50" width="52" height="2"  rx="1"   fill="currentColor" opacity="0.30"/>
          </svg>
        </div>
        <p class="dropzone-title">Drop a MIDI file</p>
        <p class="dropzone-sub">or <label class="dropzone-browse" for="midi-input">browse your files</label></p>
        <div class="dropzone-hint">
          <kbd>Space</kbd> play &nbsp;·&nbsp; <kbd>←</kbd><kbd>→</kbd> skip 10s
        </div>
        <input type="file" id="midi-input" accept=".mid,.midi" style="display:none" />
      </div>
    `
    return el
  }

  private bindEvents(): void {
    const input = this.el.querySelector<HTMLInputElement>('#midi-input')!

    input.addEventListener('change', () => {
      const file = input.files?.[0]
      if (file) this.onDrop(file)
      // Reset so the same file can be re-dropped
      input.value = ''
    })

    this.el.addEventListener('dragenter', (e) => {
      e.preventDefault()
      this.dragDepth++
      this.el.classList.add('drag-over')
    })

    this.el.addEventListener('dragleave', () => {
      this.dragDepth--
      if (this.dragDepth === 0) this.el.classList.remove('drag-over')
    })

    this.el.addEventListener('dragover', (e) => { e.preventDefault() })

    this.el.addEventListener('drop', (e) => {
      e.preventDefault()
      this.dragDepth = 0
      this.el.classList.remove('drag-over')
      const file = e.dataTransfer?.files[0]
      if (file && isMidiFile(file.name)) this.onDrop(file)
    })

    // Click anywhere on the card triggers browse (except the label itself which already does)
    this.el.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.dropzone-browse')) return
      input.click()
    })
  }

  show(): void { this.el.classList.remove('hidden') }
  hide(): void { this.el.classList.add('hidden') }
}
