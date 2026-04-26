import { createMemo, For, onCleanup, onMount, Show } from 'solid-js'
import { render } from 'solid-js/web'
import { t } from '../../i18n'
import type { ExerciseCategory, ExerciseDescriptor } from '../core/Exercise'
import type { LearnState } from '../core/LearnState'
import type { LearnProgressStore } from '../core/progress'
import { ComingSoonCardView, ExerciseCardView } from '../ui/ExerciseCard'
import { StreakRow } from '../ui/StreakRow'
import { CATALOG } from './catalog'

export interface LearnHubOptions {
  progress: LearnProgressStore
  // Reads `loadedMidi` for the Play-Along hero state — Learn has its own
  // MIDI store, independent of `AppStore`, so Play's currently-loaded piece
  // never bleeds into the hub CTA.
  learnState: LearnState
  // The hub delegates launching to the controller so it doesn't import the
  // runner directly. Kept as a thin handoff.
  launchExercise: (descriptor: ExerciseDescriptor) => void
  // Opens the unified MIDI picker (file + bundled samples). Sample selection
  // routes through the picker → LearnController.loadSample, which auto-launches
  // Play-Along, so the hub doesn't need a separate sample handler anymore.
  onOpenFilePicker: () => void
}

// Catalog ordering. Play-along is the Hero up top so it's NOT repeated in
// Explore. Ear-training (intervals) leads the rest — it's the only fully
// implemented secondary exercise; sight-read/theory/etc. fall in below as
// "coming soon" cards.
const CATEGORY_ORDER: ExerciseCategory[] = [
  'ear-training',
  'sight-reading',
  'theory',
  'technique',
  'reflection',
]

const CATEGORY_LABEL: Record<ExerciseCategory, string> = {
  'play-along': 'Play along',
  'sight-reading': 'Sight reading',
  'ear-training': 'Ear training',
  theory: 'Theory',
  technique: 'Technique',
  reflection: 'Reflect',
}

const CATEGORY_ICON: Record<ExerciseCategory, string> = {
  'play-along':
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4v16M12 6v10M17 8v6"/></svg>',
  'sight-reading':
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M4 11h16M4 16h10"/><circle cx="18" cy="16" r="2"/></svg>',
  'ear-training':
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 18a5 5 0 0 1 0-10 3 3 0 1 1 6 0v10"/><path d="M14 14h4"/></svg>',
  theory:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/><path d="M12 4v16M4 12h16"/></svg>',
  technique:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20l5-10 3 6 3-12 5 16"/></svg>',
  reflection:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/></svg>',
}

const ICON_PLAY =
  '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M4 3 L13 8 L4 13 Z"/></svg>'
const ICON_UPLOAD =
  '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 11V3M4.5 6.5L8 3l3.5 3.5M3 12v1.5A1.5 1.5 0 0 0 4.5 15h7A1.5 1.5 0 0 0 13 13.5V12"/></svg>'

function Hero(props: LearnHubOptions) {
  const featured = CATALOG.find((d) => d.id === 'play-along')
  if (!featured) return null
  const loaded = () => props.learnState.state.loadedMidi
  const kicker =
    CATEGORY_LABEL[featured.category].toLowerCase() === featured.title.toLowerCase()
      ? 'Recommended'
      : CATEGORY_LABEL[featured.category]
  return (
    <div class="hero-card" data-category={featured.category}>
      <div class="hero-card__badge" innerHTML={CATEGORY_ICON[featured.category]} />
      <div class="hero-card__body">
        <span class="hero-card__kicker">{kicker}</span>
        <h2 class="hero-card__title">{featured.title}</h2>
        <p class="hero-card__blurb">{featured.blurb}</p>
      </div>
      <div class="hero-card__actions">
        <Show
          when={loaded()}
          fallback={
            <button
              class="hero-card__primary"
              type="button"
              onClick={() => props.onOpenFilePicker()}
            >
              <span class="hero-card__primary-icon" aria-hidden="true" innerHTML={ICON_UPLOAD} />
              <span class="hero-card__primary-label">Upload a MIDI</span>
            </button>
          }
        >
          {(midi) => (
            <button
              class="hero-card__primary"
              type="button"
              onClick={() => props.launchExercise(featured)}
            >
              <span class="hero-card__primary-icon" aria-hidden="true" innerHTML={ICON_PLAY} />
              <span class="hero-card__primary-label">Start · {midi().name}</span>
            </button>
          )}
        </Show>
      </div>
    </div>
  )
}

function Grid(props: { launchExercise: (d: ExerciseDescriptor) => void }) {
  const byCategory = createMemo(() => {
    const map = new Map<ExerciseCategory, ExerciseDescriptor[]>()
    for (const d of CATALOG) {
      const list = map.get(d.category) ?? []
      list.push(d)
      map.set(d.category, list)
    }
    return map
  })
  return (
    <For each={CATEGORY_ORDER}>
      {(cat) => {
        const list = byCategory().get(cat) ?? []
        return (
          <Show
            when={list.length > 0}
            fallback={
              <ComingSoonCardView
                category={cat}
                label={CATEGORY_LABEL[cat]}
                icon={CATEGORY_ICON[cat]}
              />
            }
          >
            <For each={list}>
              {(descriptor) => (
                <ExerciseCardView
                  descriptor={descriptor}
                  icon={CATEGORY_ICON[descriptor.category]}
                  onLaunch={(d) => props.launchExercise(d)}
                />
              )}
            </For>
          </Show>
        )
      }}
    </For>
  )
}

function LearnHubView(props: LearnHubOptions) {
  let streakHost!: HTMLDivElement
  onMount(() => {
    const row = new StreakRow(props.progress)
    row.mount(streakHost)
    onCleanup(() => row.unmount())
  })
  return (
    <div class="learn-hub">
      <div class="learn-hub__glow" aria-hidden="true" />
      <header class="learn-hub__topbar">
        <div class="learn-hub__brand">
          <h1 class="learn-hub__title">{t('learn.hub.title')}</h1>
          <p class="learn-hub__subtitle">{t('learn.hub.subtitle')}</p>
        </div>
        <div class="learn-hub__streak" ref={streakHost} />
      </header>
      <div class="learn-hub__scroll">
        <div class="learn-hub__inner">
          <div class="learn-hub__hero">
            <Hero {...props} />
          </div>
          <div class="learn-hub__grid-label">Explore</div>
          <div class="learn-hub__grid">
            <Grid launchExercise={props.launchExercise} />
          </div>
        </div>
      </div>
    </div>
  )
}

// Imperative shell preserved for LearnController (mounts into `hubHost`).
// T2b inlines this into <LearnMode/> once LearnController dissolves.
export class LearnHub {
  private dispose: (() => void) | null = null
  private wrapper: HTMLDivElement | null = null

  constructor(private opts: LearnHubOptions) {}

  mount(container: HTMLElement): void {
    this.unmount()
    const wrapper = document.createElement('div')
    container.appendChild(wrapper)
    this.wrapper = wrapper
    this.dispose = render(() => <LearnHubView {...this.opts} />, wrapper)
  }

  unmount(): void {
    this.dispose?.()
    this.dispose = null
    this.wrapper?.remove()
    this.wrapper = null
  }
}
