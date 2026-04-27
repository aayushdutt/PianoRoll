import { createEffect, createSignal, onCleanup, onMount, Show } from 'solid-js'
import { Portal } from 'solid-js/web'
import { type MessageKey, t } from '../i18n'

// Generic first-encounter coachmark anchored to a DOM element by id. Surfaces
// once per browser profile (localStorage-gated) the first time `eligible()`
// has been true continuously for `showDelayMs`. Auto-dismisses after
// `autoDismissMs`. Persistence happens at *show* time — once the bubble
// appears, the user has seen it; the various dismissal paths (close button,
// timer, anchor click, `dismissOn` flip) are equivalent for our purpose of
// "introduce once".
//
// Two presets live alongside this file: `LearnCoachmark` (Practice-this-piece
// pill) and `DragCoachmark` (HUD drag handle).

export type CoachmarkPlacement = 'above' | 'below'

export interface CoachmarkProps {
  anchorId: string
  storageKey: string
  titleKey: MessageKey
  bodyKey: MessageKey
  showDelayMs: number
  autoDismissMs: number
  placement?: CoachmarkPlacement
  eligible: () => boolean
  // Optional signal: when it becomes true while shown, dismiss immediately
  // (e.g. user has performed the action the coachmark was advertising).
  dismissOn?: () => boolean
  // Fires once, the moment the bubble first appears (and is marked seen).
  // Lets parents wire reactive "has been shown" state across coachmarks
  // without re-reading localStorage non-reactively.
  onShow?: () => void
}

function alreadySeen(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}

function markSeen(key: string): void {
  try {
    localStorage.setItem(key, '1')
  } catch {
    // No-op — privacy-mode users see the coachmark again next session.
  }
}

export function Coachmark(props: CoachmarkProps) {
  const placement = (): CoachmarkPlacement => props.placement ?? 'below'
  const [shown, setShown] = createSignal(false)
  const [pos, setPos] = createSignal<{ top: number; left: number }>({ top: 0, left: 0 })
  let showTimer: number | null = null
  let hideTimer: number | null = null
  let resizeListener: (() => void) | null = null

  function clearTimers(): void {
    if (showTimer !== null) {
      window.clearTimeout(showTimer)
      showTimer = null
    }
    if (hideTimer !== null) {
      window.clearTimeout(hideTimer)
      hideTimer = null
    }
  }

  function dismiss(): void {
    clearTimers()
    setShown(false)
  }

  // `position: fixed` consumes viewport coords, which is exactly what
  // getBoundingClientRect returns — no scroll math.
  function updatePos(): void {
    const btn = document.getElementById(props.anchorId)
    if (!btn) return
    const r = btn.getBoundingClientRect()
    const gap = 10
    const top = placement() === 'above' ? r.top - gap : r.bottom + gap
    setPos({ top, left: r.left + r.width / 2 })
  }

  // Eligibility flips → arm the show timer; flip back → cancel cleanly.
  // Once shown we never auto-resurrect: the user has either acted on it or
  // chosen to ignore, both of which count as "seen".
  createEffect(() => {
    if (alreadySeen(props.storageKey)) return
    if (props.eligible() && !shown()) {
      clearTimers()
      showTimer = window.setTimeout(() => {
        if (!props.eligible()) return
        const btn = document.getElementById(props.anchorId)
        if (!btn) return
        updatePos()
        setShown(true)
        markSeen(props.storageKey)
        props.onShow?.()
        hideTimer = window.setTimeout(() => setShown(false), props.autoDismissMs)
      }, props.showDelayMs)
    } else if (!props.eligible()) {
      clearTimers()
      setShown(false)
    }
  })

  // Optional external dismiss trigger — e.g. the user drags the HUD,
  // proving they discovered the affordance the coachmark was promoting.
  createEffect(() => {
    if (shown() && props.dismissOn?.()) dismiss()
  })

  onMount(() => {
    resizeListener = () => {
      if (shown()) updatePos()
    }
    window.addEventListener('resize', resizeListener)
    // Clicking the anchor itself dismisses immediately — acting on intent
    // should hide it the same frame, not wait for eligibility to propagate.
    const btn = document.getElementById(props.anchorId)
    btn?.addEventListener('click', dismiss)
  })
  onCleanup(() => {
    clearTimers()
    if (resizeListener) window.removeEventListener('resize', resizeListener)
    document.getElementById(props.anchorId)?.removeEventListener('click', dismiss)
  })

  return (
    <Show when={shown()}>
      <Portal>
        <div
          class={`coachmark coachmark--${placement()}`}
          role="status"
          aria-live="polite"
          style={{ top: `${pos().top}px`, left: `${pos().left}px` }}
        >
          <div class="coachmark__arrow" aria-hidden="true" />
          <div class="coachmark__title">{t(props.titleKey)}</div>
          <div class="coachmark__body">{t(props.bodyKey)}</div>
          <button
            class="coachmark__close"
            type="button"
            aria-label={t('coachmark.dismiss')}
            onClick={() => dismiss()}
          >
            ×
          </button>
        </div>
      </Portal>
    </Show>
  )
}
