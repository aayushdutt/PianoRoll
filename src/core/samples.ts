// Bundled sample pieces — fetched from /samples/*.mid on click. Files are
// shipped in the repo under public/samples with per-file licensing attribution
// in the accompanying README. All three are Creative Commons (public domain
// for Bach; CC BY-SA for Satie + Chopin) sourced from the Mutopia Project.

import { parseMidiFile } from './midi/parser'
import type { MidiFile } from './midi/types'

export interface Sample {
  id: string
  title: string
  composer: string
  accent: string // CSS color — poster gradient + sparkline
  url: string // served from public/samples
  displayName: string // used as the MidiFile.name after parse
}

export const SAMPLES: readonly Sample[] = [
  {
    id: 'chopin-nocturne-op9-2',
    title: 'Nocturne Op. 9 No. 2',
    composer: 'Chopin',
    accent: '#06b6d4',
    url: `${import.meta.env.BASE_URL}samples/chopin-nocturne-op9-2.mid`,
    displayName: 'Chopin — Nocturne Op. 9 No. 2',
  },
  {
    id: 'bach-prelude-c',
    title: 'Prelude in C',
    composer: 'J.S. Bach',
    accent: '#f97316',
    url: `${import.meta.env.BASE_URL}samples/bach-prelude-in-c.mid`,
    displayName: 'Bach — Prelude in C (BWV 846)',
  },
  {
    id: 'satie-gnossienne-1',
    title: 'Gnossienne No. 1',
    composer: 'Satie',
    accent: '#a78bfa',
    url: `${import.meta.env.BASE_URL}samples/satie-gnossienne-1.mid`,
    displayName: 'Satie — Gnossienne No. 1',
  },
]

export function getSample(id: string): Sample | undefined {
  return SAMPLES.find((s) => s.id === id)
}

// Per-sample parsed cache. Parsing is tiny (<2 ms) but caching saves the
// re-fetch when a card is hovered/re-clicked.
const parseCache = new Map<string, Promise<MidiFile>>()

export function fetchSampleMidi(sample: Sample): Promise<MidiFile> {
  const existing = parseCache.get(sample.id)
  if (existing) return existing
  const p = (async () => {
    const res = await fetch(sample.url)
    if (!res.ok) throw new Error(`Sample fetch failed: ${sample.url} → ${res.status}`)
    const buffer = await res.arrayBuffer()
    return parseMidiFile(buffer, sample.displayName)
  })()
  parseCache.set(sample.id, p)
  return p
}

// Pitch-density sparkline — 32 bins of note-onset density, 0..1.
export function computeSparkline(midi: MidiFile, bins = 32): number[] {
  if (midi.duration <= 0) return new Array(bins).fill(0)
  const counts = new Array(bins).fill(0)
  for (const track of midi.tracks) {
    for (const note of track.notes) {
      const idx = Math.min(bins - 1, Math.floor((note.time / midi.duration) * bins))
      counts[idx]++
    }
  }
  const peak = Math.max(1, ...counts)
  return counts.map((c) => c / peak)
}
