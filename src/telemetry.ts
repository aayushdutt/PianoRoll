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

// Drain any calls made while the SDK was still loading. Order matters -
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

// High-frequency controls (volume/speed/zoom/bpm sliders) would otherwise fire
// one event per tick of a drag. Coalesce per event name: only the final value
// after the user stops moving is sent. Keyed by event name, so distinct
// controls don't cancel each other.
const settleTimers = new Map<string, ReturnType<typeof setTimeout>>()
export function trackSettled(event: string, properties: Record<string, unknown>, ms = 600): void {
  const prev = settleTimers.get(event)
  if (prev) clearTimeout(prev)
  settleTimers.set(
    event,
    setTimeout(() => {
      settleTimers.delete(event)
      track(event, properties)
    }, ms),
  )
}

// ── midi_loaded / midi_load_failed normalisation ───────────────────────────
// midi_loaded fires from 4 call sites (play file/sample, learn file/sample)
// that historically diverged in shape. Funnel them through one helper so every
// dashboard sees the same keys. `note_count` is the content signal that lets
// us tie which pieces drive retention; nullable fields are always present so
// the schema never varies.
export function trackMidiLoaded(p: {
  source: 'drag' | 'picker' | 'sample' | 'recent'
  target?: 'play' | 'learn'
  trackCount: number
  noteCount: number
  durationS: number
  fileSizeKb?: number | null
  sampleId?: string | null
}): void {
  track('midi_loaded', {
    source: p.source,
    target: p.target ?? 'play',
    track_count: p.trackCount,
    note_count: p.noteCount,
    duration_s: p.durationS,
    file_size_kb: p.fileSizeKb ?? null,
    sample_id: p.sampleId ?? null,
  })
}

export type MidiLoadErrorType = 'empty' | 'not_midi' | 'parse'

// Classify a load failure so we can see WHICH files break — today every
// failure is bucketed 'parse', so we're blind to the cause. Sniffs the header:
// a real Standard MIDI File starts with the magic bytes 'MThd'; a non-MIDI
// file dropped in (mp3, musicxml, …) is the common real-world case.
export async function midiLoadErrorType(err: unknown, file: File): Promise<MidiLoadErrorType> {
  if (err instanceof Error && err.name === 'EmptyMidiError') return 'empty'
  try {
    const head = new Uint8Array(await file.slice(0, 4).arrayBuffer())
    if (String.fromCharCode(...head) !== 'MThd') return 'not_midi'
  } catch {
    // Couldn't read the slice — fall through to the generic bucket.
  }
  return 'parse'
}

export function trackMidiLoadFailed(p: {
  source: string
  target?: 'play' | 'learn'
  errorType: MidiLoadErrorType
  fileExt?: string | null
  fileSizeKb?: number | null
}): void {
  track('midi_load_failed', {
    source: p.source,
    target: p.target ?? 'play',
    error_type: p.errorType,
    file_ext: p.fileExt ?? null,
    file_size_kb: p.fileSizeKb ?? null,
  })
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

// ── Export crash forensics ─────────────────────────────────────────────────
// A tiny in-flight marker persisted during export and cleared on any handled
// terminal event (completed / failed / cancelled). If it's still present on
// the next boot, the export died unhandled — OOM, tab kill, browser crash -
// and we fire `export_interrupted` with the last known stage/pct.

const EXPORT_INFLIGHT_KEY = 'midee.export.inflight'

export interface ExportInflightMarker {
  stage: string
  pct: number
  output: string
  resolution: string
  fps: number
  ts: number
}

export function markExportInflight(marker: ExportInflightMarker): void {
  try {
    localStorage.setItem(EXPORT_INFLIGHT_KEY, JSON.stringify(marker))
  } catch {
    // localStorage unavailable — forensics degrade silently, export unaffected.
  }
}

export function clearExportInflight(): void {
  try {
    localStorage.removeItem(EXPORT_INFLIGHT_KEY)
  } catch {
    // ignore
  }
}

// Call once at boot. Returns the stale marker (and clears it) if the previous
// session died mid-export; the caller fires the typed event.
export function consumeInterruptedExport(): ExportInflightMarker | null {
  try {
    const raw = localStorage.getItem(EXPORT_INFLIGHT_KEY)
    if (!raw) return null
    localStorage.removeItem(EXPORT_INFLIGHT_KEY)
    const parsed = JSON.parse(raw) as ExportInflightMarker
    if (typeof parsed.stage !== 'string' || typeof parsed.pct !== 'number') return null
    return parsed
  } catch {
    return null
  }
}

// ── Typed event registry ──────────────────────────────────────────────────
// New code should emit events through `trackEvent` so the name and property
// shape stay in lockstep. Free-form `track()` stays for one-offs and legacy
// callsites during migration. Additive-only: removing an entry here is a
// breaking change for any PostHog dashboard keyed on it.

// Add new entries here only when wiring the firing site in the same change -
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
  // What the user chose at the post-exercise summary — the practice-retention
  // loop. 'dismissed' is the auto-fade / no-action path (see SessionSummary).
  exercise_summary_action: {
    exercise_id: string
    action: 'again' | 'next' | 'dismissed'
  }

  // Feedback portal (self-hosted Fider) outbound clicks. `source` identifies
  // which surface drove the click.
  feedback_clicked: { source: 'customize_menu' | 'post_session' }

  // Transport / playback controls. seeked fires on commit (not per scrub
  // frame); the slider-driven *_changed events fire via trackEventSettled so a
  // single drag yields one event with the final value.
  seeked: { from_s: number; to_s: number; method: 'scrub' | 'skip' }
  playback_paused: { position_s: number; position_pct: number }
  speed_changed: { speed: number }
  volume_changed: { volume: number }
  zoom_changed: { zoom: number }
  tempo_changed: { bpm: number }
  // Playback transpose in semitones (-12..12). Settled like the other
  // *_changed controls: the HUD stepper is click-repeatable, so a walk from
  // 0 to +5 should report one event carrying +5, not five events.
  transpose_changed: { semitones: number }
  metronome_toggled: { on: boolean }

  // Customization. `method` distinguishes the topbar cycle button from a menu
  // pick. `theme` is the display name (kept for existing filters); `theme_id`
  // is the stable persisted id.
  theme_changed: { theme: string; theme_id: string; method: 'cycle' | 'menu' }
  particle_changed: { style: string; method: 'cycle' | 'menu' }
  instrument_changed: { from: string | undefined; to: string; method: 'cycle' | 'menu' }
  // Live commands, split by how they were invoked. The Shift+letter shortcuts
  // and the HUD buttons call the same handlers, so nothing previously recorded
  // which one people actually use — the question that decides whether the
  // Shift command layer is worth keeping.
  live_action: {
    action: 'record' | 'loop_toggle' | 'loop_undo' | 'loop_clear' | 'metronome'
    method: 'shortcut' | 'button'
  }
  track_toggled: { enabled: boolean }

  // One per parsed user file: what the source actually contains versus what
  // midee currently models. Answers "how common are out-of-range pitches,
  // pedalled files, and tempo maps in real uploads?" — the counters that
  // prioritise the MIDI-fidelity work (docs/MIDI_FIDELITY_PLAN_2026-08-30.md).
  midi_parse_quality: {
    target: 'play' | 'learn'
    out_of_range_notes: number
    has_sustain_pedal: boolean
    tempo_events: number
  }

  // Previously-silent failure paths now surfaced as first-class events.
  synth_load_failed: { source: string }
  sample_load_failed: { sample_id: string; target: 'play' | 'learn' }
  // A recent card was clicked but the stored bytes were gone or unparseable —
  // the entry is dropped, so this is the only trace it ever existed.
  recent_load_failed: { target: 'play' | 'learn' }
  // A non-fatal export degradation: audio render failed but the (video-only /
  // av) export continued without sound. Distinct from export_failed.
  export_degraded: { stage: 'audio_render'; output: string }
  // Mid-export hardware-encoder failure recovered by the software retry
  // (see VideoExporter's codec plan ladder). High volume here = a platform
  // where 'prefer-hardware' probes pass but the encoder dies at runtime.
  export_fallback: {
    from_codec: string
    to_codec: string
    error_name: string
    output: string
    resolution: string
    fps: number
  }
  // An export that started but never reached completed/failed/cancelled -
  // detected on the NEXT boot via the localStorage in-flight marker below.
  // This is the OOM / tab-kill bucket that used to be invisible (~7% of
  // export_started had no terminal event).
  export_interrupted: {
    stage: string
    pct: number
    output: string
    resolution: string
    fps: number
    age_s: number
  }
}

export type EventName = keyof EventMap
export type EventProps<K extends EventName> = EventMap[K]

// Typed wrapper over `track`. A rename here cascades through TS rather than
// silently breaking a dashboard.
export function trackEvent<K extends EventName>(name: K, props: EventProps<K>): void {
  track(name, props as Record<string, unknown>)
}

// Typed + coalesced. For high-frequency controls whose name/shape should still
// stay in lockstep with EventMap. See trackSettled for the debounce semantics.
export function trackEventSettled<K extends EventName>(
  name: K,
  props: EventProps<K>,
  ms = 600,
): void {
  trackSettled(name, props as Record<string, unknown>, ms)
}
