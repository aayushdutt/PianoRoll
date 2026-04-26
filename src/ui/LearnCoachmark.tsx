import { createEffect, createSignal, onCleanup, onMount, Show } from 'solid-js'
import { Portal } from 'solid-js/web'

// First-encounter coachmark anchored to the topbar's "Learn" pill. Surfaces
// once per browser profile, the first time a user lands in Play mode with a
// loaded MIDI — long enough after the file load that they've had a moment to
// orient. Never shows again after dismissal (the goal is *introduce*, not
// nag — repeat-visit users will already know the pill exists).
//
// Dismissal triggers (any of these mark the coachmark "seen" forever):
//   • user clicks the Learn pill itself
//   • user clicks the × on the bubble
//   • the auto-dismiss timer fires (~14 s after appearing)
//   • the bubble is shown (we persist on show — simpler than tracking the
//     three "actually dismissed" paths above and equivalent for our purpose
//     of "introduce once").

const STORAGE_KEY = 'midee_learn_coachmark_seen_v1'
const SHOW_DELAY_MS = 8000
const AUTO_DISMISS_MS = 14000
const ANCHOR_ID = 'ts-learn-this'

function alreadySeen(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

function markSeen(): void {
  try {
    localStorage.setItem(STORAGE_KEY, '1')
  } catch {
    // No-op — privacy-mode users just see the coachmark again next session.
    // Fine; the alternative (in-memory state) is worse on session crash.
  }
}

export function LearnCoachmark(props: { eligible: () => boolean }) {
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

  // Anchor under the Learn pill. `position: fixed` consumes viewport coords,
  // which is exactly what getBoundingClientRect returns — no scroll math.
  function updatePos(): void {
    const btn = document.getElementById(ANCHOR_ID)
    if (!btn) return
    const r = btn.getBoundingClientRect()
    // 10 px gap below the button. Centered horizontally on the button — the
    // bubble's own transform pulls it back to anchor on its own midpoint.
    setPos({ top: r.bottom + 10, left: r.left + r.width / 2 })
  }

  // Eligibility flips → arm the show timer; flip back → cancel cleanly.
  // Once shown we never auto-resurrect: the user has either acted on it or
  // chosen to ignore, both of which count as "seen".
  createEffect(() => {
    if (alreadySeen()) return
    if (props.eligible() && !shown()) {
      clearTimers()
      showTimer = window.setTimeout(() => {
        if (!props.eligible()) return
        const btn = document.getElementById(ANCHOR_ID)
        if (!btn) return
        updatePos()
        setShown(true)
        markSeen()
        hideTimer = window.setTimeout(() => setShown(false), AUTO_DISMISS_MS)
      }, SHOW_DELAY_MS)
    } else if (!props.eligible()) {
      clearTimers()
      setShown(false)
    }
  })

  onMount(() => {
    resizeListener = () => {
      if (shown()) updatePos()
    }
    window.addEventListener('resize', resizeListener)
    // Clicking the pill itself dismisses immediately (clicking-through the
    // coachmark to the underlying button still works because the pointer
    // pierces the bubble — but acting on intent should hide it the same
    // frame, not wait for the eligibility flip to propagate).
    const btn = document.getElementById(ANCHOR_ID)
    btn?.addEventListener('click', dismiss)
  })
  onCleanup(() => {
    clearTimers()
    if (resizeListener) window.removeEventListener('resize', resizeListener)
    document.getElementById(ANCHOR_ID)?.removeEventListener('click', dismiss)
  })

  return (
    <Show when={shown()}>
      <Portal>
        <div
          class="learn-coachmark"
          role="status"
          aria-live="polite"
          style={{ top: `${pos().top}px`, left: `${pos().left}px` }}
        >
          <div class="learn-coachmark__arrow" aria-hidden="true" />
          <div class="learn-coachmark__title">Practice this piece</div>
          <div class="learn-coachmark__body">Step through note-by-note with wait-mode.</div>
          <button
            class="learn-coachmark__close"
            type="button"
            aria-label="Dismiss"
            onClick={() => dismiss()}
          >
            ×
          </button>
        </div>
      </Portal>
    </Show>
  )
}
