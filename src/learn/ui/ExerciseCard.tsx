import { Show } from 'solid-js'
import { render } from 'solid-js/web'
import type { ExerciseDescriptor } from '../core/Exercise'

// Catalog tile. Clicking a card triggers `onLaunch` which hoists up to the
// runner. The imperative class shell is preserved so legacy LearnHub keeps
// working; T12 ports LearnHub and the cards mount via `<For>` instead.
export interface CardOptions {
  descriptor: ExerciseDescriptor
  icon?: string
  onLaunch: (descriptor: ExerciseDescriptor) => void
}

export function ExerciseCardView(props: CardOptions) {
  return (
    <button
      type="button"
      class="ex-card"
      data-category={props.descriptor.category}
      data-difficulty={props.descriptor.difficulty}
      onClick={() => props.onLaunch(props.descriptor)}
    >
      <Show when={props.icon}>
        {(icon) => <span class="ex-card__icon" aria-hidden="true" innerHTML={icon()} />}
      </Show>
      <span class="ex-card__title">{props.descriptor.title}</span>
      <span class="ex-card__blurb">{props.descriptor.blurb}</span>
    </button>
  )
}

export class ExerciseCard {
  private dispose: (() => void) | null = null
  private wrapper: HTMLDivElement | null = null

  constructor(private opts: CardOptions) {}

  mount(container: HTMLElement): void {
    this.unmount()
    const wrapper = document.createElement('div')
    container.appendChild(wrapper)
    this.wrapper = wrapper
    this.dispose = render(() => <ExerciseCardView {...this.opts} />, wrapper)
  }

  unmount(): void {
    this.dispose?.()
    this.dispose = null
    this.wrapper?.remove()
    this.wrapper = null
  }
}

export interface ComingSoonProps {
  category: string
  label: string
  icon?: string
}

export function ComingSoonCardView(props: ComingSoonProps) {
  return (
    <div class="ex-card ex-card--coming" data-category={props.category}>
      <Show when={props.icon}>
        {(icon) => <span class="ex-card__icon" aria-hidden="true" innerHTML={icon()} />}
      </Show>
      <span class="ex-card__title">{props.label}</span>
      <span class="ex-card__blurb">Coming soon</span>
    </div>
  )
}

// Placeholder tile for a category with no exercises yet. Keeps the catalog
// layout consistent while the plan fills in.
export class ComingSoonCard {
  private dispose: (() => void) | null = null
  private wrapper: HTMLDivElement | null = null

  constructor(
    private category: string,
    private label: string,
    private icon?: string,
  ) {}

  mount(container: HTMLElement): void {
    this.unmount()
    const wrapper = document.createElement('div')
    container.appendChild(wrapper)
    this.wrapper = wrapper
    const iconProp: ComingSoonProps =
      this.icon !== undefined
        ? { category: this.category, label: this.label, icon: this.icon }
        : { category: this.category, label: this.label }
    this.dispose = render(() => <ComingSoonCardView {...iconProp} />, wrapper)
  }

  unmount(): void {
    this.dispose?.()
    this.dispose = null
    this.wrapper?.remove()
    this.wrapper = null
  }
}
