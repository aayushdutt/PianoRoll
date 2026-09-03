import { Coachmark } from './Coachmark'
import { THROUGHPUT_KEY } from './exportSettings'

// First-encounter coachmark on the topbar's Export button — the product's
// star action, and the one the funnel shows most people never open. Shows
// once per browser profile, after the Learn coachmark has had its turn, and
// never for someone who has already exported (a finished export leaves its
// encoder throughput in localStorage).

const STORAGE_KEY = 'midee.coachmark.exportShown'
// Eligible once the Learn bubble has shown (20 s after load), so this lands
// at ~30 s, right as that one auto-dismisses; both sit in the top strip.
const SHOW_DELAY_MS = 10_000
const AUTO_DISMISS_MS = 14_000
const ANCHOR_ID = 'ts-record'

export function ExportCoachmark(props: { eligible: () => boolean }) {
  return (
    <Coachmark
      anchorId={ANCHOR_ID}
      storageKey={STORAGE_KEY}
      titleKey="coachmark.export.title"
      bodyKey="coachmark.export.body"
      showDelayMs={SHOW_DELAY_MS}
      autoDismissMs={AUTO_DISMISS_MS}
      placement="below"
      eligible={() => props.eligible() && !hasExportedBefore()}
    />
  )
}

function hasExportedBefore(): boolean {
  try {
    return localStorage.getItem(THROUGHPUT_KEY) !== null
  } catch {
    return false
  }
}
