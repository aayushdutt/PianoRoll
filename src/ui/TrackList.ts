import type { MidiFile } from '../core/midi/types'
import type { PianoRollRenderer } from '../renderer/PianoRollRenderer'
import { escHtml, hexToCSS } from './utils'

export class TrackList {
  private el: HTMLElement
  private inner!: HTMLElement
  private collapsed = false

  constructor(
    container: HTMLElement,
    private renderer: PianoRollRenderer,
  ) {
    this.el = document.createElement('div')
    this.el.id = 'track-list'
    container.appendChild(this.el)
  }

  render(midi: MidiFile): void {
    this.el.innerHTML = `
      <div class="track-list-inner">
        <div class="track-list-header" id="tl-header">
          <span class="track-list-label">Tracks</span>
          <button class="track-list-collapse-btn" aria-label="Toggle track list">
            ${ICON_CHEVRON}
          </button>
        </div>
        <div class="track-list-items">
          ${midi.tracks.map(t => `
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
          `).join('')}
        </div>
      </div>
    `

    this.inner = this.el.querySelector<HTMLElement>('.track-list-inner')!

    // Restore collapsed state across re-renders
    if (this.collapsed) this.inner.classList.add('collapsed')

    this.el.querySelector('#tl-header')!.addEventListener('click', () => this.toggleCollapse())

    this.el.querySelectorAll<HTMLInputElement>('.track-toggle').forEach(cb => {
      cb.addEventListener('change', (e) => {
        e.stopPropagation()
        const id = cb.dataset['id']
        if (id) this.renderer.setTrackVisible(id, cb.checked)
      })
    })

    this.show()
  }

  private toggleCollapse(): void {
    this.collapsed = !this.collapsed
    this.inner.classList.toggle('collapsed', this.collapsed)
  }

  show(): void { this.el.classList.remove('hidden') }
  hide(): void { this.el.classList.add('hidden') }
}

const ICON_CHEVRON = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
  <polyline points="6 9 12 15 18 9"/>
</svg>`
