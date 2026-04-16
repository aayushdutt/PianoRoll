export class ExportModal {
  private el: HTMLElement
  private settingsPhase!: HTMLElement
  private progressPhase!: HTMLElement
  private progressBar!: HTMLElement
  private stageEl!: HTMLElement
  private pctEl!: HTMLElement
  private phase: 'settings' | 'progress' = 'settings'
  private selectedFps = 30

  onStart?: (fps: number) => void
  onCancel?: () => void

  constructor(container: HTMLElement) {
    this.el = document.createElement('div')
    this.el.id = 'export-modal'
    this.el.innerHTML = `
      <div class="export-card">

        <div class="export-phase" id="ep-settings">
          <div class="export-card-icon">${ICON_RECORD}</div>
          <h2 class="export-card-title">Record MP4</h2>
          <p class="export-card-sub">Captures the full visualization — audio not included</p>
          <div class="export-field">
            <span class="export-field-label">Frame rate</span>
            <div class="fps-group" id="fps-group">
              <button class="fps-btn" data-fps="24">24 fps</button>
              <button class="fps-btn fps-btn--on" data-fps="30">30 fps</button>
              <button class="fps-btn" data-fps="60">60 fps</button>
            </div>
          </div>
          <div class="export-actions">
            <button class="modal-btn" id="ep-cancel-settings">Cancel</button>
            <button class="modal-btn modal-btn--accent" id="ep-start">
              ${ICON_RECORD_SM} Start recording
            </button>
          </div>
        </div>

        <div class="export-phase hidden" id="ep-progress">
          <div class="export-spinner"></div>
          <div class="export-stage" id="ep-stage">Capturing…</div>
          <div class="export-progress-wrap">
            <div class="export-progress-bar" id="ep-bar"></div>
          </div>
          <div class="export-pct" id="ep-pct">0%</div>
          <button class="modal-btn" id="ep-cancel-progress">Cancel</button>
        </div>

      </div>
    `
    container.appendChild(this.el)
    this.bindEvents()
  }

  private bindEvents(): void {
    this.settingsPhase = this.el.querySelector('#ep-settings')!
    this.progressPhase = this.el.querySelector('#ep-progress')!
    this.progressBar   = this.el.querySelector('#ep-bar')!
    this.stageEl       = this.el.querySelector('#ep-stage')!
    this.pctEl         = this.el.querySelector('#ep-pct')!

    // FPS selector
    this.el.querySelectorAll<HTMLButtonElement>('.fps-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this.el.querySelectorAll('.fps-btn').forEach(b => b.classList.remove('fps-btn--on'))
        btn.classList.add('fps-btn--on')
        this.selectedFps = parseInt(btn.dataset['fps']!, 10)
      })
    })

    this.el.querySelector('#ep-start')!.addEventListener('click', () => {
      this.showPhase('progress')
      this.onStart?.(this.selectedFps)
    })

    this.el.querySelector('#ep-cancel-settings')!.addEventListener('click', () => this.close())
    this.el.querySelector('#ep-cancel-progress')!.addEventListener('click', () => this.onCancel?.())

    // Click backdrop (settings phase only) → close
    this.el.addEventListener('click', (e) => {
      if (e.target === this.el && this.phase === 'settings') this.close()
    })
  }

  open(): void {
    this.showPhase('settings')
    // Reset progress for next time
    this.progressBar.style.width = '0%'
    this.pctEl.textContent = '0%'
    this.stageEl.textContent = 'Capturing…'
    this.el.classList.add('open')
  }

  close(): void {
    this.el.classList.remove('open')
  }

  updateProgress(stage: string, pct: number): void {
    this.progressBar.style.width = `${Math.round(pct * 100)}%`
    this.stageEl.textContent = `${stage}…`
    this.pctEl.textContent = `${Math.round(pct * 100)}%`
  }

  private showPhase(phase: 'settings' | 'progress'): void {
    this.phase = phase
    this.settingsPhase.classList.toggle('hidden', phase !== 'settings')
    this.progressPhase.classList.toggle('hidden', phase !== 'progress')
  }
}

const ICON_RECORD = `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <polygon points="23 7 16 12 23 17 23 7"/>
  <rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
</svg>`

const ICON_RECORD_SM = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <polygon points="23 7 16 12 23 17 23 7"/>
  <rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
</svg>`
