import type { MidiFile } from '../core/midi/types'
import type { PianoRollRenderer } from '../renderer/PianoRollRenderer'
import { escHtml, hexToCSS } from './utils'

export class TrackPanel {
  private backdrop: HTMLElement
  private panel: HTMLElement
  private itemsEl: HTMLElement
  private isOpen = false

  constructor(
    container: HTMLElement,
    private renderer: PianoRollRenderer,
    private onLoadNew: () => void,
  ) {
    this.backdrop = document.createElement('div')
    this.backdrop.className = 'panel-backdrop'
    this.backdrop.addEventListener('click', () => this.close())

    this.panel = document.createElement('div')
    this.panel.id = 'track-panel'
    this.panel.innerHTML = `
      <div class="panel-header">
        <span class="panel-label">Tracks</span>
        <button class="panel-close-btn" aria-label="Close">${ICON_CLOSE}</button>
      </div>
      <div class="panel-items" id="panel-items"></div>
      <div class="panel-footer">
        <button class="panel-load-btn" id="panel-load-new">
          ${ICON_UPLOAD}
          Load new file
        </button>
      </div>
    `
    this.itemsEl = this.panel.querySelector<HTMLElement>('#panel-items')!

    this.panel.querySelector('.panel-close-btn')!.addEventListener('click', () => this.close())
    this.panel.querySelector('#panel-load-new')!.addEventListener('click', () => {
      this.close()
      this.onLoadNew()
    })

    container.appendChild(this.backdrop)
    container.appendChild(this.panel)
  }

  render(midi: MidiFile): void {
    this.itemsEl.innerHTML = midi.tracks.map(t => `
      <label class="track-item">
        <span class="track-swatch" style="background:${hexToCSS(t.color)}"></span>
        <span class="track-info">
          <span class="track-name">${escHtml(t.name)}</span>
          <span class="track-meta">ch ${t.channel + 1} · ${t.notes.length} notes</span>
        </span>
        <span class="track-toggle-wrap" style="--track-color:${hexToCSS(t.color)}">
          <input type="checkbox" class="track-toggle" data-id="${t.id}" checked />
          <span class="toggle-track"></span>
        </span>
      </label>
    `).join('')

    this.itemsEl.querySelectorAll<HTMLInputElement>('.track-toggle').forEach(cb => {
      cb.addEventListener('change', (e) => {
        e.stopPropagation()
        const id = cb.dataset['id']
        if (id) this.renderer.setTrackVisible(id, cb.checked)
      })
    })
  }

  toggle(): void { this.isOpen ? this.close() : this.open() }

  open(): void {
    this.isOpen = true
    this.backdrop.classList.add('open')
    this.panel.classList.add('open')
  }

  close(): void {
    this.isOpen = false
    this.backdrop.classList.remove('open')
    this.panel.classList.remove('open')
  }

  hide(): void { this.close() }
}

const ICON_CLOSE = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
  <line x1="18" y1="6" x2="6" y2="18"/>
  <line x1="6" y1="6" x2="18" y2="18"/>
</svg>`

const ICON_UPLOAD = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
  <polyline points="17 8 12 3 7 8"/>
  <line x1="12" y1="3" x2="12" y2="15"/>
</svg>`
