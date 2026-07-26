import { beforeEach, describe, expect, it } from 'vitest'
import type { MidiFile } from '../core/midi/types'
import { createEventSignal } from './eventSignal'
import { createAppStore } from './state'
import { watch } from './watch'

function fakeMidi(name = 'demo.mid', duration = 12.5): MidiFile {
  return { name, duration, bpm: 120, timeSignature: [4, 4], tracks: [] }
}

describe('createEventSignal', () => {
  it('exposes the initial value', () => {
    const s = createEventSignal(42)
    expect(s.value).toBe(42)
  })

  it('set() updates the value and notifies subscribers', () => {
    const s = createEventSignal('a')
    const seen: string[] = []
    s.subscribe((v) => seen.push(v))
    s.set('b')
    s.set('c')
    expect(s.value).toBe('c')
    expect(seen).toEqual(['b', 'c'])
  })

  it('unsubscribe stops future notifications', () => {
    const s = createEventSignal(0)
    const seen: number[] = []
    const off = s.subscribe((v) => seen.push(v))
    s.set(1)
    off()
    s.set(2)
    expect(seen).toEqual([1])
  })
})

// createAppStore is the single source of truth for mode transitions, playback
// status, and the loaded MIDI. Invariants below are load-bearing — downstream
// surfaces (HUD visibility, analytics, renderer state) rely on them.
describe('createAppStore', () => {
  it('starts idle on the home mode with no MIDI loaded', () => {
    const store = createAppStore()
    expect(store.state.mode).toBe('home')
    expect(store.state.status).toBe('idle')
    expect(store.state.loadedMidi).toBeNull()
    expect(store.hasLoadedFile).toBe(false)
    expect(store.state.currentTime).toBe(0)
  })

  it('enterHome clears the loaded MIDI and resets the transport', () => {
    const store = createAppStore()
    store.completePlayLoad(fakeMidi())
    store.setState('currentTime', 4.2)
    store.setState('status', 'playing')
    store.enterHome()
    expect(store.state.mode).toBe('home')
    expect(store.state.loadedMidi).toBeNull()
    expect(store.state.duration).toBe(0)
    expect(store.state.currentTime).toBe(0)
    expect(store.state.status).toBe('idle')
  })

  it('completePlayLoad stores the MIDI and flips to play/ready', () => {
    const store = createAppStore()
    const midi = fakeMidi('song.mid', 20)
    store.beginPlayLoad()
    expect(store.state.mode).toBe('play')
    expect(store.state.status).toBe('loading')
    store.completePlayLoad(midi)
    // solid-js/store wraps stored objects in a proxy — compare by name
    // instead of reference equality.
    expect(store.state.loadedMidi?.name).toBe(midi.name)
    expect(store.state.duration).toBe(20)
    expect(store.state.status).toBe('ready')
    expect(store.hasLoadedFile).toBe(true)
  })

  it('enterPlay no-ops when no MIDI is loaded', () => {
    const store = createAppStore()
    expect(store.enterPlay()).toBe(false)
    expect(store.state.mode).toBe('home')
  })

  it('enterPlay restores play mode from any other mode when a MIDI is loaded', () => {
    const store = createAppStore()
    const midi = fakeMidi()
    store.completePlayLoad(midi)
    store.enterLive()
    expect(store.state.mode).toBe('live')
    expect(store.enterPlay()).toBe(true)
    expect(store.state.mode).toBe('play')
    // solid-js/store wraps the stored value in a proxy, so reference
    // equality against the raw input fails. Compare by identifying field.
    expect(store.state.loadedMidi?.name).toBe(midi.name)
  })

  it('enterPlay(false) preserves the current playhead for resume', () => {
    const store = createAppStore()
    store.completePlayLoad(fakeMidi())
    store.setState('currentTime', 7.5)
    store.enterLive(false)
    store.enterPlay(false)
    expect(store.state.currentTime).toBe(7.5)
  })

  it('Play-mode loads do not touch Learn-mode state', () => {
    // Learn owns its own LearnState (see `src/learn/core/LearnState`).
    // AppStore.mode still carries the router value because mode itself is
    // cross-cutting — Learn's MIDI pipeline never goes through AppStore.
    const store = createAppStore()
    store.setState('mode', 'learn')
    store.beginPlayLoad()
    expect(store.state.mode).toBe('play')
    expect(store.state.status).toBe('loading')
    store.completePlayLoad(fakeMidi('play-import.mid', 10))
    expect(store.state.mode).toBe('play')
    expect(store.state.loadedMidi?.name).toBe('play-import.mid')
  })

  it('status transitions notify tracked effects in order', () => {
    // The HUD, chord overlay, and renderer all gate on status transitions.
    // Using watch() gives us a createRoot/createEffect pair that survives
    // long enough for the scheduled re-runs to flush.
    const store = createAppStore()
    const seen: string[] = []
    const stop = watch(
      () => store.state.status,
      (s) => seen.push(s),
    )
    store.beginPlayLoad()
    store.completePlayLoad(fakeMidi())
    store.setState('status', 'playing')
    store.setState('status', 'paused')
    store.setState('status', 'ready')
    stop()
    // watch() defers the initial read — only transitions are reported.
    expect(seen).toEqual(['loading', 'ready', 'playing', 'paused', 'ready'])
  })

  it('batch intent methods flip multiple fields in one reactive pass', () => {
    // A mode transition must not let subscribers observe a half-updated
    // store (e.g. mode='play' with status still 'idle'). `enterHome` batches
    // so a tracked effect sees exactly one consistent snapshot after.
    const store = createAppStore()
    store.completePlayLoad(fakeMidi())
    const snapshots: Array<{ mode: string; status: string }> = []
    const stop = watch(
      () => [store.state.mode, store.state.status] as const,
      ([mode, status]) => snapshots.push({ mode, status }),
    )
    store.enterHome()
    stop()
    // watch() defers the initial read — only the post-batch snapshot fires.
    expect(snapshots.length).toBe(1)
    expect(snapshots[0]).toEqual({ mode: 'home', status: 'idle' })
  })
})

// Visualization mode: persisted preference vs. Learn's temporary force.
// `midee.visualizationMode` is the localStorage key (core/persistence.ts).
describe('createAppStore visualization mode', () => {
  beforeEach(() => localStorage.clear())

  it('defaults to piano when nothing is persisted', () => {
    const store = createAppStore()
    expect(store.state.visualizationMode).toBe('piano')
    expect(store.state.visualizationForced).toBeNull()
    expect(store.effectiveVisualizationMode).toBe('piano')
  })

  it('falls back to piano for an invalid persisted value', () => {
    localStorage.setItem('midee.visualizationMode', 'banjo')
    const store = createAppStore()
    expect(store.state.visualizationMode).toBe('piano')
  })

  it('setVisualizationMode updates state, persists, and flows into effectiveVisualizationMode', () => {
    const store = createAppStore()
    store.setVisualizationMode('guitar')
    expect(store.state.visualizationMode).toBe('guitar')
    expect(store.effectiveVisualizationMode).toBe('guitar')
    // A fresh store picks up the persisted choice.
    expect(createAppStore().state.visualizationMode).toBe('guitar')
  })

  it('setVisualizationForced overrides the effective mode without touching the saved preference', () => {
    const store = createAppStore()
    store.setVisualizationMode('guitar')
    store.setVisualizationForced('piano')
    expect(store.effectiveVisualizationMode).toBe('piano')
    // The preference itself is untouched — this is what "restore on exit"
    // relies on.
    expect(store.state.visualizationMode).toBe('guitar')
  })

  it('clearing the force restores the saved preference exactly', () => {
    const store = createAppStore()
    store.setVisualizationMode('guitar')
    store.setVisualizationForced('piano')
    store.setVisualizationForced(null)
    expect(store.effectiveVisualizationMode).toBe('guitar')
  })
})

describe('watch()', () => {
  it('fires the callback on change and stops after dispose', () => {
    const store = createAppStore()
    const seen: string[] = []
    const stop = watch(
      () => store.state.mode,
      (m) => seen.push(m),
    )
    store.setState('mode', 'play')
    store.setState('mode', 'live')
    stop()
    store.setState('mode', 'learn')
    // watch() defers the initial read — only the two transitions fire.
    expect(seen).toEqual(['play', 'live'])
  })
})
