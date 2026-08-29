const INPUT_TAGS = new Set(['TEXTAREA', 'SELECT'])

// Input types that consume every keystroke. Deliberately NOT the whole INPUT
// tag: a focused range slider is an INPUT but uses only the arrow keys, so
// treating it as text entry left Space (play/pause) dead for as long as focus
// stayed on the volume or zoom slider you last clicked.
const TEXT_INPUT_TYPES = new Set([
  'text',
  'search',
  'email',
  'url',
  'tel',
  'password',
  'number',
  'date',
  'time',
  'datetime-local',
  'month',
  'week',
])

export function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (INPUT_TAGS.has(target.tagName) || target.isContentEditable) return true
  return target instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(target.type)
}

export function isKeyboardShortcutIgnored(e: KeyboardEvent): boolean {
  if (e.ctrlKey || e.metaKey || e.altKey) return true
  return isTextEntryTarget(e.target)
}
