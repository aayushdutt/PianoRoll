// Public feedback / feature-request portal (self-hosted Fider). Opened in a
// new tab from the customize menu and the post-session modal — see CONTEXT
// for surfacing rationale.
export const FEEDBACK_URL = 'https://feedback.midee.app'

export function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// Canonical copy lives in renderer/theme.ts (renderer must not import UI code).
export { hexToCSS } from '../renderer/theme'

// Narrow viewport = bottom-sheet popover mode. Kept in sync with the CSS
// breakpoint used by the `.popover--sheet` styling.
const NARROW_VIEWPORT_MQ = '(max-width: 640px)'

export function isNarrowViewport(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false
  return window.matchMedia(NARROW_VIEWPORT_MQ).matches
}

// Call once at app init. Toggles `body.is-touch` for coarse pointers and
// `body.is-narrow` for small viewports, and keeps both in sync with media
// query changes. Returns a disposer if the caller ever wants to detach.
export function installViewportClassSync(): () => void {
  const body = document.body
  const coarse = window.matchMedia('(pointer: coarse)')
  const narrow = window.matchMedia(NARROW_VIEWPORT_MQ)

  const syncCoarse = (): void => {
    body.classList.toggle('is-touch', coarse.matches)
  }
  const syncNarrow = (): void => {
    body.classList.toggle('is-narrow', narrow.matches)
  }
  syncCoarse()
  syncNarrow()

  coarse.addEventListener('change', syncCoarse)
  narrow.addEventListener('change', syncNarrow)

  return () => {
    coarse.removeEventListener('change', syncCoarse)
    narrow.removeEventListener('change', syncNarrow)
  }
}
