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

// Controls that consume Space themselves: it activates a button and toggles a
// checkbox or radio. Narrowing INPUT_TAGS to free the range slider also freed
// these, so a Tab-focused track-visibility checkbox had its Space stolen by the
// global play/pause and could not be toggled by keyboard at all.
const SPACE_ACTIVATED_INPUT_TYPES = new Set(['button', 'submit', 'reset', 'checkbox', 'radio'])

export function isSpaceActivatedControl(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.tagName === 'BUTTON' || target.getAttribute('role') === 'button') return true
  return target instanceof HTMLInputElement && SPACE_ACTIVATED_INPUT_TYPES.has(target.type)
}

export function isKeyboardShortcutIgnored(e: KeyboardEvent): boolean {
  if (e.ctrlKey || e.metaKey || e.altKey) return true
  return isTextEntryTarget(e.target)
}
