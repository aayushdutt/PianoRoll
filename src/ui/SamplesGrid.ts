import type { MidiFile } from '../core/midi/types'
import { computeSparkline, fetchSampleMidi, SAMPLES, type Sample } from '../core/samples'

// Row of sample cards. Each card shows a pitch-density sparkline pulled from
// the parsed MIDI — so the bars follow the actual shape of the piece rather
// than a placeholder. Bars have a gradient fill, rounded tops, accent bloom,
// and a staggered lift on hover.

const BARS = 32

export class SamplesGrid {
  private el: HTMLElement
  onSelect?: (sampleId: string) => void

  constructor() {
    this.el = document.createElement('div')
    this.el.className = 'samples-grid'
    this.el.innerHTML = SAMPLES.map(renderCard).join('')
    this.bindEvents()
    void this.hydrateAll()
  }

  get root(): HTMLElement {
    return this.el
  }

  private bindEvents(): void {
    this.el.querySelectorAll<HTMLButtonElement>('.sample-card').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset['sampleId']
        if (id) this.onSelect?.(id)
      })
    })
  }

  private async hydrateAll(): Promise<void> {
    for (const sample of SAMPLES) {
      try {
        const midi = await fetchSampleMidi(sample)
        const card = this.el.querySelector<HTMLElement>(`[data-sample-id="${sample.id}"]`)
        if (!card) continue
        const bars = computeSparkline(midi, BARS)
        const vizEl = card.querySelector<HTMLElement>('.sample-card-viz')
        if (vizEl) vizEl.innerHTML = renderBars(bars, midi)
        const sub = card.querySelector<HTMLElement>('.sample-card-sub')
        if (sub) sub.textContent = `${sample.composer} · ${formatDuration(midi.duration)}`
      } catch (err) {
        console.warn(`[SamplesGrid] hydrate failed for ${sample.id}`, err)
      }
    }
  }
}

function renderCard(sample: Sample): string {
  // Placeholder bars — soft sine wave so cards aren't flat before hydration.
  const placeholder = Array.from({ length: BARS }, (_, i) => {
    const v = 0.28 + 0.22 * Math.sin((i / BARS) * Math.PI * 3)
    return `<span style="--h: ${Math.round(v * 100)}%; --d: ${i * 18}ms"></span>`
  }).join('')
  return `
    <button class="sample-card" data-sample-id="${sample.id}" type="button"
            style="--sample-accent: ${sample.accent};">
      <div class="sample-card-viz" aria-hidden="true">
        <div class="sample-card-bars">${placeholder}</div>
      </div>
      <div class="sample-card-meta">
        <div class="sample-card-title">${escapeHtml(sample.title)}</div>
        <div class="sample-card-sub">${escapeHtml(sample.composer)} · —</div>
      </div>
    </button>
  `
}

function renderBars(values: readonly number[], _midi: MidiFile): string {
  return `<div class="sample-card-bars">${values
    .map((v, i) => {
      const h = Math.max(14, Math.round(v * 100))
      const delay = i * 18 // ms — staggers the ambient breathe across the row
      return `<span style="--h: ${h}%; --d: ${delay}ms"></span>`
    })
    .join('')}</div>`
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      (
        ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;',
        }) as Record<string, string>
      )[c] ?? c,
  )
}

function formatDuration(s: number): string {
  const m = Math.floor(s / 60)
  const sec = Math.round(s % 60)
  return `${m}:${sec.toString().padStart(2, '0')}`
}
