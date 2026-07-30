import { createSignal, For, onMount, Show } from 'solid-js'
import { render } from 'solid-js/web'
import { forgetRecent, listRecents, type RecentMidi } from '../core/recentMidi'
import { computeSparkline, fetchSampleMidi, SAMPLES, type Sample } from '../core/samples'
import { t } from '../i18n'
import { icons } from './icons'

// One row of "things you can open": the user's recent uploads first, bundled
// samples backfilling the rest. Each card shows a pitch-density sparkline
// pulled from the MIDI — so the bars follow the actual shape of the piece
// rather than a placeholder.
//
// Recents lead the row and can fill it completely — once you have three files
// of your own, demos are noise. Storage keeps more than the row shows
// (`MAX_RECENTS`), so dismissing a card promotes the next one into view rather
// than handing the slot back to a sample. Recent cards deliberately drop the
// per-sample accent colour and wear the app accent plus a "Recent" tag — they
// read as a distinct family, not as another sample.

const BARS = 32
const TOTAL_SLOTS = 3

interface CardState {
  bars: readonly number[]
  sub: string
}

function placeholderBars(): readonly number[] {
  return Array.from({ length: BARS }, (_, i) => 0.28 + 0.22 * Math.sin((i / BARS) * Math.PI * 3))
}

function formatDuration(s: number): string {
  const m = Math.floor(s / 60)
  const sec = Math.round(s % 60)
  return `${m}:${sec.toString().padStart(2, '0')}`
}

// ── Cards ─────────────────────────────────────────────────────────────────

interface CardShellProps {
  id: string
  recent: boolean
  accent?: string | undefined
  title: string
  state: () => CardState
  onSelect: () => void
  onForget?: (() => void) | undefined
  forgetLabel?: string | undefined
}

function CardShell(props: CardShellProps) {
  return (
    <div class="sample-card-slot">
      <button
        class="sample-card"
        classList={{ 'sample-card--recent': props.recent }}
        data-card-id={props.id}
        type="button"
        {...(props.accent ? { style: { '--sample-accent': props.accent } } : {})}
        onClick={() => props.onSelect()}
      >
        <div class="sample-card-viz" aria-hidden="true">
          <div class="sample-card-bars">
            <For each={props.state().bars}>
              {(h, i) => (
                <span
                  style={{
                    '--h': `${Math.max(14, Math.round(h * 100))}%`,
                    '--d': `${i() * 18}ms`,
                  }}
                />
              )}
            </For>
          </div>
        </div>
        <div class="sample-card-meta">
          <Show when={props.recent}>
            <span class="sample-card-tag">{t('card.recent.tag')}</span>
          </Show>
          <div class="sample-card-title">{props.title}</div>
          <div class="sample-card-sub">{props.state().sub}</div>
        </div>
      </button>
      <Show when={props.onForget}>
        {(forget) => (
          <button
            class="sample-card-forget"
            type="button"
            aria-label={props.forgetLabel ?? ''}
            title={props.forgetLabel ?? ''}
            onClick={(e) => {
              // The slot is not the card, but the click still lands inside the
              // card's hover/press affordance — stop it before anything
              // upstream reads it as "open this piece".
              e.stopPropagation()
              forget()()
            }}
            innerHTML={icons.close(11)}
          />
        )}
      </Show>
    </div>
  )
}

function SampleCard(props: { sample: Sample; onSelect: (id: string) => void }) {
  const [state, setState] = createSignal<CardState>({
    bars: placeholderBars(),
    sub: `${props.sample.composer} · -`,
  })

  // Hydrate per card rather than in one pass over every sample: only mounted
  // cards fetch, so the samples pushed out of the row by recents never cost a
  // request. `fetchSampleMidi` caches module-level, so remounts are free.
  onMount(() => {
    void fetchSampleMidi(props.sample)
      .then((midi) => {
        setState({
          bars: computeSparkline(midi, BARS),
          sub: `${props.sample.composer} · ${formatDuration(midi.duration)}`,
        })
      })
      .catch((err) => {
        console.warn(`[SamplesGrid] hydrate failed for ${props.sample.id}`, err)
      })
  })

  return (
    <CardShell
      id={props.sample.id}
      recent={false}
      accent={props.sample.accent}
      title={props.sample.title}
      state={state}
      onSelect={() => props.onSelect(props.sample.id)}
    />
  )
}

function RecentCard(props: {
  recent: RecentMidi
  onSelect: (id: string) => void
  onForget: (id: string) => void
}) {
  // No hydration step — the sparkline and duration were computed once at save
  // time, so a recent card paints complete on first frame.
  const state = (): CardState => ({
    bars: props.recent.sparkline.length === BARS ? props.recent.sparkline : placeholderBars(),
    sub: t('card.recent.sub', { duration: formatDuration(props.recent.durationS) }),
  })

  return (
    <CardShell
      id={props.recent.id}
      recent={true}
      title={props.recent.displayName}
      state={state}
      onSelect={() => props.onSelect(props.recent.id)}
      onForget={() => props.onForget(props.recent.id)}
      forgetLabel={t('card.recent.forget', { name: props.recent.displayName })}
    />
  )
}

// ── Grid ──────────────────────────────────────────────────────────────────

interface GridProps {
  onSelectSample: (sampleId: string) => void
  onSelectRecent: (recentId: string) => void
  onContents: (kind: GridContents) => void
  registerRefresh: (fn: () => void) => void
}

function SamplesGridView(props: GridProps) {
  const [recents, setRecents] = createSignal<RecentMidi[]>([])

  // The row is a fixed three slots so the home card never reflows: recents
  // take what they need, samples fill whatever is left over.
  const visibleRecents = (): readonly RecentMidi[] => recents().slice(0, TOTAL_SLOTS)
  const visibleSamples = (): readonly Sample[] =>
    SAMPLES.slice(0, Math.max(0, TOTAL_SLOTS - visibleRecents().length))

  const refresh = (): void => {
    void listRecents().then((list) => {
      setRecents(list)
      // Report what the row actually ended up holding, not just how many
      // recents exist — a host that says "or explore a sample" would be lying
      // once recents have taken every slot.
      props.onContents(
        visibleRecents().length === 0
          ? 'samples'
          : visibleSamples().length === 0
            ? 'recents'
            : 'mixed',
      )
    })
  }

  const forget = (id: string): void => {
    void forgetRecent(id).then(refresh)
  }

  onMount(() => {
    props.registerRefresh(refresh)
    refresh()
  })

  return (
    <div class="samples-grid">
      <For each={visibleRecents()}>
        {(recent) => (
          <RecentCard recent={recent} onSelect={props.onSelectRecent} onForget={forget} />
        )}
      </For>
      <For each={visibleSamples()}>
        {(sample) => <SampleCard sample={sample} onSelect={props.onSelectSample} />}
      </For>
    </div>
  )
}

/** What the row is showing after a refresh. Hosts pick their section label from it. */
export type GridContents = 'samples' | 'mixed' | 'recents'

export interface SamplesGridOptions {
  onSelectSample: (sampleId: string) => void
  onSelectRecent: (recentId: string) => void
  /** Fired whenever recents are (re)loaded — hosts use it to swap their section label. */
  onContents?: (kind: GridContents) => void
}

export class SamplesGrid {
  private el: HTMLElement
  private disposeRoot: (() => void) | null = null
  private refreshFn: (() => void) | null = null

  constructor(opts: SamplesGridOptions) {
    this.el = document.createElement('div')
    this.el.style.display = 'contents'
    this.disposeRoot = render(
      () => (
        <SamplesGridView
          onSelectSample={opts.onSelectSample}
          onSelectRecent={opts.onSelectRecent}
          onContents={(kind) => opts.onContents?.(kind)}
          registerRefresh={(fn) => {
            this.refreshFn = fn
          }}
        />
      ),
      this.el,
    )
  }

  /**
   * Re-read recents from storage. Hosts call this when they become visible —
   * the grid is built once and long-lived, so a file opened since mount would
   * otherwise never show up.
   */
  refresh(): void {
    this.refreshFn?.()
  }

  get root(): HTMLElement {
    return this.el
  }

  dispose(): void {
    this.disposeRoot?.()
    this.disposeRoot = null
    this.el.remove()
  }
}
