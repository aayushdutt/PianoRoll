import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from 'solid-js'
import { render } from 'solid-js/web'
import { watch } from '../../../store/watch'
import { icons } from '../../../ui/icons'
import type { PlayAlongEngine } from './engine'

// Streak ≥ this is "hot" — saturated chip background. Below is "warm"
// (visible but quieter). Below 1 the chip is hidden entirely.
const STREAK_HOT_THRESHOLD = 5

function fmtTime(t: number): string {
  const s = Math.max(0, Math.floor(t))
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${m}:${r < 10 ? '0' : ''}${r}`
}

const STORAGE_KEY_PIN = 'midee.learn.pa.pinned'
const STORAGE_KEY_OFFSET = 'midee.learn.pa.offset'

const PLAY_GLYPH =
  '<svg class="pa-hud__play-icon pa-hud__play-icon--play" viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><title>Play</title><path d="M4 3 L13 8 L4 13 Z"/></svg>'
const PAUSE_GLYPH =
  '<svg class="pa-hud__play-icon pa-hud__play-icon--pause" viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><title>Pause</title><rect x="4" y="3" width="3" height="10" rx="0.5"/><rect x="9" y="3" width="3" height="10" rx="0.5"/></svg>'
const LOOP_GLYPH =
  '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><title>Loop</title><path d="M3 8a5 5 0 0 1 8-4M13 8a5 5 0 0 1-8 4"/><path d="M11 2v3h-3M5 14v-3h3"/></svg>'
const CLOSE_X_GLYPH =
  '<svg viewBox="0 0 10 10" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><title>Close</title><path d="M2 2l6 6M8 2l-6 6"/></svg>'
const WAIT_GLYPH =
  '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><title>Wait</title><path d="M4 3h8M4 13h8M6 3c0 2 4 3 4 5s-4 3-4 5"/></svg>'
const RAMP_GLYPH =
  '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><title>Ramp</title><path d="M2 13 L14 3"/><path d="M9 3 L14 3 L14 8"/></svg>'

export interface PlayAlongHudOptions {
  engine: PlayAlongEngine
  onCloseExercise: () => void
  // One handler: drives the mark-style state machine (idle → A → B → clear).
  // Routed through the exercise so the keyboard shortcut and the button stay
  // in sync.
  onMarkLoop: () => void
  // Explicit clear (the small × that appears once a loop is active or
  // half-marked). Same outcome as a third onMarkLoop call but lets the user
  // bail out of a half-set state without making a second mark.
  onClearLoop: () => void
}

function loadPinned(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_PIN)
    return raw ? JSON.parse(raw) === true : false
  } catch {
    return false
  }
}

function loadOffset(): { x: number; y: number } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_OFFSET)
    if (!raw) return { x: 0, y: 0 }
    const parsed = JSON.parse(raw) as { x?: number; y?: number }
    return {
      x: typeof parsed.x === 'number' ? parsed.x : 0,
      y: typeof parsed.y === 'number' ? parsed.y : 0,
    }
  } catch {
    return { x: 0, y: 0 }
  }
}

// Always-visible score panel. The visual language follows §1 of the Learn
// plan ("whisper, don't shout"): muted chips, no flashes, only a tiny amber
// tint when streaks are alive. The breakdown trio (perfect/good/errors)
// disappears on narrow viewports — see `.pa-hud__stats` CSS.
function LiveStats(props: { engine: PlayAlongEngine }) {
  const { engine } = props
  // Memo on perfect/good/errors only — NOT heldTicks. heldTicks ticks 60×/sec
  // while the user holds a chord; pulling it into the HUD reactive path
  // would re-render the accuracy chip every frame for no visual change.
  const accuracyPct = createMemo(() => {
    const hits = engine.state.perfect + engine.state.good
    const attempts = hits + engine.state.errors
    return attempts === 0 ? 100 : Math.round((100 * hits) / attempts)
  })
  const streakHot = () => engine.state.streak >= STREAK_HOT_THRESHOLD
  const streakWarm = () => engine.state.streak >= 1 && engine.state.streak < STREAK_HOT_THRESHOLD
  return (
    <div class="pa-hud__stats" role="status" aria-label="Session score">
      <Show when={engine.state.streak > 0}>
        <span
          class="pa-hud__stat pa-hud__stat--streak"
          classList={{
            'pa-hud__stat--streak-warm': streakWarm(),
            'pa-hud__stat--streak-hot': streakHot(),
          }}
          data-tip="Consecutive cleared chords"
        >
          <span class="pa-hud__stat-glyph" aria-hidden="true">
            🔥
          </span>
          <span class="pa-hud__stat-num">{engine.state.streak}</span>
        </span>
      </Show>
      <span class="pa-hud__stat pa-hud__stat--accuracy" data-tip="Hits / (hits + errors)">
        <span class="pa-hud__stat-num">{accuracyPct()}</span>
        <span class="pa-hud__stat-unit">%</span>
      </span>
      <span class="pa-hud__stats-breakdown" aria-hidden="true">
        <span
          class="pa-hud__stat pa-hud__stat--perfect"
          classList={{ 'is-zero': engine.state.perfect === 0 }}
          data-tip="Perfect chord articulation (≤80 ms)"
        >
          <span class="pa-hud__stat-glyph">✓</span>
          <span class="pa-hud__stat-num">{engine.state.perfect}</span>
        </span>
        <span
          class="pa-hud__stat pa-hud__stat--good"
          classList={{ 'is-zero': engine.state.good === 0 }}
          data-tip="Cleared chord (slower articulation)"
        >
          <span class="pa-hud__stat-glyph">◌</span>
          <span class="pa-hud__stat-num">{engine.state.good}</span>
        </span>
        <span
          class="pa-hud__stat pa-hud__stat--error"
          classList={{ 'is-zero': engine.state.errors === 0 }}
          data-tip="Wrong-pitch press while waiting"
        >
          <span class="pa-hud__stat-glyph">×</span>
          <span class="pa-hud__stat-num">{engine.state.errors}</span>
        </span>
      </span>
    </div>
  )
}

function PlayAlongHudView(props: PlayAlongHudOptions) {
  const engine = props.engine

  // Drag + pin state. Local to component; persisted to localStorage as
  // side-effects when they change.
  const initialOffset = loadOffset()
  const [offsetX, setOffsetX] = createSignal(initialOffset.x)
  const [offsetY, setOffsetY] = createSignal(initialOffset.y)
  const [pinned, setPinned] = createSignal(loadPinned())
  const [dragging, setDragging] = createSignal(false)
  const [idle, setIdle] = createSignal(false)

  let rootEl!: HTMLDivElement
  let scrubberEl!: HTMLInputElement
  let timeEl!: HTMLSpanElement

  // Drag scratch state — captured at pointerdown, used during document
  // pointermove, cleared on pointerup. Module-local because the handlers
  // are bound on demand (not on mount).
  let dragStartX = 0
  let dragStartY = 0
  let dragOriginX = 0
  let dragOriginY = 0

  // Scrubber suppression flag: while the user is actively scrubbing, the
  // clock→scrubber binding must not clobber their drag.
  let scrubbing = false

  let idleTimer: ReturnType<typeof setTimeout> | null = null

  function clearIdleTimer(): void {
    if (idleTimer !== null) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
  }

  function scheduleIdleFade(): void {
    clearIdleTimer()
    if (pinned()) return
    idleTimer = setTimeout(() => {
      if (!pinned() && engine.state.userWantsToPlay) setIdle(true)
    }, 2600)
  }

  function wake(): void {
    setIdle(false)
    scheduleIdleFade()
  }

  onMount(() => {
    applyOffset()
    wake()
  })

  onCleanup(() => {
    clearIdleTimer()
    window.removeEventListener('resize', onWindowResize)
    document.removeEventListener('pointermove', onPointerMoveDoc)
    document.removeEventListener('pointerup', onPointerUpDoc)
  })

  // Wake on any transport state change so the icon update is visible
  // before the next idle fade. Equivalent to the old subscribe branch.
  onMount(() => {
    const stop = watch(
      () => engine.state.userWantsToPlay,
      () => wake(),
    )
    onCleanup(stop)
  })

  // Re-arm idle fade when pinned flips off; persist pinned on every flip.
  createEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY_PIN, JSON.stringify(pinned()))
    } catch {
      // Private mode — best effort.
    }
    if (!pinned()) scheduleIdleFade()
  })

  // Scrubber max reacts to duration change only (rare event).
  createEffect(() => {
    const d = engine.state.duration
    if (scrubberEl) scrubberEl.max = String(d || 1)
  })

  // Scrubber value + time label — driven by the 60 Hz MasterClock directly,
  // NOT through `engine.state.currentTime` (§2 rule 4). Reading a store field
  // that's written at 60 Hz re-fires every `createEffect` tracking it, which
  // is pure scheduler overhead since the DOM writes here are imperative.
  // @reactive-scrubber-forbidden — see docs/done/SOLID_MIGRATION_PLAN.md §2 rule 4
  const tickUnsub = engine.services.clock.subscribe((t) => {
    if (!scrubbing && scrubberEl) {
      scrubberEl.value = String(t)
      const pct = (t / (Number(scrubberEl.max) || 1)) * 100
      scrubberEl.style.setProperty('--pct', `${Math.max(0, Math.min(100, pct)).toFixed(1)}%`)
    }
    if (timeEl) timeEl.textContent = fmtTime(t)
  })
  onCleanup(tickUnsub)

  // Viewport clamp helpers.
  const onWindowResize = (): void => clampOffset()
  const onPointerMoveDoc = (e: PointerEvent): void => {
    if (!dragging()) return
    setOffsetX(dragOriginX + (e.clientX - dragStartX))
    setOffsetY(dragOriginY + (e.clientY - dragStartY))
    clampOffset()
  }
  const onPointerUpDoc = (): void => {
    if (!dragging()) return
    setDragging(false)
    document.removeEventListener('pointermove', onPointerMoveDoc)
    document.removeEventListener('pointerup', onPointerUpDoc)
    try {
      localStorage.setItem(STORAGE_KEY_OFFSET, JSON.stringify({ x: offsetX(), y: offsetY() }))
    } catch {
      // Private mode — best effort.
    }
  }

  onMount(() => {
    window.addEventListener('resize', onWindowResize)
  })

  function applyOffset(): void {
    if (!rootEl) return
    rootEl.style.setProperty('--hud-dx', `${offsetX()}px`)
    rootEl.style.setProperty('--hud-dy', `${offsetY()}px`)
  }

  createEffect(() => {
    offsetX()
    offsetY()
    applyOffset()
  })

  function clampOffset(): void {
    if (!rootEl) return
    const rect = rootEl.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) {
      applyOffset()
      return
    }
    const rootStyles = getComputedStyle(document.documentElement)
    const keyboardHeight = parseFloat(rootStyles.getPropertyValue('--keyboard-h')) || 120
    const hudGap = parseFloat(rootStyles.getPropertyValue('--hud-gap')) || 14
    const defaultLeft = (window.innerWidth - rect.width) / 2
    const defaultTop = window.innerHeight - keyboardHeight - hudGap - rect.height
    const minLeft = 12
    const maxLeft = Math.max(minLeft, window.innerWidth - rect.width - 12)
    const minTop = 80
    const maxTop = Math.max(minTop, window.innerHeight - keyboardHeight - rect.height - 12)
    const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))
    const nextLeft = clamp(defaultLeft + offsetX(), minLeft, maxLeft)
    const nextTop = clamp(defaultTop + offsetY(), minTop, maxTop)
    setOffsetX(nextLeft - defaultLeft)
    setOffsetY(nextTop - defaultTop)
  }

  function startDrag(e: PointerEvent): void {
    e.preventDefault()
    dragStartX = e.clientX
    dragStartY = e.clientY
    dragOriginX = offsetX()
    dragOriginY = offsetY()
    setDragging(true)
    document.addEventListener('pointermove', onPointerMoveDoc)
    document.addEventListener('pointerup', onPointerUpDoc)
  }

  function togglePin(): void {
    setPinned(!pinned())
    wake()
  }

  const isWaitOn = () => engine.practice.isEnabled
  const isRampOn = () => engine.state.tempoRampEnabled

  // Loop region overlay on the scrubber. Returns CSS custom props so the band
  // (filled segment between A and B) and the two tick markers can be drawn
  // via pseudo-elements without re-rendering on every clock tick — the
  // values only change on mark / clear.
  const loopBandStyle = createMemo<Record<string, string>>(() => {
    const dur = engine.state.duration
    if (dur <= 0) return {}
    const region = engine.state.loopRegion
    if (region) {
      const aPct = (region.start / dur) * 100
      const bPct = (region.end / dur) * 100
      return {
        '--loop-a-pct': `${aPct.toFixed(2)}%`,
        '--loop-b-pct': `${bPct.toFixed(2)}%`,
      }
    }
    const mark = engine.state.loopMark
    if (mark !== null) {
      const aPct = (mark / dur) * 100
      return { '--loop-a-pct': `${aPct.toFixed(2)}%` }
    }
    return {}
  })

  return (
    <div
      class="pa-hud"
      classList={{
        'pa-hud--dragging': dragging(),
        'pa-hud--pinned': pinned(),
        'pa-hud--idle': idle(),
      }}
      ref={rootEl}
      onPointerEnter={() => wake()}
      onPointerMove={() => wake()}
    >
      <div class="pa-hud__handle">
        <button
          class="hud-drag-handle pa-hud__drag"
          type="button"
          aria-label="Drag to move"
          data-tip="Drag to move"
          onPointerDown={(e) => startDrag(e)}
          innerHTML={icons.grip(10)}
        />
        <button
          class="hud-pin-btn pa-hud__pin"
          classList={{ 'hud-pin-btn--on': pinned() }}
          type="button"
          aria-label="Pin in place"
          data-tip="Pin · keep from auto-hiding"
          onClick={() => togglePin()}
          innerHTML={icons.pin(12)}
        />
      </div>

      <div class="pa-hud__transport">
        <button
          class="pa-hud__play"
          classList={{ 'is-playing': engine.state.userWantsToPlay }}
          type="button"
          aria-label={engine.state.userWantsToPlay ? 'Pause' : 'Play'}
          data-tip="Play / pause (Space)"
          onClick={() => engine.togglePlay()}
          innerHTML={engine.state.userWantsToPlay ? PAUSE_GLYPH : PLAY_GLYPH}
        />
        <div class="pa-hud__scrub">
          <span class="pa-hud__time" ref={timeEl}>
            0:00
          </span>
          <div
            class="pa-hud__scrubber-wrap"
            classList={{
              'pa-hud__scrubber-wrap--loop': engine.state.loopRegion !== null,
              'pa-hud__scrubber-wrap--mark':
                engine.state.loopRegion === null && engine.state.loopMark !== null,
            }}
            style={loopBandStyle()}
          >
            <input
              class="pa-hud__scrubber"
              ref={scrubberEl}
              type="range"
              min="0"
              max="1"
              step="0.01"
              value="0"
              aria-label="Scrubber"
              data-tip="Drag to seek"
              onPointerDown={() => {
                scrubbing = true
              }}
              onInput={(e) => {
                const el = e.currentTarget
                const pct = (Number(el.value) / (Number(el.max) || 1)) * 100
                el.style.setProperty('--pct', `${pct.toFixed(1)}%`)
                engine.seek(Number(el.value))
              }}
              onPointerUp={() => {
                scrubbing = false
              }}
              onPointerCancel={() => {
                scrubbing = false
              }}
              onChange={() => {
                scrubbing = false
              }}
            />
          </div>
          <span class="pa-hud__time pa-hud__time--muted">{fmtTime(engine.state.duration)}</span>
        </div>
      </div>

      <div class="pa-hud__meta">
        <LiveStats engine={engine} />
        <button
          class="pa-hud__icon-btn pa-hud__close"
          type="button"
          aria-label="Back to learn hub"
          data-tip="Back to hub (Esc)"
          onClick={() => props.onCloseExercise()}
          innerHTML={icons.close(14)}
        />
      </div>

      <div class="pa-hud__options">
        <fieldset class="pa-hud__segmented" aria-label="Speed">
          <span class="pa-hud__seg-label">Speed</span>
          <div class="pa-hud__seg-track">
            {[60, 80, 100].map((pct) => (
              <button
                class="pa-hud__seg"
                classList={{ 'is-active': engine.state.speedPct === pct }}
                type="button"
                data-tip={
                  pct === 60 ? 'Slow · 60% ([)' : pct === 80 ? 'Medium · 80%' : 'Full · 100% (])'
                }
                aria-label={`${pct}% speed`}
                onClick={() => engine.setSpeedPreset(pct)}
              >
                {pct}
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset class="pa-hud__segmented" aria-label="Hands">
          <span class="pa-hud__seg-label">Hands</span>
          <div class="pa-hud__seg-track">
            {(['left', 'right', 'both'] as const).map((h) => (
              <button
                class="pa-hud__seg"
                classList={{ 'is-active': engine.state.hand === h }}
                type="button"
                data-tip={
                  h === 'left' ? 'Left hand only' : h === 'right' ? 'Right hand only' : 'Both hands'
                }
                aria-label={h === 'both' ? 'Both hands' : `${h === 'left' ? 'Left' : 'Right'} hand`}
                onClick={() => engine.setHand(h)}
              >
                {h === 'left' ? 'L' : h === 'right' ? 'R' : 'Both'}
              </button>
            ))}
          </div>
        </fieldset>

        <div
          class="pa-hud__loop"
          classList={{
            'pa-hud__loop--on': engine.state.loopRegion !== null,
            'pa-hud__loop--mark': engine.state.loopMark !== null,
          }}
        >
          <button
            class="pa-hud__pill pa-hud__pill--loop"
            type="button"
            data-tip={
              engine.state.loopRegion
                ? 'Clear loop (L)'
                : engine.state.loopMark !== null
                  ? 'Mark loop end (L)'
                  : 'Mark loop start (L)'
            }
            aria-label={
              engine.state.loopRegion
                ? 'Clear loop'
                : engine.state.loopMark !== null
                  ? 'Mark loop end'
                  : 'Mark loop start'
            }
            aria-pressed={engine.state.loopRegion !== null}
            onClick={() => props.onMarkLoop()}
          >
            <span innerHTML={LOOP_GLYPH} />
            <span>
              <Show
                when={engine.state.loopRegion}
                fallback={engine.state.loopMark !== null ? 'Mark B' : 'Loop'}
              >
                Loop
              </Show>
            </span>
            <Show when={engine.state.loopRegion}>
              {(region) => (
                <span class="pa-hud__pill-sub">
                  · {(region().end - region().start).toFixed(1)}s
                </span>
              )}
            </Show>
          </button>
          <Show when={engine.state.loopRegion !== null || engine.state.loopMark !== null}>
            <button
              class="pa-hud__loop-clear"
              type="button"
              data-tip="Clear loop"
              aria-label="Clear loop"
              onClick={() => props.onClearLoop()}
              innerHTML={CLOSE_X_GLYPH}
            />
          </Show>
        </div>

        <button
          class="pa-hud__pill"
          type="button"
          aria-pressed={isWaitOn()}
          data-tip="Wait mode · pauses at each chord"
          aria-label="Toggle wait mode"
          onClick={() => engine.setWaitEnabled(!isWaitOn())}
        >
          <span innerHTML={WAIT_GLYPH} />
          <span>Wait</span>
        </button>
        <button
          class="pa-hud__pill"
          type="button"
          aria-pressed={isRampOn()}
          data-tip="Auto-speed · ramps up on clean passes"
          aria-label="Toggle tempo ramp"
          onClick={() => engine.setTempoRamp(!isRampOn())}
        >
          <span innerHTML={RAMP_GLYPH} />
          <span>Ramp</span>
        </button>
      </div>
    </div>
  )
}

export class PlayAlongHud {
  private dispose: (() => void) | null = null
  private wrapper: HTMLDivElement | null = null

  constructor(private opts: PlayAlongHudOptions) {}

  mount(host: HTMLElement): void {
    this.unmount()
    const wrapper = document.createElement('div')
    host.appendChild(wrapper)
    this.wrapper = wrapper
    this.dispose = render(() => <PlayAlongHudView {...this.opts} />, wrapper)
  }

  unmount(): void {
    this.dispose?.()
    this.dispose = null
    this.wrapper?.remove()
    this.wrapper = null
  }
}
