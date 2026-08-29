import { createMemo, For } from 'solid-js'
import { t } from '../../i18n'
import type { LearnProgressStore } from '../core/progress'
import { isoDay } from '../core/progress-actions'

const WINDOW_DAYS = 14

function fillsAt(key: string, lastDay: string, days: number): boolean {
  if (days <= 0) return false
  if (key > lastDay) return false
  const parse = (d: string) => {
    const [y, m, day] = d.split('-').map(Number)
    return new Date(y!, m! - 1, day!, 12, 0, 0)
  }
  const delta = Math.round((parse(lastDay).getTime() - parse(key).getTime()) / 86_400_000)
  return delta >= 0 && delta < days
}

export function StreakRowView(props: { progress: LearnProgressStore }) {
  const days = () => props.progress.state.streak.days
  const lastDay = () => props.progress.state.streak.lastDay

  const dots = createMemo(() => {
    const today = new Date()
    const todayKey = isoDay(today)
    const result: { key: string; filled: boolean; isToday: boolean }[] = []
    for (let i = WINDOW_DAYS - 1; i >= 0; i--) {
      const d = new Date(today)
      d.setDate(d.getDate() - i)
      const key = isoDay(d)
      const isToday = key === todayKey
      const filled = lastDay() !== '' && fillsAt(key, lastDay(), days())
      result.push({ key, filled, isToday })
    }
    return result
  })

  return (
    <div class="streak-row" data-tip={t('learn.streak.tip')}>
      <span class="streak-row__flame" aria-hidden="true">
        <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
          <path d="M8 1c1 2 3 3 3 6 0 2-1.3 3.5-3 3.5-2 0-3-1.5-3-3.5 0-1 .5-1.5 1-2 .5 1 1 1.5 2-.5-1-1.5 0-2.5 0-3.5z" />
        </svg>
      </span>
      <span class="streak-row__count">{days()}</span>
      <span class="streak-row__label">{t('learn.streak.label')}</span>
      <span class="streak-row__dots" aria-hidden="true">
        <For each={dots()}>
          {(dot) => (
            <span
              class={`streak-dot${dot.filled ? ' streak-dot--filled' : ''}${dot.isToday ? ' streak-dot--today' : ''}`}
              title={dot.key}
            />
          )}
        </For>
      </span>
    </div>
  )
}
