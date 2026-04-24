import { SAMPLES, type Sample } from '../../core/samples'
import { t } from '../../i18n'
import type { ExerciseCategory, ExerciseDescriptor } from '../core/Exercise'
import type { LearnState } from '../core/LearnState'
import type { LearnProgressStore } from '../core/progress'
import { ComingSoonCard, ExerciseCard } from '../ui/ExerciseCard'
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
  // User-initiated MIDI source switches. Both route through LearnController's
  // own loader — on success, `learnState.loadedMidi` flips and the hub
  // re-renders its hero card.
  onOpenFilePicker: () => void
  onLoadSample: (sampleId: string) => void
}

// Category ordering on the catalog. Play-along first (the Phase 1 core), then
// sight-reading/ear/theory/technique/reflection — matches the user-facing
// "what would I do in a practice session?" mental model.
const CATEGORY_ORDER: ExerciseCategory[] = [
  'play-along',
  'sight-reading',
  'ear-training',
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

// Inline SVGs for the hero card's primary button — kept local so the hub has
// no dependency on the icons module that Controls uses.
const ICON_PLAY = `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M4 3 L13 8 L4 13 Z"/></svg>`
const ICON_UPLOAD = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 11V3M4.5 6.5L8 3l3.5 3.5M3 12v1.5A1.5 1.5 0 0 0 4.5 15h7A1.5 1.5 0 0 0 13 13.5V12"/></svg>`

// Landing surface for Learn mode. App-feel: sticky top bar with the streak
// pill, a featured hero card for the next recommended exercise (today that's
// always Play-Along), a samples strip so the user can jump in without leaving
// the hub, and a compact category grid below.
export class LearnHub {
  private root: HTMLDivElement | null = null
  private streakRow: StreakRow
  private mountedCards: Array<{ unmount: () => void }> = []
  private unsubs: Array<() => void> = []

  constructor(private opts: LearnHubOptions) {
    this.streakRow = new StreakRow(opts.progress)
  }

  mount(container: HTMLElement): void {
    if (this.root) return
    const el = document.createElement('div')
    el.className = 'learn-hub'
    el.innerHTML = `
      <div class="learn-hub__glow" aria-hidden="true"></div>
      <header class="learn-hub__topbar">
        <div class="learn-hub__brand">
          <h1 class="learn-hub__title">${t('learn.hub.title')}</h1>
          <p class="learn-hub__subtitle">${t('learn.hub.subtitle')}</p>
        </div>
        <div class="learn-hub__streak" data-streak></div>
      </header>
      <div class="learn-hub__scroll">
        <div class="learn-hub__inner">
          <div class="learn-hub__hero" data-hero></div>
          <section class="learn-hub__samples-section" data-samples-section>
            <div class="learn-hub__section-head">
              <span class="learn-hub__section-title">Jump in with a sample</span>
              <span class="learn-hub__section-hint">Or upload your own MIDI above</span>
            </div>
            <div class="learn-hub__samples" data-samples></div>
          </section>
          <div class="learn-hub__grid-label">Explore</div>
          <div class="learn-hub__grid" data-grid></div>
        </div>
      </div>
    `
    container.appendChild(el)
    this.root = el

    const streakHost = el.querySelector<HTMLElement>('[data-streak]')!
    this.streakRow.mount(streakHost)

    this.renderHero(el.querySelector<HTMLElement>('[data-hero]')!)
    this.renderSamples(el.querySelector<HTMLElement>('[data-samples]')!)
    this.renderGrid(el.querySelector<HTMLElement>('[data-grid]')!)

    // Hero re-renders when the loaded MIDI changes (e.g. after a file picker
    // round-trip or a sample load) so the CTA flips from "Upload" to
    // "Continue · <name>" in place without the user having to refresh.
    this.unsubs.push(
      this.opts.learnState.loadedMidi.subscribe(() => {
        const heroHost = this.root?.querySelector<HTMLElement>('[data-hero]')
        if (heroHost) {
          heroHost.innerHTML = ''
          this.renderHero(heroHost)
        }
      }),
    )
  }

  unmount(): void {
    this.streakRow.unmount()
    for (const off of this.unsubs) off()
    this.unsubs = []
    for (const card of this.mountedCards) card.unmount()
    this.mountedCards = []
    this.root?.remove()
    this.root = null
  }

  // ── Layout sections ────────────────────────────────────────────────────

  private renderHero(host: HTMLElement): void {
    const featured = CATALOG.find((d) => d.id === 'play-along')
    if (!featured) return
    const loaded = this.opts.learnState.loadedMidi.value

    const hero = document.createElement('div')
    hero.className = 'hero-card'
    hero.dataset['category'] = featured.category

    const kicker =
      CATEGORY_LABEL[featured.category].toLowerCase() === featured.title.toLowerCase()
        ? 'Recommended'
        : CATEGORY_LABEL[featured.category]

    // The hero splits the primary affordance into two explicit buttons so the
    // user always has a clear way forward: upload their own file, OR (if one
    // is already loaded) start the exercise. The old "disabled, go to Play
    // mode first" dead-end is gone.
    const primaryLabel = loaded ? `Start · ${loaded.name}` : 'Upload a MIDI'
    const primaryIcon = loaded ? ICON_PLAY : ICON_UPLOAD
    const primaryKind = loaded ? 'start' : 'upload'
    const secondary = loaded
      ? `<button class="hero-card__secondary" type="button" data-action="upload"
              aria-label="Upload a different MIDI" data-tip="Upload a different MIDI">
           ${ICON_UPLOAD}<span>Swap MIDI</span>
         </button>`
      : ''

    hero.innerHTML = `
      <div class="hero-card__badge">${CATEGORY_ICON[featured.category]}</div>
      <div class="hero-card__body">
        <span class="hero-card__kicker">${kicker}</span>
        <h2 class="hero-card__title">${featured.title}</h2>
        <p class="hero-card__blurb">${featured.blurb}</p>
      </div>
      <div class="hero-card__actions">
        <button class="hero-card__primary" type="button" data-action="${primaryKind}">
          <span class="hero-card__primary-icon" aria-hidden="true">${primaryIcon}</span>
          <span class="hero-card__primary-label">${primaryLabel}</span>
        </button>
        ${secondary}
      </div>
    `
    hero
      .querySelector<HTMLButtonElement>('[data-action="start"]')
      ?.addEventListener('click', () => {
        this.opts.launchExercise(featured)
      })
    for (const btn of hero.querySelectorAll<HTMLButtonElement>('[data-action="upload"]')) {
      btn.addEventListener('click', () => this.opts.onOpenFilePicker())
    }

    host.appendChild(hero)
    this.mountedCards.push({ unmount: () => hero.remove() })
  }

  private renderSamples(host: HTMLElement): void {
    host.innerHTML = ''
    for (const sample of SAMPLES) {
      const card = this.renderSampleCard(sample)
      host.appendChild(card)
      this.mountedCards.push({ unmount: () => card.remove() })
    }
  }

  private renderSampleCard(sample: Sample): HTMLElement {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'learn-sample'
    btn.dataset['sampleId'] = sample.id
    btn.style.setProperty('--sample-accent', sample.accent)
    btn.innerHTML = `
      <div class="learn-sample__accent" aria-hidden="true"></div>
      <div class="learn-sample__meta">
        <div class="learn-sample__title">${escapeHtml(sample.title)}</div>
        <div class="learn-sample__composer">${escapeHtml(sample.composer)}</div>
      </div>
      <div class="learn-sample__go" aria-hidden="true">
        <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M5 3 L12 8 L5 13 Z"/></svg>
      </div>
    `
    btn.addEventListener('click', () => this.opts.onLoadSample(sample.id))
    return btn
  }

  private renderGrid(host: HTMLElement): void {
    host.innerHTML = ''
    const byCategory = new Map<ExerciseCategory, ExerciseDescriptor[]>()
    for (const d of CATALOG) {
      const list = byCategory.get(d.category) ?? []
      list.push(d)
      byCategory.set(d.category, list)
    }
    for (const cat of CATEGORY_ORDER) {
      const list = (byCategory.get(cat) ?? []).filter((d) => d.id !== 'play-along')
      if (list.length === 0) {
        const card = new ComingSoonCard(cat, CATEGORY_LABEL[cat], CATEGORY_ICON[cat])
        card.mount(host)
        this.mountedCards.push(card)
        continue
      }
      for (const descriptor of list) {
        const card = new ExerciseCard({
          descriptor,
          icon: CATEGORY_ICON[descriptor.category],
          onLaunch: (d) => this.opts.launchExercise(d),
        })
        card.mount(host)
        this.mountedCards.push(card)
      }
    }
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
