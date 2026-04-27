import { Coachmark } from './Coachmark'

// First-encounter coachmark anchored to the topbar's "Learn" pill. Surfaces
// once per browser profile, the first time a user lands in Play mode with a
// loaded MIDI — long enough after the file load that they've had a moment to
// orient.

const STORAGE_KEY = 'midee.coachmark.learnShown'
const SHOW_DELAY_MS = 8000
const AUTO_DISMISS_MS = 14000
const ANCHOR_ID = 'ts-learn-this'

export function LearnCoachmark(props: { eligible: () => boolean; onShow?: () => void }) {
  return (
    <Coachmark
      anchorId={ANCHOR_ID}
      storageKey={STORAGE_KEY}
      titleKey="coachmark.learn.title"
      bodyKey="coachmark.learn.body"
      showDelayMs={SHOW_DELAY_MS}
      autoDismissMs={AUTO_DISMISS_MS}
      placement="below"
      eligible={props.eligible}
      onShow={() => props.onShow?.()}
    />
  )
}

export function isLearnCoachmarkSeen(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}
