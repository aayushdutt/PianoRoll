import type { MidiFile } from '../core/midi/types'
import type { PianoRollRenderer } from '../renderer/PianoRollRenderer'
import { icons } from './icons'
import { escHtml, hexToCSS, isNarrowViewport } from './utils'

// Popover dropdown anchored under the Tracks button in the top strip.
// Each track has a mute toggle; a "Load new file" footer reopens the Open MIDI
// modal for quick swap.

export class TrackPanel {
  private panel: HTMLElement
  private itemsEl: HTMLElement
  private trigger: HTMLElement | null = null
  private isOpen = false

  private onDocPointer = (e: PointerEvent): void => {
    const target = e.target as Node
    if (this.panel.contains(target)) return
    if (this.trigger?.contains(target)) return
    this.close()
  }
  private onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && this.isOpen) this.close()
  }
  private onResize = (): void => {
    if (!this.isOpen) return
    // Sheet mode is CSS-driven; if the breakpoint flipped while open, just
    // close to avoid a half-styled popover.
    if (this.panel.classList.contains('popover--sheet') || isNarrowViewport()) {
      this.close()
      return
    }
    this.positionUnder()
  }

  constructor(
    container: HTMLElement,
    private renderer: PianoRollRenderer,
    private onLoadNew: () => void,
  ) {
    this.panel = document.createElement('div')
    this.panel.id = 'track-panel'
    this.panel.className = 'ts-popover'
    this.panel.innerHTML = `
      <div class="panel-header">
        <span class="panel-label">Tracks</span>
      </div>
      <div class="panel-items" id="panel-items"></div>
      <div class="panel-footer">
        <button class="panel-load-btn" id="panel-load-new" type="button">
          ${icons.upload(11)}
          Load new file
        </button>
      </div>
    `
    this.itemsEl = this.panel.querySelector<HTMLElement>('#panel-items')!
    this.panel.querySelector('#panel-load-new')!.addEventListener('click', () => {
      this.close()
      this.onLoadNew()
    })
    container.appendChild(this.panel)
  }

  render(midi: MidiFile): void {
    this.itemsEl.innerHTML = midi.tracks
      .map(
        (t) => `
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
    `,
      )
      .join('')

    this.itemsEl.querySelectorAll<HTMLInputElement>('.track-toggle').forEach((cb) => {
      cb.addEventListener('change', (e) => {
        e.stopPropagation()
        const id = cb.dataset['id']
        if (id) this.renderer.setTrackVisible(id, cb.checked)
      })
    })
  }

  // Anchors the popover under a trigger element (the top-strip Tracks button).
  setTrigger(el: HTMLElement): void {
    this.trigger = el
  }

  toggle(): void {
    this.isOpen ? this.close() : this.open()
  }

  open(): void {
    if (this.isOpen) return
    this.isOpen = true
    this.panel.classList.add('ts-popover--open')
    // Narrow viewports get a bottom-sheet layout from CSS — skip JS anchoring
    // and clear any inline positioning left over from a previous desktop open.
    if (isNarrowViewport()) {
      this.panel.classList.add('popover--sheet')
      this.panel.style.top = ''
      this.panel.style.right = ''
      this.panel.style.left = ''
    } else {
      this.panel.classList.remove('popover--sheet')
      this.positionUnder()
    }
    // Defer listener attach to the next tick so the click that opened us
    // doesn't immediately bubble and close it.
    setTimeout(() => {
      document.addEventListener('pointerdown', this.onDocPointer)
      document.addEventListener('keydown', this.onKey)
      window.addEventListener('resize', this.onResize)
    }, 0)
  }

  close(): void {
    if (!this.isOpen) return
    this.isOpen = false
    this.panel.classList.remove('ts-popover--open')
    this.panel.classList.remove('popover--sheet')
    document.removeEventListener('pointerdown', this.onDocPointer)
    document.removeEventListener('keydown', this.onKey)
    window.removeEventListener('resize', this.onResize)
  }

  hide(): void {
    this.close()
  }

  private positionUnder(): void {
    const trigger = this.trigger
    if (!trigger) return
    const rect = trigger.getBoundingClientRect()
    const panelW = this.panel.offsetWidth || 320
    // Right-align with the trigger so the popover doesn't get pushed off-screen
    // when the trigger is near the right edge of the strip.
    const right = Math.max(12, window.innerWidth - rect.right)
    const top = rect.bottom + 8
    this.panel.style.right = `${right}px`
    this.panel.style.top = `${top}px`
    this.panel.style.left = ''
    // Belt-and-suspenders: if we still don't fit, clamp to viewport.
    const desiredLeft = window.innerWidth - right - panelW
    if (desiredLeft < 12)
      this.panel.style.right = `${Math.max(12, window.innerWidth - panelW - 12)}px`
  }
}
