import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from 'solid-js'
import { t } from '../../../i18n'
import { watch } from '../../../store/watch'
import { formatSpeed } from '../../../ui/ControlsView'
import { FloatingHud } from '../../../ui/FloatingHud'
import { createMountHandle } from '../../ui/mountComponent'
import { cycleSpeedPreset, type PlayAlongEngine } from './engine'

// Streak ≥ this is "hot" — saturated chip background. Below is "warm"
// (visible but quieter). Below 1 the chip is hidden entirely.
const STREAK_HOT_THRESHOLD = 5

// Hits / (hits + errors), as a whole percent. 100 when nothing attempted yet.
export function playAlongAccuracy(engine: PlayAlongEngine): number {
  const hits = engine.state.perfect + engine.state.good
  const attempts = hits + engine.state.errors
  return attempts === 0 ? 100 : Math.round((100 * hits) / attempts)
}

function fmtTime(t: number): string {
  const s = Math.max(0, Math.floor(t))
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${m}:${r < 10 ? '0' : ''}${r}`
}

const PLAY_GLYPH =
  '<svg class="pa-hud__play-icon pa-hud__play-icon--play" viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M4 3 L13 8 L4 13 Z"/></svg>'
const PAUSE_GLYPH =
  '<svg class="pa-hud__play-icon pa-hud__play-icon--pause" viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><rect x="4" y="3" width="3" height="10" rx="0.5"/><rect x="9" y="3" width="3" height="10" rx="0.5"/></svg>'
const LOOP_GLYPH =
  '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8a5 5 0 0 1 8-4M13 8a5 5 0 0 1-8 4"/><path d="M11 2v3h-3M5 14v-3h3"/></svg>'
const RESTART_GLYPH =
  '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.6-3.7"/><path d="M13 2v3h-3"/></svg>'
const WAIT_GLYPH =
  '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 3h8M4 13h8M6 3c0 2 4 3 4 5s-4 3-4 5"/></svg>'

export interface PlayAlongHudOptions {
  engine: PlayAlongEngine
  onToggleLoop: () => void
}

// Always-visible score panel.
function LiveStats(props: { engine: PlayAlongEngine }) {
  const { engine } = props
  const accuracyPct = createMemo(() => playAlongAccuracy(engine))
  const streakHot = () => engine.state.streak >= STREAK_HOT_THRESHOLD
  const streakWarm = () => engine.state.streak >= 1 && engine.state.streak < STREAK_HOT_THRESHOLD
  return (
    <div class="pa-hud__stats" role="status" aria-label={t('learn.pa.score')}>
      <Show when={engine.state.streak > 0}>
        <span
          class="pa-hud__stat pa-hud__stat--streak"
          classList={{
            'pa-hud__stat--streak-warm': streakWarm(),
            'pa-hud__stat--streak-hot': streakHot(),
          }}
          data-tip={t('learn.pa.streak.tip')}
        >
          <span class="pa-hud__stat-glyph" aria-hidden="true">
            🔥
          </span>
          <span class="pa-hud__stat-num">{engine.state.streak}</span>
        </span>
      </Show>
      <span class="pa-hud__stat pa-hud__stat--accuracy" data-tip={t('learn.pa.accuracy.tip')}>
        <span class="pa-hud__stat-num">{accuracyPct()}</span>
        <span class="pa-hud__stat-unit">%</span>
      </span>
      {/* Hidden until something lands, the same rule the streak chip follows.
          At the start of a session three zeros are pure noise, and the mobile
          breakpoint already drops this block entirely. */}
      <Show when={engine.state.perfect + engine.state.good + engine.state.errors > 0}>
        <span class="pa-hud__stats-breakdown" aria-hidden="true">
          <span
            class="pa-hud__stat pa-hud__stat--perfect"
            classList={{ 'is-zero': engine.state.perfect === 0 }}
            data-tip={t('learn.pa.perfect.tip')}
          >
            <span class="pa-hud__stat-glyph">✓</span>
            <span class="pa-hud__stat-num">{engine.state.perfect}</span>
          </span>
          <span
            class="pa-hud__stat pa-hud__stat--good"
            classList={{ 'is-zero': engine.state.good === 0 }}
            data-tip={t('learn.pa.good.tip')}
          >
            <span class="pa-hud__stat-glyph">◌</span>
            <span class="pa-hud__stat-num">{engine.state.good}</span>
          </span>
          <span
            class="pa-hud__stat pa-hud__stat--error"
            classList={{ 'is-zero': engine.state.errors === 0 }}
            data-tip={t('learn.pa.error.tip')}
          >
            <span class="pa-hud__stat-glyph">×</span>
            <span class="pa-hud__stat-num">{engine.state.errors}</span>
          </span>
        </span>
      </Show>
    </div>
  )
}

function PlayAlongHudView(props: PlayAlongHudOptions) {
  const engine = props.engine

  let scrubberEl!: HTMLInputElement
  let wrapEl!: HTMLDivElement
  let timeEl!: HTMLSpanElement

  let scrubbing = false

  // Wake the HUD out of idle whenever transport state changes.
  let hudWake: (() => void) | null = null

  // Session-only collapse to a small draggable icon (same as the main HUD).
  const [collapsed, setCollapsed] = createSignal(false)

  onMount(() => {
    const stop = watch(
      () => engine.state.userWantsToPlay,
      () => hudWake?.(),
    )
    onCleanup(stop)
  })

  // Scrubber max reacts to duration change only (rare event).
  createEffect(() => {
    const d = engine.state.duration
    if (scrubberEl) scrubberEl.max = String(d || 1)
  })

  // Scrubber value + time label driven by 60 Hz MasterClock directly.
  // @reactive-scrubber-forbidden — see docs/done/SOLID_MIGRATION_PLAN.md §2 rule 4
  const tickUnsub = engine.services.clock.subscribe((t) => {
    if (!scrubbing && scrubberEl) {
      scrubberEl.value = String(t)
      const pct = (t / (Number(scrubberEl.max) || 1)) * 100
      // Set --pct on the WRAP, not the input: custom properties inherit
      // downward, so the input's track gradient still resolves it, and the loop
      // overlay (a sibling of the input) can read it too. That is what lets the
      // pending B edge track the playhead live while you hunt for the end.
      wrapEl?.style.setProperty('--pct', `${Math.max(0, Math.min(100, pct)).toFixed(1)}%`)
    }
    if (timeEl) timeEl.textContent = fmtTime(t)
  })
  onCleanup(tickUnsub)

  const isWaitOn = () => engine.practice.isEnabled

  const loopBandStyle = createMemo<Record<string, string>>(() => {
    const dur = engine.state.duration
    const region = engine.state.loopRegion
    if (dur <= 0 || !region) return {}
    return {
      '--loop-a-pct': `${((region.start / dur) * 100).toFixed(2)}%`,
      '--loop-b-pct': `${((region.end / dur) * 100).toFixed(2)}%`,
    }
  })

  // Set while a drag is live so an unmount mid-gesture can tear it down.
  let endDrag: (() => void) | null = null
  onCleanup(() => endDrag?.())

  // Drag a bracket handle. Pointer capture on the handle means the gesture
  // survives leaving the 4px track, and stopping propagation keeps the range
  // input underneath from treating the same press as a seek.
  function startEdgeDrag(edge: 'start' | 'end', e: PointerEvent): void {
    e.preventDefault()
    e.stopPropagation()
    const handle = e.currentTarget as HTMLElement
    handle.setPointerCapture?.(e.pointerId)
    engine.beginLoopEdit()

    const move = (ev: PointerEvent): void => {
      const rect = wrapEl.getBoundingClientRect()
      if (rect.width <= 0) return
      const ratio = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width))
      const next = engine.setLoopEdge(edge, ratio * engine.state.duration)
      // Follow the edge with the playhead so the roll shows the music you are
      // trimming to. Without this the screen never changes and you are placing
      // an edge blind.
      if (next) engine.seek(edge === 'start' ? next.start : next.end)
    }
    const up = (ev: PointerEvent): void => {
      // Teardown FIRST. releasePointerCapture throws when the pointer is no
      // longer active — which is exactly what `pointercancel` means — and a
      // throw here would strand the pointermove listener on window and leave
      // editingLoop true, silently killing loop wrapping for the session.
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      endDrag = null
      try {
        handle.releasePointerCapture?.(ev.pointerId)
      } catch {
        // Pointer already gone; capture released itself.
      }
      // Re-arms wrapping and pulls the playhead back inside the region — the
      // end handle deliberately parks it ON the boundary while dragging.
      engine.endLoopEdit()
    }
    endDrag = () => up(e)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  return (
    <FloatingHud
      class="pa-hud"
      storageKey="midee.learn.pa"
      idleEnabled={() => engine.state.userWantsToPlay}
      collapsed={collapsed}
      onClose={() => setCollapsed(true)}
      onReopen={() => setCollapsed(false)}
      collapsedContent={
        <span class="pa-hud__mini">
          {/* The pill is a drag handle whose tap reopens the HUD, so this
              button has to claim its own pointerdown or dragging the HUD by it
              would either fail to drag or fire a restart on release. */}
          <button
            class="pa-hud__mini-restart"
            type="button"
            data-tip={t('learn.pa.restartTip')}
            aria-label={t('learn.pa.restartAria')}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              engine.restart()
            }}
            innerHTML={RESTART_GLYPH}
          />
          <Show when={engine.state.streak > 0}>
            <span
              class="pa-hud__mini-streak"
              classList={{
                'pa-hud__mini-streak--hot': engine.state.streak >= STREAK_HOT_THRESHOLD,
              }}
            >
              <span aria-hidden="true">🔥</span>
              {engine.state.streak}
            </span>
          </Show>
          <span class="pa-hud__mini-acc">{playAlongAccuracy(engine)}%</span>
        </span>
      }
      wakeRef={(fn) => {
        hudWake = fn
      }}
    >
      <div class="pa-hud__body">
        <div class="pa-hud__transport">
          <button
            class="pa-hud__restart"
            type="button"
            data-tip={t('learn.pa.restartTip')}
            aria-label={t('learn.pa.restartAria')}
            onClick={() => engine.restart()}
            innerHTML={RESTART_GLYPH}
          />
          <button
            class="pa-hud__play"
            classList={{ 'is-playing': engine.state.userWantsToPlay }}
            type="button"
            aria-label={
              engine.state.userWantsToPlay ? t('learn.pa.pauseAria') : t('learn.pa.playAria')
            }
            data-tip={t('learn.pa.playTip')}
            onClick={() => engine.togglePlay()}
            innerHTML={engine.state.userWantsToPlay ? PAUSE_GLYPH : PLAY_GLYPH}
          />
          <div class="pa-hud__scrub">
            <span class="pa-hud__time" ref={timeEl}>
              0:00
            </span>
            <div
              class="pa-hud__scrubber-wrap"
              ref={wrapEl}
              classList={{
                'pa-hud__scrubber-wrap--loop': engine.state.loopRegion !== null,
              }}
              style={loopBandStyle()}
            >
              {/* Loop overlay. Everything outside the region is shaded down so
                  the looped span is the only lit part of the bar, and the two
                  brackets are draggable — trimming, rather than catching two
                  moments as the music runs. */}
              <Show when={engine.state.loopRegion !== null}>
                <button
                  type="button"
                  class="pa-hud__loop-handle pa-hud__loop-handle--start"
                  aria-label={t('learn.pa.loopStartAria')}
                  onPointerDown={(e) => startEdgeDrag('start', e)}
                />
                <button
                  type="button"
                  class="pa-hud__loop-handle pa-hud__loop-handle--end"
                  aria-label={t('learn.pa.loopEndAria')}
                  onPointerDown={(e) => startEdgeDrag('end', e)}
                />
              </Show>
              <input
                class="pa-hud__scrubber"
                ref={scrubberEl}
                type="range"
                min="0"
                max="1"
                step="0.01"
                value="0"
                aria-label={t('learn.pa.scrubAria')}
                data-tip={t('learn.pa.scrubTip')}
                onPointerDown={() => {
                  scrubbing = true
                }}
                onInput={(e) => {
                  const el = e.currentTarget
                  const pct = (Number(el.value) / (Number(el.max) || 1)) * 100
                  wrapEl?.style.setProperty('--pct', `${pct.toFixed(1)}%`)
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
        </div>

        <div class="pa-hud__options">
          {/* Same idea as the play-mode HUD chip: one control that cycles the
              presets, instead of three buttons of which two are always dead
              weight. Shift reverses, which also covers the keyboard since Enter
              on a focused button carries the modifier. */}
          <span class="pa-hud__seg-label">{t('learn.pa.speedLabel')}</span>
          <button
            class="pa-hud__speed-chip"
            type="button"
            classList={{ 'is-off': engine.state.speedPct !== 100 }}
            data-tip={t('learn.pa.speedCycleTip')}
            aria-label={t('learn.pa.speedCycleAria', {
              speed: formatSpeed(engine.state.speedPct / 100),
            })}
            onClick={(e) =>
              engine.setSpeedPreset(cycleSpeedPreset(engine.state.speedPct, e.shiftKey ? -1 : 1))
            }
          >
            {formatSpeed(engine.state.speedPct / 100)}
          </button>

          <fieldset class="pa-hud__segmented" aria-label={t('learn.pa.handsAria')}>
            <span class="pa-hud__seg-label">{t('learn.pa.handsLabel')}</span>
            <div class="pa-hud__seg-track">
              {(['left', 'right', 'both'] as const).map((h) => (
                <button
                  class="pa-hud__seg"
                  classList={{ 'is-active': engine.state.hand === h }}
                  type="button"
                  data-tip={
                    h === 'left'
                      ? t('learn.pa.handLeftTip')
                      : h === 'right'
                        ? t('learn.pa.handRightTip')
                        : t('learn.pa.handBothTip')
                  }
                  aria-label={
                    h === 'both'
                      ? t('learn.pa.handBothAria')
                      : h === 'left'
                        ? t('learn.pa.handLeftAria')
                        : t('learn.pa.handRightAria')
                  }
                  onClick={() => engine.setHand(h)}
                >
                  {h === 'left'
                    ? t('learn.pa.handLeftLabel')
                    : h === 'right'
                      ? t('learn.pa.handRightLabel')
                      : t('learn.pa.handBothLabel')}
                </button>
              ))}
            </div>
          </fieldset>

          <div
            class="pa-hud__loop"
            classList={{ 'pa-hud__loop--on': engine.state.loopRegion !== null }}
          >
            {/* Two states, not three: the loop is either off or on. Turning it
                on seeds a region you then trim with the bracket handles, so the
                button never has to describe a half-finished marking sequence. */}
            <button
              class="pa-hud__pill pa-hud__pill--loop"
              type="button"
              data-tip={
                engine.state.loopRegion ? t('learn.pa.loopClearTip') : t('learn.pa.loopOnTip')
              }
              aria-label={
                engine.state.loopRegion ? t('learn.pa.loopClearAria') : t('learn.pa.loopOnAria')
              }
              aria-pressed={engine.state.loopRegion !== null}
              onClick={() => props.onToggleLoop()}
            >
              <span innerHTML={LOOP_GLYPH} />
              <span>
                <Show when={engine.state.loopRegion} fallback={t('learn.pa.loopLabel')}>
                  {t('learn.pa.loopClearLabel')}
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
          </div>

          <button
            class="pa-hud__pill"
            type="button"
            aria-pressed={isWaitOn()}
            data-tip={t('learn.pa.waitTip')}
            aria-label={t('learn.pa.waitAria')}
            onClick={() => engine.setWaitEnabled(!isWaitOn())}
          >
            <span innerHTML={WAIT_GLYPH} />
            <span>{t('learn.pa.waitLabel')}</span>
          </button>
        </div>
      </div>
    </FloatingHud>
  )
}

export function createPlayAlongHud() {
  return createMountHandle(PlayAlongHudView)
}
