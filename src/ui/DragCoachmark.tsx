import { Coachmark } from './Coachmark'

// First-encounter coachmark anchored to the HUD drag handle. Surfaces only
// after the Learn coachmark has been seen — staggering avoids two bubbles
// competing for attention on the same screen — and dismisses immediately the
// first time the user drags the HUD (proving they discovered the affordance).

const STORAGE_KEY = 'midee.coachmark.dragShown'
const SHOW_DELAY_MS = 6000
const AUTO_DISMISS_MS = 10000
const ANCHOR_ID = 'hud-drag'

export function DragCoachmark(props: { eligible: () => boolean; hasDragged: () => boolean }) {
  return (
    <Coachmark
      anchorId={ANCHOR_ID}
      storageKey={STORAGE_KEY}
      titleKey="coachmark.drag.title"
      bodyKey="coachmark.drag.body"
      showDelayMs={SHOW_DELAY_MS}
      autoDismissMs={AUTO_DISMISS_MS}
      placement="above"
      eligible={props.eligible}
      dismissOn={props.hasDragged}
    />
  )
}
