import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { LearnProgressStore } from './progress'
import type { ExerciseResult } from './Result'

// Node test env has no DOM; give just enough Storage for jsonPersisted to land.
function installLocalStorageShim(): () => void {
  const data = new Map<string, string>()
  const shim: Storage = {
    get length() {
      return data.size
    },
    clear: () => data.clear(),
    getItem: (k) => (data.has(k) ? data.get(k)! : null),
    key: (i) => Array.from(data.keys())[i] ?? null,
    removeItem: (k) => {
      data.delete(k)
    },
    setItem: (k, v) => {
      data.set(k, String(v))
    },
  }
  const prev = (globalThis as { localStorage?: Storage }).localStorage
  ;(globalThis as { localStorage?: Storage }).localStorage = shim
  return () => {
    if (prev === undefined) delete (globalThis as { localStorage?: Storage }).localStorage
    else (globalThis as { localStorage?: Storage }).localStorage = prev
  }
}

function result(overrides: Partial<ExerciseResult> = {}): ExerciseResult {
  return {
    exerciseId: 'play-along',
    duration_s: 120,
    accuracy: 0.88,
    xp: 20,
    weakSpots: [],
    completed: true,
    ...overrides,
  }
}

describe('LearnProgressStore', () => {
  let uninstall: () => void
  beforeAll(() => {
    uninstall = installLocalStorageShim()
  })
  afterAll(() => {
    uninstall()
  })
  beforeEach(() => {
    localStorage.clear()
  })

  it('exposes sensible defaults on a fresh install', () => {
    const store = new LearnProgressStore(() => '2026-04-23')
    expect(store.streakDays).toBe(0)
    expect(store.xp).toBe(0)
    expect(store.settings.handColor).toBe('pitch-split')
    expect(store.settings.showScoreCounter).toBe(false)
  })

  it('persists commits across a fresh store instance', () => {
    const a = new LearnProgressStore(() => '2026-04-23')
    a.commit(result({ xp: 50 }))
    const b = new LearnProgressStore(() => '2026-04-23')
    expect(b.xp).toBe(50)
    expect(b.streakDays).toBe(1)
  })

  it('notifies subscribers on commit', () => {
    // UI components (streak row, hub card) subscribe to `state` so they
    // re-render after an exercise ends. Verifying the publish keeps that
    // contract from drifting as we add more write paths.
    const store = new LearnProgressStore(() => '2026-04-23')
    let notifications = 0
    store.state.subscribe(() => {
      notifications++
    })
    store.commit(result({ xp: 10 }))
    expect(notifications).toBe(1)
  })

  it('increments the streak when advancing into the next day', () => {
    let today = '2026-04-22'
    const store = new LearnProgressStore(() => today)
    store.commit(result())
    expect(store.streakDays).toBe(1)
    today = '2026-04-23'
    const outcome = store.commit(result())
    expect(outcome.streakExtended).toBe(true)
    expect(store.streakDays).toBe(2)
  })

  it('touchStreak marks attendance without a full commit', () => {
    // Opening the Learn tab counts toward the day even before an exercise
    // ends — the hub calls touchStreak so a quick peek still contributes.
    const store = new LearnProgressStore(() => '2026-04-23')
    const first = store.touchStreak()
    expect(first.extended).toBe(true)
    expect(store.streakDays).toBe(1)
    const second = store.touchStreak()
    expect(second.extended).toBe(false)
    expect(store.streakDays).toBe(1)
  })

  it('updateSettings merges partial updates without losing other fields', () => {
    const store = new LearnProgressStore(() => '2026-04-23')
    store.updateSettings({ showScoreCounter: true })
    expect(store.settings.showScoreCounter).toBe(true)
    expect(store.settings.handColor).toBe('pitch-split')
    expect(store.settings.keyFilter).toBe('C')
  })

  it('returns streakExtended=false for same-day repeat commits', () => {
    const store = new LearnProgressStore(() => '2026-04-23')
    store.commit(result())
    const again = store.commit(result({ xp: 5 }))
    expect(again.streakExtended).toBe(false)
    expect(store.xp).toBe(25)
  })

  it('migrates payloads missing newer fields without losing stored data', () => {
    // Simulate an older payload saved before a new settings field existed:
    // streak/xp/exercises are present but `settings` lacks `showScoreCounter`
    // entirely. A shallow spread would leave the field undefined at runtime
    // and break any `if (settings.showScoreCounter)` check downstream.
    localStorage.setItem(
      'midee.learn.v1',
      JSON.stringify({
        version: 1,
        streak: { days: 3, lastDay: '2026-04-22' },
        xp: { total: 120 },
        settings: { handColor: 'tracks' },
      }),
    )
    const store = new LearnProgressStore(() => '2026-04-23')
    expect(store.streakDays).toBe(3)
    expect(store.xp).toBe(120)
    expect(store.settings.handColor).toBe('tracks')
    // New fields fall back to their defaults rather than `undefined`.
    expect(store.settings.showScoreCounter).toBe(false)
    expect(store.settings.clefPreference).toBe('grand')
    expect(store.settings.keyFilter).toBe('C')
  })
})
