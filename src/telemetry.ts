import type { PostHog, PostHogConfig } from 'posthog-js'
import type { AppMode } from './store/state'

// Thin wrapper around posthog-js + a typed event registry. Kept as a single
// flat file (not `src/analytics/*`) because common ad blockers treat
// `/analytics/` paths as trackers and block them outright — during Vite dev
// that means blank module loads and cryptic import errors. The file has also
// been renamed away from `analytics.ts` to avoid the same heuristic.
//
// Event-name convention: snake_case, past tense. Don't rename existing event
// names without dual-firing for at least two weeks (see play_mode_entered /
// file_mode_entered for the pattern).
//
// posthog-js is dynamic-imported on idle (see `loadPostHog`) so it doesn't
// block the initial bundle (~70 KB gz at the time of writing). Calls made
// before the SDK loads are queued and replayed in-order on `loadPostHog`.

let ph: PostHog | null = null
let phLoadFailed = false
const queue: Array<(client: PostHog) => void> = []

// Drain any calls made while the SDK was still loading. Order matters —
// `register*` should land before any `capture` that depends on those props.
// If the SDK never loads (CSP, ad-blocker, offline), we drop the call rather
// than grow the queue unbounded.
function enqueue(fn: (client: PostHog) => void): void {
  if (ph) fn(ph)
  else if (!phLoadFailed) queue.push(fn)
}

export async function loadPostHog(key: string, config: Partial<PostHogConfig>): Promise<void> {
  try {
    const mod = await import('posthog-js')
    mod.default.init(key, config)
    ph = mod.default
    for (const fn of queue) fn(ph)
    queue.length = 0
  } catch (err) {
    // Likely CSP / ad-blocker / offline. Mark failed so the queue stops
    // growing; existing entries are dropped to free memory.
    phLoadFailed = true
    queue.length = 0
    console.warn('[telemetry] posthog-js failed to load', err)
  }
}

// Fired at key funnel points: midi_loaded → first_play → playback_milestone
// → export_opened → export_started → export_completed. The live funnel runs
// in parallel: live_mode_entered → first_live_note → loop_saved /
// session_recorded. Keep names stable — they're the join key between product
// and analytics.
export function track(event: string, properties?: Record<string, unknown>): void {
  enqueue((client) => client.capture(event, properties))
}

// Set once at boot. These attach to *every* subsequent event so we can
// slice any funnel by device/pointer/orientation without re-sending them.
// Landing path/referrer/utm are registered with `register_once` so the
// FIRST-seen values persist across the whole user's history — PostHog's
// built-in $referrer captures the referrer at each event, which isn't the
// same thing and doesn't answer "where did this user originally come from?"
export function registerAnalyticsContext(): void {
  // Snapshot DOM/window reads NOW (not inside the deferred closure) — the
  // viewport state at boot is what we want to attach to events, even if the
  // user resizes before the SDK loads.
  const w = window.innerWidth
  const h = window.innerHeight
  const deviceType = w < 640 ? 'mobile' : w < 1024 ? 'tablet' : 'desktop'
  const pointer = window.matchMedia?.('(pointer: coarse)').matches ? 'coarse' : 'fine'
  const orientation = window.matchMedia?.('(orientation: portrait)').matches
    ? 'portrait'
    : 'landscape'
  const isPwa = window.matchMedia?.('(display-mode: standalone)').matches ?? false
  const url = new URL(window.location.href)
  const landingPath = url.pathname
  const landingReferrer = document.referrer || '(direct)'
  const landingUtmSource = url.searchParams.get('utm_source') ?? null
  const landingUtmMedium = url.searchParams.get('utm_medium') ?? null
  const landingUtmCampaign = url.searchParams.get('utm_campaign') ?? null

  enqueue((client) => {
    client.register({
      device_type: deviceType,
      pointer,
      orientation,
      is_pwa: isPwa,
      viewport_w: w,
      viewport_h: h,
    })
    client.register_once({
      landing_path: landingPath,
      landing_referrer: landingReferrer,
      landing_utm_source: landingUtmSource,
      landing_utm_medium: landingUtmMedium,
      landing_utm_campaign: landingUtmCampaign,
    })
  })
}

// Fire exactly once per distinct_id when the user crosses any meaningful
// engagement threshold (watched 30s / played a live note / started an
// export). Gives PostHog cohorts a single clean "real user" definition
// instead of OR-ing three events together on every query.
const ACTIVATED_KEY = 'midee.activated'
export function trackActivation(trigger: 'playback_30s' | 'live_note' | 'export_started'): void {
  // Dedupe synchronously against localStorage — we want this to no-op on the
  // 2nd-and-later calls regardless of whether the SDK has loaded yet.
  try {
    if (localStorage.getItem(ACTIVATED_KEY)) return
    localStorage.setItem(ACTIVATED_KEY, '1')
  } catch {
    // localStorage disabled (private mode / quota) — dedupe won't survive
    // reloads, but firing the event multiple times is still better than
    // missing it entirely.
  }
  enqueue((client) => client.capture('user_activated', { trigger }))
}

// Bucket MIDI device names into a short vendor enum. The raw device name
// can be unique per user (e.g. "Dev's Korg microKEY 25") — bad for
// cardinality and occasionally PII. Enum is stable, queryable, and
// covers the long tail with 'other'.
const MIDI_VENDORS = [
  'korg',
  'akai',
  'roland',
  'yamaha',
  'arturia',
  'novation',
  'nektar',
  'native instruments',
  'm-audio',
  'alesis',
  'casio',
  'presonus',
] as const
export function categorizeMidiDevice(name: string): string {
  const lower = name.toLowerCase()
  for (const v of MIDI_VENDORS) if (lower.includes(v)) return v
  return 'other'
}

// ── Typed event registry ──────────────────────────────────────────────────
// New code should emit events through `trackEvent` so the name and property
// shape stay in lockstep. Free-form `track()` stays for one-offs and legacy
// callsites during migration. Additive-only: removing an entry here is a
// breaking change for any PostHog dashboard keyed on it.

// Add new entries here only when wiring the firing site in the same change —
// a declared-but-never-fired event is dashboard debt. Planned-but-unwired
// events live in docs/LEARN_MODE_PLAN_V2.md until they're actually emitted.
type EventMap = {
  // Mode transitions
  play_mode_entered: { duration_s: number }
  live_mode_entered: { midi_connected: boolean }
  learn_mode_entered: { from: AppMode }

  // Exercise lifecycle
  exercise_started: {
    exercise_id: string
    category: string
    difficulty: string
  }
  exercise_completed: {
    exercise_id: string
    duration_s: number
    accuracy: number
    xp: number
    completed: boolean
  }
  exercise_abandoned: { exercise_id: string; duration_s: number }
}

export type EventName = keyof EventMap
export type EventProps<K extends EventName> = EventMap[K]

// Typed wrapper over `track`. A rename here cascades through TS rather than
// silently breaking a dashboard.
export function trackEvent<K extends EventName>(name: K, props: EventProps<K>): void {
  track(name, props as Record<string, unknown>)
}
