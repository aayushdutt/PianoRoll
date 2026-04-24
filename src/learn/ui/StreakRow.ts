import type { LearnProgressStore } from '../core/progress'
import { isoDay } from '../core/progress-actions'

// 14-day streak visualization. Each dot represents a day; filled dots mark
// days the user crossed the "practiced today" threshold. Today's slot is the
// rightmost — designed to read as progress marching toward the right rather
// than a historical chart.
//
// The row is a pure view over LearnProgressStore. It doesn't animate or
// celebrate crossings — the `progress felt, not announced` principle means
// the row just quietly fills in on the user's next glance.
const WINDOW_DAYS = 14

export class StreakRow {
  private root: HTMLDivElement | null = null
  private daysLabel: HTMLElement | null = null
  private dotsEl: HTMLElement | null = null
  private unsub: (() => void) | null = null

  constructor(private progress: LearnProgressStore) {}

  mount(container: HTMLElement): void {
    if (this.root) return
    const el = document.createElement('div')
    el.className = 'streak-row'
    el.setAttribute('data-tip', 'Practice streak · last 14 days')
    el.innerHTML = `
      <span class="streak-row__flame" aria-hidden="true">
        <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M8 1c1 2 3 3 3 6 0 2-1.3 3.5-3 3.5-2 0-3-1.5-3-3.5 0-1 .5-1.5 1-2 .5 1 1 1.5 2-.5-1-1.5 0-2.5 0-3.5z"/></svg>
      </span>
      <span class="streak-row__count" data-streak-count>0</span>
      <span class="streak-row__label">day streak</span>
      <span class="streak-row__dots" data-streak-dots aria-hidden="true"></span>
    `
    container.appendChild(el)
    this.root = el
    this.daysLabel = el.querySelector<HTMLElement>('[data-streak-count]')!
    this.dotsEl = el.querySelector<HTMLElement>('[data-streak-dots]')!
    this.render()
    // Rerender on any progress change — the store publishes a single signal
    // for every write, so streak bumps / XP commits / settings flips all
    // land here. Cheap enough to redraw the whole row.
    this.unsub = this.progress.state.subscribe(() => this.render())
  }

  unmount(): void {
    this.unsub?.()
    this.unsub = null
    this.root?.remove()
    this.root = null
    this.daysLabel = null
    this.dotsEl = null
  }

  private render(): void {
    if (!this.daysLabel || !this.dotsEl) return
    const { days, lastDay } = this.progress.state.value.streak
    this.daysLabel.textContent = String(days)
    // Build the 14-day window ending today so "today" is always the last
    // dot — makes the row read like a timeline rather than a scoreboard.
    const today = new Date()
    const todayKey = isoDay(today)
    const html: string[] = []
    for (let i = WINDOW_DAYS - 1; i >= 0; i--) {
      const d = new Date(today)
      d.setDate(d.getDate() - i)
      const key = isoDay(d)
      const isToday = key === todayKey
      // A day is filled if it falls inside the current contiguous run. We
      // approximate by filling `days` slots backward from lastDay — accurate
      // for contiguous streaks (which is the only kind we track).
      const filled = lastDay !== '' && this.fillsAt(key, lastDay, days)
      const cls = [
        'streak-dot',
        filled ? 'streak-dot--filled' : '',
        isToday ? 'streak-dot--today' : '',
      ]
        .filter(Boolean)
        .join(' ')
      html.push(`<span class="${cls}" title="${key}"></span>`)
    }
    this.dotsEl.innerHTML = html.join('')
  }

  // Does `key` fall inside the `days`-long contiguous run ending at `lastDay`?
  private fillsAt(key: string, lastDay: string, days: number): boolean {
    if (days <= 0) return false
    if (key > lastDay) return false
    // Distance in days between key and lastDay — if that distance < days,
    // the slot is inside the run.
    const parse = (d: string) => {
      const [y, m, day] = d.split('-').map(Number)
      return new Date(y!, m! - 1, day!, 12, 0, 0)
    }
    const delta = Math.round((parse(lastDay).getTime() - parse(key).getTime()) / 86_400_000)
    return delta >= 0 && delta < days
  }
}
