import { INSTRUMENTS, type InstrumentId } from '../audio/SynthEngine'

// Topbar instrument picker — a pill trigger + dropdown menu. Available in
// both live and file modes so users can hear any loaded MIDI played back with
// a different voice (not just live input).

export class InstrumentMenu {
  readonly trigger: HTMLButtonElement
  private menu: HTMLElement
  private labelEl: HTMLElement
  private current: InstrumentId = 'piano'
  private isOpen = false

  onSelect?: (id: InstrumentId) => void

  private onDocPointer = (e: PointerEvent): void => {
    const target = e.target as Node
    if (this.menu.contains(target)) return
    if (this.trigger.contains(target)) return
    this.close()
  }
  private onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && this.isOpen) this.close()
  }
  private onResize = (): void => { if (this.isOpen) this.positionUnder() }

  constructor(triggerHost: HTMLElement, popoverHost: HTMLElement) {
    this.trigger = document.createElement('button')
    this.trigger.className = 'ts-pill ts-pill--instrument'
    this.trigger.id = 'ts-instrument'
    this.trigger.type = 'button'
    this.trigger.title = 'Instrument'
    this.trigger.setAttribute('aria-label', 'Choose instrument')
    this.trigger.innerHTML = `
      <span class="ts-instrument-icon-slot">
        ${ICON_INSTRUMENT}
        <span class="ts-instrument-spinner" aria-hidden="true"></span>
      </span>
      <span class="ts-instrument-label" id="ts-instrument-label">Piano</span>
      ${ICON_CHEV}
    `
    this.labelEl = this.trigger.querySelector<HTMLElement>('#ts-instrument-label')!
    this.trigger.addEventListener('click', () => this.toggle())
    triggerHost.appendChild(this.trigger)

    this.menu = document.createElement('div')
    this.menu.className = 'ts-popover ts-instrument-menu'
    this.menu.innerHTML = `
      <div class="panel-header"><span class="panel-label">Instrument</span></div>
      <div class="instrument-items">
        ${INSTRUMENTS.map(inst => `
          <button class="instrument-item" data-id="${inst.id}" type="button">
            <span class="instrument-item-dot" aria-hidden="true"></span>
            <span class="instrument-item-body">
              <span class="instrument-item-name">${inst.name}</span>
              <span class="instrument-item-sub">${inst.description}</span>
            </span>
            <span class="instrument-item-check" aria-hidden="true">${ICON_CHECK}</span>
          </button>
        `).join('')}
      </div>
    `
    popoverHost.appendChild(this.menu)

    this.menu.querySelectorAll<HTMLButtonElement>('.instrument-item').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset['id'] as InstrumentId | undefined
        if (!id) return
        this.setCurrent(id)
        this.close()
        this.onSelect?.(id)
      })
    })
  }

  setCurrent(id: InstrumentId): void {
    this.current = id
    const info = INSTRUMENTS.find(i => i.id === id)
    if (info) this.labelEl.textContent = info.name
    this.menu.querySelectorAll<HTMLButtonElement>('.instrument-item').forEach(btn => {
      btn.classList.toggle('instrument-item--on', btn.dataset['id'] === id)
    })
  }

  // Drives the loading indicator on both the trigger pill and the matching
  // dropdown row. Pass the id being loaded, or null when nothing is loading.
  setLoading(id: InstrumentId | null): void {
    this.trigger.classList.toggle('ts-pill--loading', id !== null)
    this.trigger.setAttribute('aria-busy', id !== null ? 'true' : 'false')
    this.menu.querySelectorAll<HTMLButtonElement>('.instrument-item').forEach(btn => {
      btn.classList.toggle('instrument-item--loading', btn.dataset['id'] === id)
    })
  }

  getCurrent(): InstrumentId { return this.current }

  private toggle(): void {
    this.isOpen ? this.close() : this.open()
  }

  private open(): void {
    if (this.isOpen) return
    this.isOpen = true
    this.trigger.classList.add('ts-pill--open')
    this.menu.classList.add('ts-popover--open')
    this.positionUnder()
    setTimeout(() => {
      document.addEventListener('pointerdown', this.onDocPointer)
      document.addEventListener('keydown', this.onKey)
      window.addEventListener('resize', this.onResize)
    }, 0)
  }

  private close(): void {
    if (!this.isOpen) return
    this.isOpen = false
    this.trigger.classList.remove('ts-pill--open')
    this.menu.classList.remove('ts-popover--open')
    document.removeEventListener('pointerdown', this.onDocPointer)
    document.removeEventListener('keydown', this.onKey)
    window.removeEventListener('resize', this.onResize)
  }

  private positionUnder(): void {
    const rect = this.trigger.getBoundingClientRect()
    const menuW = this.menu.offsetWidth || 260
    const right = Math.max(12, window.innerWidth - rect.right)
    const top = rect.bottom + 8
    this.menu.style.right = `${right}px`
    this.menu.style.top = `${top}px`
    this.menu.style.left = ''
    const desiredLeft = window.innerWidth - right - menuW
    if (desiredLeft < 12) this.menu.style.right = `${Math.max(12, window.innerWidth - menuW - 12)}px`
  }
}

const ICON_INSTRUMENT = `<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
  <path d="M9 3h6a1 1 0 0 1 1 1v14a3 3 0 1 1-2 0V9h-2v9a3 3 0 1 1-2 0V4a1 1 0 0 1 1-1z" opacity="0.9"/>
</svg>`

const ICON_CHEV = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <polyline points="6 9 12 15 18 9"/>
</svg>`

const ICON_CHECK = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
  <polyline points="20 6 9 17 4 12"/>
</svg>`
