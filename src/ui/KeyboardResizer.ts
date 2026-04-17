import { KEYBOARD_HEIGHT_MIN, KEYBOARD_HEIGHT_MAX } from '../renderer/PianoRollRenderer'

const STORAGE_KEY = 'midee.keyboardHeight'

// Slim horizontal drag bar sitting on the seam between the piano roll and the
// keyboard. DAW-style (Logic / GarageBand): grab it and drag vertically to
// resize the keyboard area. Height persists to localStorage.
export class KeyboardResizer {
  private el: HTMLElement
  private isDragging = false
  private dragStartY = 0
  private dragStartHeight = 0

  constructor(
    container: HTMLElement,
    private getHeight: () => number,
    private setHeight: (px: number) => void,
  ) {
    this.el = document.createElement('div')
    this.el.id = 'kbd-resizer'
    this.el.setAttribute('role', 'separator')
    this.el.setAttribute('aria-orientation', 'horizontal')
    this.el.setAttribute('aria-label', 'Resize keyboard')
    this.el.innerHTML = `<span class="kbd-resizer-grip"></span>`
    container.appendChild(this.el)

    this.el.addEventListener('pointerdown', this.onPointerDown)
    this.el.addEventListener('dblclick', this.onDoubleClick)
  }

  // Call after the renderer is initialised so the stored preference is applied.
  restoreSaved(): void {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return
    const value = Number(raw)
    if (Number.isFinite(value) && value >= KEYBOARD_HEIGHT_MIN && value <= KEYBOARD_HEIGHT_MAX) {
      this.setHeight(value)
    }
  }

  private onPointerDown = (e: PointerEvent): void => {
    e.preventDefault()
    this.isDragging = true
    this.dragStartY = e.clientY
    this.dragStartHeight = this.getHeight()
    this.el.setPointerCapture(e.pointerId)
    this.el.classList.add('kbd-resizer--active')
    this.el.addEventListener('pointermove', this.onPointerMove)
    this.el.addEventListener('pointerup', this.onPointerUp)
    this.el.addEventListener('pointercancel', this.onPointerUp)
  }

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.isDragging) return
    // Dragging up increases keyboard height (intuitive "pull up the keyboard")
    const delta = this.dragStartY - e.clientY
    this.setHeight(this.dragStartHeight + delta)
  }

  private onPointerUp = (e: PointerEvent): void => {
    if (!this.isDragging) return
    this.isDragging = false
    this.el.releasePointerCapture(e.pointerId)
    this.el.classList.remove('kbd-resizer--active')
    this.el.removeEventListener('pointermove', this.onPointerMove)
    this.el.removeEventListener('pointerup', this.onPointerUp)
    this.el.removeEventListener('pointercancel', this.onPointerUp)
    localStorage.setItem(STORAGE_KEY, String(this.getHeight()))
  }

  private onDoubleClick = (): void => {
    this.setHeight(120)
    localStorage.removeItem(STORAGE_KEY)
  }

  dispose(): void {
    this.el.removeEventListener('pointerdown', this.onPointerDown)
    this.el.removeEventListener('dblclick', this.onDoubleClick)
    this.el.remove()
  }
}
