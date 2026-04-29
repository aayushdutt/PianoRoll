// SolidJS HUD for the sight-reading exercise.
// - SrControlBar: persistent glass bar above the keyboard, idles to 28% opacity
// - EndPanel: result card when phase is 'complete' or 'knockedOut'

import { createMemo, createSignal, For, Show } from 'solid-js'
import { render } from 'solid-js/web'
import { t } from '../../../i18n'
import { FloatingHud } from '../../../ui/FloatingHud'
import { icons } from '../../../ui/icons'
import { accuracy, computeXp } from '../../core/scoring'
import type { SightReadingEngine } from './engine'
import { gradeFromAccuracy, KNOCKOUT_THRESHOLD } from './engine'
import { noteNameInKey } from './music'
import type { ClefMode, TierConfig } from './types'

export interface SightReadHudOptions {
  engine: SightReadingEngine
  tier: TierConfig
  onPlayAgain: () => void
  onPracticeWeak: (pitches: number[]) => void
  onClose: () => void
  onRestart: () => void
  onClefChange: (clef: ClefMode) => void
}

function clefLabel(clef: ClefMode): string {
  switch (clef) {
    case 'treble':
      return t('learn.sr.clefTreble')
    case 'bass':
      return t('learn.sr.clefBass')
    case 'both':
      return t('learn.sr.clefBoth')
  }
}

const CLEF_ORDER: ClefMode[] = ['treble', 'bass', 'both']

// ── Grade colours ────────────────────────────────────────────────────────────

const GRADE_COLOR: Record<'S' | 'A' | 'B' | 'C' | 'D', string> = {
  S: '#f5c842',
  A: '#50c878',
  B: '#4a9eff',
  C: '#ff8c42',
  D: '#dc4646',
}

// ── Weak-note computation ────────────────────────────────────────────────────

interface WeakNote {
  midi: number
  name: string
  missRate: number
}

function computeWeakNotes(engine: SightReadingEngine, keySignature: string): WeakNote[] {
  const results: WeakNote[] = []
  for (const [midi, { hits, misses }] of engine.noteStats) {
    const total = hits + misses
    if (total >= 5 && misses > 0) {
      results.push({
        midi,
        name: noteNameInKey(midi, keySignature),
        missRate: misses / total,
      })
    }
  }
  return results.sort((a, b) => b.missRate - a.missRate).slice(0, 3)
}

// ── Control bar ──────────────────────────────────────────────────────────────

function SrControlBar(props: SightReadHudOptions) {
  const { engine } = props

  const [clef, setClef] = createSignal<ClefMode>(props.tier.clef)

  const cycleClef = () => {
    const idx = CLEF_ORDER.indexOf(clef())
    const next = CLEF_ORDER[(idx + 1) % CLEF_ORDER.length]!
    setClef(next)
    props.onClefChange(next)
  }

  const accuracyPct = createMemo(() => {
    const { perfect, good, missed } = engine.state
    const total = perfect + good + missed
    if (total < 5) return null
    return Math.round((100 * (perfect + good)) / total)
  })

  const streakClass = createMemo(() => {
    const s = engine.state.streak
    if (s >= 10) return 'sr-hud__streak sr-hud__streak--hot'
    if (s >= 5) return 'sr-hud__streak sr-hud__streak--warm'
    return 'sr-hud__streak'
  })

  const livesLeft = createMemo(() => KNOCKOUT_THRESHOLD - engine.state.consecutiveMisses)
  const lifeDots = createMemo(() =>
    Array.from({ length: KNOCKOUT_THRESHOLD }, (_, i) => i < livesLeft()),
  )

  const bpmRounded = createMemo(() => Math.round(engine.state.bpm))
  const gapLabel = createMemo(() => `${engine.state.noteGap.toFixed(1)}×`)

  const onBpmWheel = (e: WheelEvent) => {
    e.preventDefault()
    const step = e.shiftKey ? 5 : 1
    engine.setBpm(engine.bpm + (e.deltaY < 0 ? step : -step))
  }

  return (
    <FloatingHud class="sr-hud" storageKey="midee.learn.sr" idleMs={2600}>
      {/* Streak — hidden at 0 */}
      <Show when={engine.state.streak > 0}>
        <span class={streakClass()}>
          <Show when={engine.state.streak >= 5}>
            <span aria-hidden="true">🔥</span>
          </Show>
          <span>{engine.state.streak}</span>
        </span>
        <div class="sr-hud__sep" />
      </Show>

      {/* Lives dots */}
      <div class="sr-hud__lives" role="status">
        <span class="sr-visually-hidden">{livesLeft()} lives remaining</span>
        <For each={lifeDots()}>
          {(alive) => (
            <span
              aria-hidden="true"
              class={alive ? 'sr-hud__dot' : 'sr-hud__dot sr-hud__dot--spent'}
            />
          )}
        </For>
      </div>

      <div class="sr-hud__sep" />

      {/* Pause / Resume */}
      <button
        type="button"
        class="sr-hud__pause-btn"
        classList={{ 'sr-hud__pause-btn--paused': engine.state.paused }}
        aria-label={engine.state.paused ? t('learn.sr.resumeAria') : t('learn.sr.pause')}
        data-tip={engine.state.paused ? t('learn.sr.resumeTip') : t('learn.sr.pauseTip')}
        onClick={() => (engine.state.paused ? engine.resume() : engine.pause())}
        innerHTML={engine.state.paused ? icons.play(14) : icons.pause(14)}
      />

      <div class="sr-hud__sep" />

      {/* Clef selector — cycles Treble → Bass → Both */}
      <button
        type="button"
        class="sr-hud__clef-btn"
        aria-label={t('learn.sr.clefAria', {
          clef: clefLabel(clef()),
        })}
        data-tip={t('learn.sr.clefTip', { clef: clefLabel(clef()) })}
        onClick={cycleClef}
      >
        <span class="sr-hud__clef-icon" aria-hidden="true">
          {clef() === 'treble' ? '𝄞' : clef() === 'bass' ? '𝄢' : '𝄞𝄢'}
        </span>
        <span class="sr-hud__clef-label">{clefLabel(clef())}</span>
      </button>

      <div class="sr-hud__sep" />

      {/* BPM control */}
      <div class="sr-hud__bpm-pill" onWheel={onBpmWheel}>
        <button
          type="button"
          class="sr-hud__bpm-step"
          aria-label={t('learn.sr.bpmDecAria')}
          data-tip={t('learn.sr.bpmDecTip')}
          onClick={() => engine.setBpm(engine.bpm - 5)}
        >
          −
        </button>
        <span class="sr-hud__bpm-val" data-tip={t('learn.sr.bpmTip')}>
          {bpmRounded()}
        </span>
        <button
          type="button"
          class="sr-hud__bpm-step"
          aria-label={t('learn.sr.bpmIncAria')}
          data-tip={t('learn.sr.bpmIncTip')}
          onClick={() => engine.setBpm(engine.bpm + 5)}
        >
          +
        </button>
      </div>

      <div class="sr-hud__sep" />

      {/* Note gap slider */}
      <div class="sr-hud__gap">
        <span class="sr-hud__gap-icon" aria-hidden="true" innerHTML={icons.sparkles(12)} />
        <input
          type="range"
          class="mini-slider sr-hud__gap-slider"
          min="0.3"
          max="2.5"
          step="0.1"
          value={engine.state.noteGap}
          style={{
            '--pct': `${((engine.state.noteGap - 0.3) / (2.5 - 0.3)) * 100}%`,
          }}
          aria-label={t('learn.sr.gapAria')}
          data-tip={t('learn.sr.gapTip')}
          onInput={(e) => engine.setNoteGap(parseFloat(e.currentTarget.value))}
        />
        <span class="sr-hud__gap-val" data-tip={t('learn.sr.gapTip')}>
          {gapLabel()}
        </span>
      </div>

      <div class="sr-hud__sep" />

      {/* Ramp toggle */}
      <button
        type="button"
        class="sr-hud__ramp-btn"
        classList={{ 'sr-hud__ramp-btn--on': engine.state.rampEnabled }}
        aria-label={t('learn.sr.rampAria')}
        data-tip={engine.state.rampEnabled ? t('learn.sr.rampOnTip') : t('learn.sr.rampOffTip')}
        onClick={() => engine.setRamp(!engine.state.rampEnabled)}
      >
        <span class="sr-hud__ramp-icon" aria-hidden="true">
          ↗
        </span>
        <span class="sr-hud__ramp-label">{t('learn.sr.rampLabel')}</span>
      </button>

      <div class="sr-hud__sep" />

      {/* Accuracy */}
      <span class="sr-hud__acc" data-tip={t('learn.sr.accuracyTip')}>
        {accuracyPct() !== null ? `${accuracyPct()}%` : '—'}
      </span>

      <div class="sr-hud__sep" />

      {/* Restart */}
      <button
        type="button"
        class="sr-hud__restart-btn"
        aria-label={t('learn.sr.restartAria')}
        data-tip={t('learn.sr.restartTip')}
        onClick={props.onRestart}
        innerHTML={icons.undo(13)}
      />

      <div class="sr-hud__sep" />

      {/* Close */}
      <button
        type="button"
        class="sr-hud__close"
        aria-label={t('learn.sr.closeAria')}
        data-tip={t('learn.sr.closeTip')}
        onClick={props.onClose}
        innerHTML={icons.close(13)}
      />
    </FloatingHud>
  )
}

// ── End panel ────────────────────────────────────────────────────────────────

function EndPanel(props: SightReadHudOptions) {
  const { engine } = props
  const isKnockedOut = () => engine.state.phase === 'knockedOut'

  const acc = createMemo(() => {
    const { perfect, good, missed } = engine.state
    const total = perfect + good + missed
    if (total === 0) return null
    return accuracy(perfect + good, total)
  })

  const grade = createMemo(() => (acc() !== null ? gradeFromAccuracy(acc()!) : null))
  const gradeColor = createMemo(() => (grade() ? GRADE_COLOR[grade()!] : 'rgba(255,255,255,0.25)'))
  const xp = createMemo(() =>
    acc() !== null ? computeXp({ accuracy: acc()!, duration_s: 60, difficultyWeight: 1.0 }) : 0,
  )
  const weakNotes = createMemo(() => computeWeakNotes(engine, props.tier.keySignature))

  const subtitle = createMemo(() => {
    if (isKnockedOut()) return t('learn.sr.end.knockedOut')
    if (engine.state.totalPlayed < 3) return t('learn.sr.end.notEnough')
    return t('learn.sr.end.complete')
  })

  return (
    <div class="sr-end">
      <div class="sr-end__card">
        {/* Grade */}
        <div class="sr-end__grade-block">
          <div
            class="sr-end__grade"
            style={{
              color: gradeColor(),
              'text-shadow': `0 0 40px ${gradeColor()}55`,
            }}
          >
            {grade() ?? '—'}
          </div>
          <div class="sr-end__subtitle">{subtitle()}</div>
        </div>

        {/* Stats row */}
        <div class="sr-end__stats">
          <div class="sr-end__stat sr-end__stat--perfect">
            <span class="sr-end__stat-glyph">✓</span>
            <span class="sr-end__stat-num">{engine.state.perfect}</span>
            <span class="sr-end__stat-label">{t('learn.sr.end.perfect')}</span>
          </div>
          <div class="sr-end__stat sr-end__stat--good">
            <span class="sr-end__stat-glyph">◌</span>
            <span class="sr-end__stat-num">{engine.state.good}</span>
            <span class="sr-end__stat-label">{t('learn.sr.end.good')}</span>
          </div>
          <div class="sr-end__stat sr-end__stat--miss">
            <span class="sr-end__stat-glyph">✗</span>
            <span class="sr-end__stat-num">{engine.state.missed}</span>
            <span class="sr-end__stat-label">{t('learn.sr.end.missed')}</span>
          </div>
          <div class="sr-end__stat">
            <span class="sr-end__stat-glyph">↑</span>
            <span class="sr-end__stat-num">{engine.state.bestStreak}</span>
            <span class="sr-end__stat-label">{t('learn.sr.end.bestStreak')}</span>
          </div>
        </div>

        {/* XP badge */}
        <Show when={xp() > 0}>
          <div class="sr-end__xp">{t('learn.sr.end.xp', { xp: xp() })}</div>
        </Show>

        {/* Weak notes */}
        <Show when={weakNotes().length > 0}>
          <div class="sr-end__weak">
            {t('learn.sr.end.troubleWith')}{' '}
            <span class="sr-end__weak-notes">
              {weakNotes()
                .map((w) => w.name)
                .join(', ')}
            </span>
          </div>
        </Show>

        {/* CTAs */}
        <div class="sr-end__actions">
          <button
            type="button"
            class="sr-end__btn sr-end__btn--primary"
            onClick={props.onPlayAgain}
          >
            {t('learn.sr.end.playAgain')}
          </button>
          <Show when={weakNotes().length > 0}>
            <button
              type="button"
              class="sr-end__btn sr-end__btn--secondary"
              onClick={() => props.onPracticeWeak(weakNotes().map((w) => w.midi))}
            >
              {t('learn.sr.end.practiceWeak')}
            </button>
          </Show>
          <button type="button" class="sr-end__btn sr-end__btn--ghost" onClick={props.onClose}>
            {t('learn.sr.end.backToHub')}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Root component ───────────────────────────────────────────────────────────

function SightReadHudRoot(props: SightReadHudOptions) {
  const phase = () => props.engine.state.phase
  const isActive = () => phase() === 'playing'
  const isDone = () => phase() === 'knockedOut' || phase() === 'complete'

  return (
    <>
      <Show when={isActive()}>
        <SrControlBar {...props} />
      </Show>
      <Show when={isDone()}>
        <EndPanel {...props} />
      </Show>
    </>
  )
}

// ── Public class ─────────────────────────────────────────────────────────────

export class SightReadHud {
  private dispose: (() => void) | null = null
  private container: HTMLDivElement | null = null

  mount(host: HTMLElement, opts: SightReadHudOptions): void {
    const div = document.createElement('div')
    div.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:10'
    host.appendChild(div)
    this.container = div
    this.dispose = render(() => <SightReadHudRoot {...opts} />, div)
  }

  unmount(): void {
    this.dispose?.()
    this.container?.remove()
    this.dispose = null
    this.container = null
  }
}
