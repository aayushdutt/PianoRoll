import { icons } from '../../../ui/icons'
import type { IntervalsEngine } from './engine'
import { getInterval, getIntervalsByIds } from './theory'

// Card UI for the Intervals quiz. Single centered card — no piano roll behind
// it, no moveable panel. Ear training benefits from a focused, quiet surface
// so the user's attention stays on the sound. Reuses design tokens from the
// Learn hub (hero-card, pill buttons) so the visual language is consistent.

export interface IntervalsUiOptions {
  engine: IntervalsEngine
  answerSet: readonly string[]
  onCloseExercise: () => void
  // Fired whenever the user chooses. The controller uses this to flash the
  // shared overlay (celebrationSwell on hit, no-op on miss — the UI itself
  // renders the miss feedback inline).
  onAnswered?: (correct: boolean) => void
  // Fired once at the end so the LearnController can transition into the
  // session summary. The card itself stays mounted until `unmount()`.
  onFinished?: () => void
}

export class IntervalsUi {
  private root: HTMLDivElement | null = null
  private unsubs: Array<() => void> = []

  constructor(private opts: IntervalsUiOptions) {}

  mount(host: HTMLElement): void {
    if (this.root) return
    const el = document.createElement('div')
    el.className = 'iv-card'
    el.innerHTML = `
      <header class="iv-card__head">
        <div class="iv-card__crumb">
          <span class="iv-card__kicker">Ear training</span>
          <h2 class="iv-card__title">Intervals</h2>
        </div>
        <button class="iv-card__close" data-close type="button"
                aria-label="Back to learn hub" data-tip="Back to hub (Esc)">
          ${icons.close(14)}
        </button>
      </header>

      <div class="iv-card__progress" data-progress>
        <div class="iv-card__progress-track"><div class="iv-card__progress-fill" data-progress-fill></div></div>
        <div class="iv-card__progress-meta">
          <span data-qcount></span>
          <span class="iv-card__streak" data-streak-row></span>
        </div>
      </div>

      <div class="iv-card__body">
        <div class="iv-card__prompt">
          <span class="iv-card__prompt-label">Listen</span>
          <p class="iv-card__prompt-hint" data-hint>Press play to hear two notes — pick the interval you just heard.</p>
        </div>
        <button class="iv-card__listen" data-listen type="button"
                aria-label="Play interval" data-tip="Play again (Space)">
          <span class="iv-card__listen-glyph" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M7 5 L19 12 L7 19 Z"/></svg>
          </span>
          <span class="iv-card__listen-label" data-listen-label>Play interval</span>
        </button>

        <div class="iv-card__answers" data-answers role="group" aria-label="Choose an interval"></div>

        <div class="iv-card__feedback" data-feedback hidden>
          <div class="iv-card__feedback-row">
            <span class="iv-card__feedback-badge" data-fb-badge></span>
            <span class="iv-card__feedback-copy" data-fb-copy></span>
          </div>
          <div class="iv-card__feedback-actions">
            <button class="iv-card__ghost" data-fb-replay type="button"
                    aria-label="Hear the interval again" data-tip="Hear again">
              <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8a5 5 0 1 1 2 4"/><path d="M3 12v-4h4"/></svg>
              <span>Replay</span>
            </button>
            <button class="iv-card__next" data-fb-next type="button">
              <span data-fb-next-label>Next</span>
              <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3l5 5-5 5"/></svg>
            </button>
          </div>
        </div>
      </div>

      <footer class="iv-card__foot">
        <div class="iv-card__score">
          <span data-hits>0</span>
          <span class="iv-card__score-sep">/</span>
          <span data-total>0</span>
        </div>
        <div class="iv-card__hint-row">
          <kbd>Space</kbd><span>replay</span>
          <kbd>1-4</kbd><span>pick answer</span>
        </div>
      </footer>
    `
    host.appendChild(el)
    this.root = el
    this.renderAnswers()
    this.bindEvents()
    this.bindState()
    // First question kicks off immediately — users expect audio on launch.
    // Slight delay so the overlay render + audio-context prime have a frame
    // to land before the first notes fire.
    window.setTimeout(() => this.opts.engine.playCurrent(), 120)
  }

  unmount(): void {
    for (const off of this.unsubs) off()
    this.unsubs = []
    this.root?.remove()
    this.root = null
  }

  private renderAnswers(): void {
    const el = this.root
    if (!el) return
    const host = el.querySelector<HTMLElement>('[data-answers]')
    if (!host) return
    host.innerHTML = ''
    const intervals = getIntervalsByIds(this.opts.answerSet)
    intervals.forEach((interval, idx) => {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'iv-answer'
      btn.dataset['answer'] = interval.id
      btn.setAttribute('data-tip', `${interval.full} · press ${idx + 1}`)
      btn.innerHTML = `
        <span class="iv-answer__short">${interval.short}</span>
        <span class="iv-answer__full">${interval.full}</span>
      `
      btn.addEventListener('click', () => this.onPick(interval.id))
      host.appendChild(btn)
    })
  }

  private bindEvents(): void {
    const el = this.root!
    el.querySelector<HTMLButtonElement>('[data-close]')?.addEventListener('click', () =>
      this.opts.onCloseExercise(),
    )
    el.querySelector<HTMLButtonElement>('[data-listen]')?.addEventListener('click', () =>
      this.opts.engine.playCurrent(),
    )
    el.querySelector<HTMLButtonElement>('[data-fb-replay]')?.addEventListener('click', () =>
      this.opts.engine.playCurrent(),
    )
    el.querySelector<HTMLButtonElement>('[data-fb-next]')?.addEventListener('click', () =>
      this.onNext(),
    )
  }

  private bindState(): void {
    const { engine } = this.opts
    const el = this.root!
    this.unsubs.push(
      engine.phase.subscribe((phase) => {
        el.dataset['phase'] = phase
        if (phase === 'done') this.opts.onFinished?.()
      }),
      engine.index.subscribe(() => this.renderProgress()),
      engine.questions.subscribe(() => this.renderProgress()),
      engine.hits.subscribe((n) => this.setScore('hits', n)),
      engine.misses.subscribe(() => {
        this.setScore('total', engine.hits.value + engine.misses.value)
      }),
      engine.streak.subscribe((n) => this.renderStreak(n)),
      engine.feedback.subscribe((fb) => this.renderFeedback(fb)),
    )
    this.renderProgress()
    this.setScore('hits', engine.hits.value)
    this.setScore('total', engine.hits.value + engine.misses.value)
    this.renderStreak(engine.streak.value)
  }

  private onPick(intervalId: string): void {
    const fb = this.opts.engine.answer(intervalId)
    if (fb) this.opts.onAnswered?.(fb.correct)
  }

  private onNext(): void {
    this.opts.engine.next()
    // The phase subscription will flip the card back into question mode.
    // Auto-play the next question's audio so the user isn't stranded at a
    // silent card.
    if (this.opts.engine.phase.value === 'question') {
      window.setTimeout(() => this.opts.engine.playCurrent(), 140)
    }
  }

  private renderProgress(): void {
    const el = this.root
    if (!el) return
    const { engine } = this.opts
    const total = engine.questions.value.length
    const idx = engine.index.value
    const qEl = el.querySelector<HTMLElement>('[data-qcount]')
    if (qEl) qEl.textContent = total > 0 ? `Question ${idx + 1} of ${total}` : 'Preparing…'
    const fill = el.querySelector<HTMLElement>('[data-progress-fill]')
    if (fill) {
      const pct = total > 0 ? (idx / total) * 100 : 0
      fill.style.setProperty('--pct', `${pct}%`)
    }
  }

  private setScore(which: 'hits' | 'total', n: number): void {
    const el = this.root
    if (!el) return
    const target = el.querySelector<HTMLElement>(`[data-${which}]`)
    if (target) target.textContent = String(n)
  }

  private renderStreak(n: number): void {
    const el = this.root
    if (!el) return
    const row = el.querySelector<HTMLElement>('[data-streak-row]')
    if (!row) return
    // Fire emoji is intentional — this is a game surface, and the streak
    // cue reads as a reward, not a notification. Keep it.
    row.textContent = n >= 2 ? `🔥 ${n} in a row` : ''
  }

  private renderFeedback(fb: { correct: boolean; picked: string; answer: string } | null): void {
    const el = this.root
    if (!el) return
    const box = el.querySelector<HTMLElement>('[data-feedback]')
    const badge = el.querySelector<HTMLElement>('[data-fb-badge]')
    const copy = el.querySelector<HTMLElement>('[data-fb-copy]')
    const nextLabel = el.querySelector<HTMLElement>('[data-fb-next-label]')
    if (!box || !badge || !copy || !nextLabel) return

    // Paint answer buttons according to the outcome so the user immediately
    // sees the right answer highlighted alongside their own pick.
    for (const btn of el.querySelectorAll<HTMLButtonElement>('.iv-answer')) {
      btn.classList.remove('iv-answer--correct', 'iv-answer--wrong')
      if (!fb) continue
      if (btn.dataset['answer'] === fb.answer) btn.classList.add('iv-answer--correct')
      else if (btn.dataset['answer'] === fb.picked && !fb.correct)
        btn.classList.add('iv-answer--wrong')
    }

    if (!fb) {
      box.setAttribute('hidden', '')
      return
    }
    box.removeAttribute('hidden')
    badge.classList.toggle('iv-card__feedback-badge--ok', fb.correct)
    badge.classList.toggle('iv-card__feedback-badge--miss', !fb.correct)
    badge.textContent = fb.correct ? 'Correct' : 'Miss'
    const answerInterval = getInterval(fb.answer)
    const answerName = answerInterval?.full ?? fb.answer
    copy.textContent = fb.correct ? `${answerName} — nice ear.` : `It was ${answerName}.`

    const lastQuestion =
      this.opts.engine.index.value === this.opts.engine.questions.value.length - 1
    nextLabel.textContent = lastQuestion ? 'Finish' : 'Next'
  }
}
