import { afterEach, describe, expect, it, vi } from 'vitest'
import { setLocale } from '../i18n'
import { GuitarAccessibilityGrid } from './GuitarAccessibilityGrid'
import { createGuitarLayout } from './GuitarGeometry'

const grids: GuitarAccessibilityGrid[] = []

function setup() {
  const canvas = document.createElement('canvas')
  document.body.appendChild(canvas)
  const onActivate = vi.fn()
  const onFocus = vi.fn()
  const grid = new GuitarAccessibilityGrid({ canvas, onActivate, onFocus })
  grids.push(grid)
  return { grid, onActivate, onFocus }
}

afterEach(async () => {
  for (const grid of grids.splice(0)) grid.destroy()
  document.body.replaceChildren()
  await setLocale('en')
})

describe('GuitarAccessibilityGrid', () => {
  it('builds a localized 6 by 25 native-button grid with one high-E roving target', () => {
    const { grid } = setup()
    expect(grid.element.hidden).toBe(true)
    expect(grid.element.hasAttribute('inert')).toBe(true)
    grid.setVisible(true)
    expect(grid.element.getAttribute('role')).toBe('grid')
    expect(grid.element.getAttribute('aria-label')).toBe('Interactive guitar fretboard')
    expect(grid.element.querySelectorAll('[role=row]')).toHaveLength(6)
    const buttons = Array.from(grid.element.querySelectorAll('button'))
    expect(buttons).toHaveLength(150)
    expect(grid.element.querySelector('[role=row]')?.getAttribute('aria-rowindex')).toBe('1')
    expect(buttons[0]?.getAttribute('aria-label')).toBe('String 1, fret 0, note E4')
    expect(buttons.filter((button) => button.tabIndex === 0)).toEqual([buttons[0]])
  })

  it('contains navigation collisions, follows visual direction, clamps, and keeps Tab native', () => {
    const { grid } = setup()
    grid.setVisible(true)
    const first = grid.element.querySelector('button')!
    first.focus()
    const parent = vi.fn()
    window.addEventListener('keydown', parent)
    const press = (key: string) => {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
      document.activeElement!.dispatchEvent(event)
      return event
    }
    expect(press('ArrowUp').defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(first)
    press('ArrowRight')
    expect((document.activeElement as HTMLButtonElement).dataset.fret).toBe('1')
    press('ArrowDown')
    expect((document.activeElement as HTMLButtonElement).dataset.string).toBe('4')
    press('End')
    expect((document.activeElement as HTMLButtonElement).dataset.fret).toBe('24')
    press('ArrowRight')
    expect((document.activeElement as HTMLButtonElement).dataset.fret).toBe('24')
    press('Home')
    expect((document.activeElement as HTMLButtonElement).dataset.fret).toBe('0')
    const tab = press('Tab')
    expect(tab.defaultPrevented).toBe(false)
    expect(parent).not.toHaveBeenCalled()
    window.removeEventListener('keydown', parent)
  })

  it('uses native clicks for Enter and Space without canceling their defaults', () => {
    const { grid, onActivate } = setup()
    const button = grid.element.querySelector('button')!
    const parent = vi.fn()
    window.addEventListener('keydown', parent)
    for (const key of ['Enter', ' ']) {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
      button.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(false)
      button.click()
    }
    expect(parent).not.toHaveBeenCalled()
    expect(onActivate).toHaveBeenCalledTimes(2)
    window.removeEventListener('keydown', parent)
  })

  it('updates geometry and locale in place without replacing identity or focus', async () => {
    const { grid } = setup()
    grid.setVisible(true)
    const button = grid.element.querySelector('button')!
    button.focus()
    grid.updateGeometry(createGuitarLayout(390, 844), 0)
    grid.updateGeometry(createGuitarLayout(430, 844), 44)
    expect(grid.element.querySelector('button')).toBe(button)
    expect(document.activeElement).toBe(button)
    await setLocale('pl')
    expect(grid.element.querySelector('button')).toBe(button)
    expect(button.getAttribute('aria-label')).toContain('Struna 1')
  })

  it('blurs and becomes hidden/inert, then removes itself and locale subscription', () => {
    const { grid } = setup()
    grid.setVisible(true)
    const button = grid.element.querySelector('button')!
    button.focus()
    grid.setVisible(false)
    expect(grid.element.hidden).toBe(true)
    expect(grid.element.hasAttribute('inert')).toBe(true)
    expect(document.activeElement).not.toBe(button)
    grid.setVisible(true)
    expect(grid.element.hidden).toBe(false)
    expect(grid.element.hasAttribute('inert')).toBe(false)
    grid.destroy()
    grids.splice(grids.indexOf(grid), 1)
    expect(grid.element.isConnected).toBe(false)
  })
})
