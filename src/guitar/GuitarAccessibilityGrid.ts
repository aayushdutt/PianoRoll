import { pitchToNoteName } from '../core/midi/types'
import { locale, t } from '../i18n'
import type { GuitarLayout } from './GuitarGeometry'
import {
  GUITAR_MAX_FRET,
  GUITAR_STRING_COUNT,
  pitchAtPosition,
  positionRect,
} from './GuitarGeometry'
import type { GuitarPosition } from './types'

interface GuitarAccessibilityGridOptions {
  canvas: HTMLCanvasElement
  onActivate(position: GuitarPosition, pitch: number): void
  onFocus(position: GuitarPosition): void
}

export class GuitarAccessibilityGrid {
  readonly element: HTMLDivElement
  private readonly buttons = new Map<string, HTMLButtonElement>()
  private current: GuitarPosition = { string: 5, fret: 0 }
  private geometrySignature = ''
  private readonly localeUnsub: () => void

  constructor(private readonly options: GuitarAccessibilityGridOptions) {
    this.element = document.createElement('div')
    this.element.className = 'guitar-accessibility-grid'
    this.element.setAttribute('role', 'grid')
    this.element.setAttribute('aria-rowcount', String(GUITAR_STRING_COUNT))
    this.element.setAttribute('aria-colcount', String(GUITAR_MAX_FRET + 1))
    this.element.hidden = true
    this.element.setAttribute('inert', '')

    for (let string = GUITAR_STRING_COUNT - 1; string >= 0; string--) {
      const row = document.createElement('div')
      row.className = 'guitar-accessibility-grid__row'
      row.setAttribute('role', 'row')
      row.setAttribute('aria-rowindex', String(GUITAR_STRING_COUNT - string))
      for (let fret = 0; fret <= GUITAR_MAX_FRET; fret++) {
        const cell = document.createElement('div')
        cell.className = 'guitar-accessibility-grid__cell'
        cell.setAttribute('role', 'gridcell')
        cell.setAttribute('aria-colindex', String(fret + 1))
        const button = document.createElement('button')
        button.type = 'button'
        button.tabIndex = string === this.current.string && fret === this.current.fret ? 0 : -1
        button.dataset.string = String(string)
        button.dataset.fret = String(fret)
        button.addEventListener('focus', this.onButtonFocus)
        button.addEventListener('keydown', this.onButtonKeyDown)
        button.addEventListener('click', this.onButtonClick)
        cell.appendChild(button)
        row.appendChild(cell)
        this.buttons.set(this.key({ string, fret }), button)
      }
      this.element.appendChild(row)
    }
    options.canvas.after(this.element)
    this.updateLabels()
    this.localeUnsub = locale.subscribe(() => this.updateLabels())
  }

  get hasFocus(): boolean {
    return this.element.contains(document.activeElement)
  }

  get focusedPosition(): GuitarPosition | null {
    return this.hasFocus ? this.current : null
  }

  updateGeometry(layout: GuitarLayout, panX: number): void {
    const signature = `${layout.width}:${layout.height}:${layout.fretboardTop}:${layout.stringHeight}:${layout.fretWidth}:${panX}`
    if (signature === this.geometrySignature) return
    this.geometrySignature = signature
    for (const [key, button] of this.buttons) {
      const [string, fret] = key.split(':').map(Number) as [number, number]
      const rect = positionRect({ string, fret }, layout, panX)
      button.parentElement!.style.cssText = `left:${rect.x}px;top:${rect.y}px;width:${rect.width}px;height:${rect.height}px`
    }
  }

  setVisible(visible: boolean): void {
    if (visible) this.element.removeAttribute('inert')
    else {
      if (this.hasFocus) (document.activeElement as HTMLElement).blur()
      this.element.setAttribute('inert', '')
    }
    this.element.hidden = !visible
  }

  blur(): void {
    if (this.hasFocus) (document.activeElement as HTMLElement).blur()
  }

  destroy(): void {
    this.localeUnsub()
    this.element.remove()
  }

  private updateLabels(): void {
    this.element.setAttribute('aria-label', t('guitar.fretboard.aria'))
    for (const [key, button] of this.buttons) {
      const [string, fret] = key.split(':').map(Number) as [number, number]
      const pitch = pitchAtPosition({ string, fret })
      button.setAttribute(
        'aria-label',
        t('guitar.fretboard.position', {
          string: GUITAR_STRING_COUNT - string,
          fret,
          note: pitchToNoteName(pitch),
        }),
      )
    }
  }

  private onButtonFocus = (event: FocusEvent): void => {
    const position = this.positionFor(event.currentTarget as HTMLButtonElement)
    this.setCurrent(position)
    this.options.onFocus(position)
  }

  private onButtonClick = (event: MouseEvent): void => {
    event.stopPropagation()
    const position = this.positionFor(event.currentTarget as HTMLButtonElement)
    this.options.onActivate(position, pitchAtPosition(position))
  }

  private onButtonKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.stopPropagation()
      return
    }
    if (event.key === 'Tab') {
      event.stopPropagation()
      return
    }
    const next = { ...this.positionFor(event.currentTarget as HTMLButtonElement) }
    if (event.key === 'ArrowLeft') next.fret--
    else if (event.key === 'ArrowRight') next.fret++
    else if (event.key === 'ArrowUp') next.string++
    else if (event.key === 'ArrowDown') next.string--
    else if (event.key === 'Home') next.fret = 0
    else if (event.key === 'End') next.fret = GUITAR_MAX_FRET
    else return
    event.preventDefault()
    event.stopPropagation()
    next.string = Math.max(0, Math.min(GUITAR_STRING_COUNT - 1, next.string))
    next.fret = Math.max(0, Math.min(GUITAR_MAX_FRET, next.fret))
    this.setCurrent(next)
    this.buttons.get(this.key(next))!.focus({ preventScroll: true })
  }

  private setCurrent(position: GuitarPosition): void {
    this.buttons.get(this.key(this.current))!.tabIndex = -1
    this.current = position
    this.buttons.get(this.key(position))!.tabIndex = 0
  }

  private positionFor(button: HTMLButtonElement): GuitarPosition {
    return { string: Number(button.dataset.string), fret: Number(button.dataset.fret) }
  }

  private key(position: GuitarPosition): string {
    return `${position.string}:${position.fret}`
  }
}
