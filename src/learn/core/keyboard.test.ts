import { describe, expect, it } from 'vitest'
import { isKeyboardShortcutIgnored, isTextEntryTarget } from './keyboard'

function input(type: string): HTMLInputElement {
  const el = document.createElement('input')
  el.type = type
  return el
}

describe('isTextEntryTarget', () => {
  it('is true for the elements that consume every keystroke', () => {
    expect(isTextEntryTarget(input('text'))).toBe(true)
    expect(isTextEntryTarget(input('number'))).toBe(true)
    expect(isTextEntryTarget(document.createElement('textarea'))).toBe(true)
    expect(isTextEntryTarget(document.createElement('select'))).toBe(true)
  })

  it('is false for a range slider', () => {
    // The regression this guards: a focused volume/zoom slider is an INPUT but
    // only uses the arrow keys, so treating it as text entry left Space
    // (play/pause) dead for as long as focus stayed on it.
    expect(isTextEntryTarget(input('range'))).toBe(false)
  })

  it('is false for buttons and checkboxes', () => {
    expect(isTextEntryTarget(document.createElement('button'))).toBe(false)
    expect(isTextEntryTarget(input('checkbox'))).toBe(false)
  })

  it('is true for a contenteditable host', () => {
    const el = document.createElement('div')
    el.contentEditable = 'true'
    // jsdom does not derive isContentEditable from the attribute.
    Object.defineProperty(el, 'isContentEditable', { value: true })
    expect(isTextEntryTarget(el)).toBe(true)
  })

  it('is false for a null or non-element target', () => {
    expect(isTextEntryTarget(null)).toBe(false)
  })
})

describe('isKeyboardShortcutIgnored', () => {
  function keyEvent(target: EventTarget, init: KeyboardEventInit = {}): KeyboardEvent {
    const e = new KeyboardEvent('keydown', { code: 'Space', ...init })
    Object.defineProperty(e, 'target', { value: target })
    return e
  }

  it('ignores modified keystrokes regardless of target', () => {
    expect(isKeyboardShortcutIgnored(keyEvent(document.body, { metaKey: true }))).toBe(true)
    expect(isKeyboardShortcutIgnored(keyEvent(document.body, { ctrlKey: true }))).toBe(true)
    expect(isKeyboardShortcutIgnored(keyEvent(document.body, { altKey: true }))).toBe(true)
  })

  it('lets a bare shortcut through from a slider or the document body', () => {
    expect(isKeyboardShortcutIgnored(keyEvent(input('range')))).toBe(false)
    expect(isKeyboardShortcutIgnored(keyEvent(document.body))).toBe(false)
  })

  it('still defers to a focused text field', () => {
    expect(isKeyboardShortcutIgnored(keyEvent(input('text')))).toBe(true)
  })
})
