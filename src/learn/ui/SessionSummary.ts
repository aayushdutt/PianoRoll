import type { ExerciseResult } from '../core/Result'

// Quiet end-of-session surface. Slides up from the bottom, displays accuracy
// + XP + streak-extended hint (if applicable), gives Again / Next buttons,
// then fades itself after a timeout. Deliberately not a modal — it doesn't
// block interaction and doesn't steal focus.
export interface SessionSummaryOptions {
  onAgain: () => void
  onNext: () => void
  // Auto-fade delay in ms. 0 disables auto-fade (user has to click). Default
  // 4000 matches the v2 plan.
  autoFadeMs?: number
}

export class SessionSummary {
  private root: HTMLDivElement | null = null
  private fadeTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private opts: SessionSummaryOptions) {}

  show(
    host: HTMLElement,
    result: ExerciseResult,
    extras: { streakExtended: boolean; xpGained: number },
  ): void {
    this.dismiss()
    const accuracyPct = Math.round(result.accuracy * 100)
    const el = document.createElement('div')
    el.className = 'session-summary'
    el.setAttribute('role', 'status')
    el.innerHTML = `
      <div class="session-summary__row">
        <div class="session-summary__metric">
          <span class="session-summary__value">${accuracyPct}%</span>
          <span class="session-summary__label">accuracy</span>
        </div>
        <div class="session-summary__metric">
          <span class="session-summary__value">+${extras.xpGained}</span>
          <span class="session-summary__label">xp</span>
        </div>
        ${
          extras.streakExtended
            ? '<div class="session-summary__metric session-summary__metric--streak"><span class="session-summary__value">streak +1</span></div>'
            : ''
        }
        <div class="session-summary__actions">
          <button class="session-summary__btn" data-again type="button">Again</button>
          <button class="session-summary__btn session-summary__btn--primary" data-next type="button">Next</button>
        </div>
      </div>
    `
    host.appendChild(el)
    this.root = el

    el.querySelector<HTMLButtonElement>('[data-again]')?.addEventListener('click', () => {
      this.dismiss()
      this.opts.onAgain()
    })
    el.querySelector<HTMLButtonElement>('[data-next]')?.addEventListener('click', () => {
      this.dismiss()
      this.opts.onNext()
    })

    const fade = this.opts.autoFadeMs ?? 4000
    if (fade > 0) {
      // Use a single timeout — the ":fading" class is what actually animates
      // the opacity down via CSS transition; after the transition the element
      // removes itself.
      this.fadeTimer = setTimeout(() => this.dismiss(), fade)
    }
  }

  dismiss(): void {
    if (this.fadeTimer !== null) {
      clearTimeout(this.fadeTimer)
      this.fadeTimer = null
    }
    this.root?.remove()
    this.root = null
  }
}
