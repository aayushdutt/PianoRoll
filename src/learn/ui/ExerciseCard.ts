import type { ExerciseDescriptor } from '../core/Exercise'

// Catalog tile. Clicking a card triggers `onLaunch` which hoists up to the
// runner.
export interface CardOptions {
  descriptor: ExerciseDescriptor
  icon?: string
  onLaunch: (descriptor: ExerciseDescriptor) => void
}

export class ExerciseCard {
  private root: HTMLButtonElement | null = null

  constructor(private opts: CardOptions) {}

  mount(container: HTMLElement): void {
    const { descriptor, icon, onLaunch } = this.opts
    const el = document.createElement('button')
    el.type = 'button'
    el.className = 'ex-card'
    el.dataset['category'] = descriptor.category
    el.dataset['difficulty'] = descriptor.difficulty
    el.innerHTML = `
      ${icon ? `<span class="ex-card__icon" aria-hidden="true">${icon}</span>` : ''}
      <span class="ex-card__title">${descriptor.title}</span>
      <span class="ex-card__blurb">${descriptor.blurb}</span>
    `
    el.addEventListener('click', () => onLaunch(descriptor))
    container.appendChild(el)
    this.root = el
  }

  unmount(): void {
    this.root?.remove()
    this.root = null
  }
}

// Placeholder tile for a category with no exercises yet. Keeps the catalog
// layout consistent while the plan fills in — and tells the user what's coming
// so the empty state reads as "roadmap", not "broken".
export class ComingSoonCard {
  private root: HTMLDivElement | null = null
  constructor(
    private category: string,
    private label: string,
    private icon?: string,
  ) {}

  mount(container: HTMLElement): void {
    const el = document.createElement('div')
    el.className = 'ex-card ex-card--coming'
    el.dataset['category'] = this.category
    el.innerHTML = `
      ${this.icon ? `<span class="ex-card__icon" aria-hidden="true">${this.icon}</span>` : ''}
      <span class="ex-card__title">${this.label}</span>
      <span class="ex-card__blurb">Coming soon</span>
    `
    container.appendChild(el)
    this.root = el
  }

  unmount(): void {
    this.root?.remove()
    this.root = null
  }
}
