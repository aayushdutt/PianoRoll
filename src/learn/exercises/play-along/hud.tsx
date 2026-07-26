import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from 'solid-js'
import { t } from '../../../i18n'
import { watch } from '../../../store/watch'
import { FloatingHud } from '../../../ui/FloatingHud'
import { createMountHandle } from '../../ui/mountComponent'
import { DEFAULT_SPEED_PRESETS, type PlayAlongEngine } from './engine'

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
  onMarkLoop: () => void
  onClearLoop: () => void
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
    </div>
  )
}

function PlayAlongHudView(props: PlayAlongHudOptions) {
  const engine = props.engine

  let scrubberEl!: HTMLInputElement
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
      scrubberEl.style.setProperty('--pct', `${Math.max(0, Math.min(100, pct)).toFixed(1)}%`)
    }
    if (timeEl) timeEl.textContent = fmtTime(t)
  })
  onCleanup(tickUnsub)

  const isWaitOn = () => engine.practice.isEnabled
  const isRampOn = () => engine.state.tempoRampEnabled

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
    <FloatingHud
      class="pa-hud"
      storageKey="midee.learn.pa"
      idleEnabled={() => engine.state.userWantsToPlay}
      collapsed={collapsed}
      onClose={() => setCollapsed(true)}
      onReopen={() => setCollapsed(false)}
      collapsedContent={
        <span class="pa-hud__mini">
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
                aria-label={t('learn.pa.scrubAria')}
                data-tip={t('learn.pa.scrubTip')}
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
        </div>

        <div class="pa-hud__options">
          <fieldset class="pa-hud__segmented" aria-label={t('learn.pa.speedAria')}>
            <span class="pa-hud__seg-label">{t('learn.pa.speedLabel')}</span>
            <div class="pa-hud__seg-track">
              {DEFAULT_SPEED_PRESETS.map((pct) => (
                <button
                  class="pa-hud__seg"
                  classList={{ 'is-active': engine.state.speedPct === pct }}
                  type="button"
                  data-tip={
                    pct === 60
                      ? t('learn.pa.speedSlowTip')
                      : pct === 80
                        ? t('learn.pa.speedMedTip')
                        : t('learn.pa.speedFullTip')
                  }
                  aria-label={t('learn.pa.speedPctAria', { pct })}
                  onClick={() => engine.setSpeedPreset(pct)}
                >
                  {pct}
                </button>
              ))}
            </div>
          </fieldset>

          {/* Left/right-hand filtering is a piano concept (which hand plays
              which track) with no guitar equivalent — hide it while the
              guitar surface is the active visualization. */}
          <Show when={engine.services.store.effectiveVisualizationMode !== 'guitar'}>
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
          </Show>

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
                  ? t('learn.pa.loopClearTip')
                  : engine.state.loopMark !== null
                    ? t('learn.pa.loopMarkBTip')
                    : t('learn.pa.loopMarkATip')
              }
              aria-label={
                engine.state.loopRegion
                  ? t('learn.pa.loopClearAria')
                  : engine.state.loopMark !== null
                    ? t('learn.pa.loopMarkBAria')
                    : t('learn.pa.loopMarkAAria')
              }
              aria-pressed={engine.state.loopRegion !== null}
              onClick={() => props.onMarkLoop()}
            >
              <span innerHTML={LOOP_GLYPH} />
              <span>
                <Show
                  when={engine.state.loopRegion}
                  fallback={
                    engine.state.loopMark !== null
                      ? t('learn.pa.loopMarkBLabel')
                      : t('learn.pa.loopLabel')
                  }
                >
                  {t('learn.pa.loopLabel')}
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
                data-tip={t('learn.pa.loopXClear')}
                aria-label={t('learn.pa.loopXClear')}
                onClick={() => props.onClearLoop()}
                innerHTML={CLOSE_X_GLYPH}
              />
            </Show>
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
          <button
            class="pa-hud__pill"
            type="button"
            aria-pressed={isRampOn()}
            data-tip={t('learn.pa.rampTip')}
            aria-label={t('learn.pa.rampAria')}
            onClick={() => engine.setTempoRamp(!isRampOn())}
          >
            <span innerHTML={RAMP_GLYPH} />
            <span>{t('learn.pa.rampLabel')}</span>
          </button>
        </div>
      </div>
    </FloatingHud>
  )
}

export function createPlayAlongHud() {
  return createMountHandle(PlayAlongHudView)
}
