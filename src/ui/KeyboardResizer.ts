import { KEYBOARD_HEIGHT_MAX, KEYBOARD_HEIGHT_MIN } from '../renderer/PianoRollRenderer'

const STORAGE_KEY = 'midee.keyboardHeight'

// Viewport-derived bounds so the keyboard stays usable on short phone screens
// and doesn't dominate on tall ones. Final range is intersected with the
// renderer's absolute min/max so we never feed it an out-of-spec height.
function viewportBounds(): { min: number; max: number } {
  const vh = typeof window !== 'undefined' ? window.innerHeight : 900
  // Use svh-equivalent via innerHeight — mobile URL bar fluctuations are fine
  // because we clamp on every resize/restore anyway.
  const min = Math.max(KEYBOARD_HEIGHT_MIN, Math.round(vh * 0.18))
  const max = Math.min(KEYBOARD_HEIGHT_MAX, Math.round(vh * 0.6))
  // Guard against degenerate viewports (min ending up above max).
  if (min >= max) return { min: KEYBOARD_HEIGHT_MIN, max: KEYBOARD_HEIGHT_MAX }
  return { min, max }
}

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

    // Touch devices get a fixed, CSS-driven keyboard height — the drag grip
    // is hidden and we skip attaching pointer listeners so stray taps on the
    // seam can't accidentally move it. Desktop flow is unchanged.
    if (!this.isCoarsePointer()) {
      this.el.addEventListener('pointerdown', this.onPointerDown)
      this.el.addEventListener('dblclick', this.onDoubleClick)
    }
  }

  private isCoarsePointer(): boolean {
    if (typeof window === 'undefined' || !window.matchMedia) return false
    return window.matchMedia('(pointer: coarse)').matches
  }

  // Call after the renderer is initialised so the stored preference is applied.
  restoreSaved(): void {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return
    const value = Number(raw)
    if (!Number.isFinite(value)) return
    const { min, max } = viewportBounds()
    // Clamp the saved value into the current viewport range so a phone never
    // inherits a desktop-sized keyboard (or vice versa).
    const clamped = Math.min(max, Math.max(min, value))
    this.setHeight(clamped)
  }

  private onPointerDown = (e: PointerEvent): void => {
    // Touch mode early-out — redundant with the gated addEventListener in the
    // constructor, but keeps us safe if the viewport flips mid-session.
    if (this.isCoarsePointer()) return
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
    if (this.isCoarsePointer()) return
    const { min, max } = viewportBounds()
    this.setHeight(Math.min(max, Math.max(min, 120)))
    localStorage.removeItem(STORAGE_KEY)
  }

  dispose(): void {
    this.el.removeEventListener('pointerdown', this.onPointerDown)
    this.el.removeEventListener('dblclick', this.onDoubleClick)
    this.el.remove()
  }
}
