type DropHandler = (file: File) => void

function isMidiFile(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.endsWith('.mid') || lower.endsWith('.midi')
}

export class DropZone {
  private el: HTMLElement
  private dragDepth = 0
  private docDragOver = (e: DragEvent): void => { e.preventDefault() }
  private docDrop = (e: DragEvent): void => {
    e.preventDefault()
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
        <div class="dropzone-or"><span>or</span></div>
        <button class="dropzone-live-btn" id="dropzone-live" type="button">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="2" y="4" width="20" height="16" rx="2"/>
            <line x1="2" y1="14" x2="22" y2="14"/>
            <line x1="7" y1="4" x2="7" y2="14"/>
            <line x1="12" y1="4" x2="12" y2="14"/>
            <line x1="17" y1="4" x2="17" y2="14"/>
            <rect x="5" y="4" width="3" height="6" rx="1" fill="currentColor" stroke="none"/>
            <rect x="10" y="4" width="3" height="6" rx="1" fill="currentColor" stroke="none"/>
            <rect x="15" y="4" width="3" height="6" rx="1" fill="currentColor" stroke="none"/>
          </svg>
          Play live with MIDI keyboard
        </button>
        <input type="file" id="midi-input" accept=".mid,.midi" style="display:none" />
      </div>
    `
    return el
  }

  private bindEvents(): void {
    const input = this.el.querySelector<HTMLInputElement>('#midi-input')!

    input.addEventListener('change', () => {
      const file = input.files?.[0]
      if (file && isMidiFile(file.name)) this.onDrop(file)
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
      e.stopPropagation()  // prevent document handler from double-firing
      this.dragDepth = 0
      this.el.classList.remove('drag-over')
      const file = e.dataTransfer?.files[0]
      if (file && isMidiFile(file.name)) this.onDrop(file)
    })

    // Live mode button
    const liveBtn = this.el.querySelector<HTMLButtonElement>('#dropzone-live')
    if (liveBtn && this.onLiveMode) {
      liveBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        this.onLiveMode!()
      })
      liveBtn.style.display = ''
    } else if (liveBtn) {
      liveBtn.style.display = 'none'
    }

    // Click anywhere on the card triggers browse (except interactive children)
    this.el.addEventListener('click', (e) => {
      const target = e.target as HTMLElement
      if (target.closest('.dropzone-browse')) return
      if (target.closest('#dropzone-live')) return
      input.click()
    })

    // ── Document-level drag-drop ──────────────────────────────────────────
    // Catches drops anywhere on the canvas when the dropzone is hidden
    // (i.e., a file is already loaded and the user drags a new one in).
    document.addEventListener('dragover', this.docDragOver)
    document.addEventListener('drop', this.docDrop)
  }

  show(): void { this.el.classList.remove('dz--hidden') }
  hide(): void { this.el.classList.add('dz--hidden') }

  dispose(): void {
    document.removeEventListener('dragover', this.docDragOver)
    document.removeEventListener('drop', this.docDrop)
  }
}
