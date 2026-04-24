import { describe, expect, it } from 'vitest'
import type { MidiFile } from '../core/midi/types'
import { AppStore, Signal } from './state'

function fakeMidi(name = 'demo.mid', duration = 12.5): MidiFile {
  return { name, duration, bpm: 120, timeSignature: [4, 4], tracks: [] }
}

describe('Signal', () => {
  it('exposes the initial value', () => {
    const s = new Signal(42)
    expect(s.value).toBe(42)
  })

  it('set() updates the value and notifies subscribers', () => {
    const s = new Signal('a')
    const seen: string[] = []
    s.subscribe((v) => seen.push(v))
    s.set('b')
    s.set('c')
    expect(s.value).toBe('c')
    expect(seen).toEqual(['b', 'c'])
  })

  it('subscribe() does not fire for the initial value', () => {
    const s = new Signal(1)
    const seen: number[] = []
    s.subscribe((v) => seen.push(v))
    expect(seen).toEqual([])
  })

  it('unsubscribe stops future notifications', () => {
    const s = new Signal(0)
    const seen: number[] = []
    const off = s.subscribe((v) => seen.push(v))
    s.set(1)
    off()
    s.set(2)
    expect(seen).toEqual([1])
  })

  it('multiple subscribers all receive updates', () => {
    const s = new Signal(0)
    const a: number[] = []
    const b: number[] = []
    s.subscribe((v) => a.push(v))
    s.subscribe((v) => b.push(v))
    s.set(5)
    expect(a).toEqual([5])
    expect(b).toEqual([5])
  })
})

// AppStore is the single source of truth for mode transitions, playback status,
// and the loaded MIDI. Every mode controller reads and mutates it, so the
// invariants below are load-bearing — a regression here silently breaks every
// downstream surface (HUD visibility, analytics, renderer state).
describe('AppStore', () => {
  it('starts idle on the home mode with no MIDI loaded', () => {
    const store = new AppStore()
    expect(store.mode.value).toBe('home')
    expect(store.status.value).toBe('idle')
    expect(store.loadedMidi.value).toBeNull()
    expect(store.hasLoadedFile).toBe(false)
    expect(store.currentTime.value).toBe(0)
  })

  it('enterHome clears the loaded MIDI and resets the transport', () => {
    const store = new AppStore()
    store.completePlayLoad(fakeMidi())
    store.setCurrentTime(4.2)
    store.startPlaying()
    store.enterHome()
    expect(store.mode.value).toBe('home')
    expect(store.loadedMidi.value).toBeNull()
    expect(store.duration.value).toBe(0)
    expect(store.currentTime.value).toBe(0)
    expect(store.status.value).toBe('idle')
  })

  it('completePlayLoad stores the MIDI and flips to play/ready', () => {
    const store = new AppStore()
    const midi = fakeMidi('song.mid', 20)
    store.beginPlayLoad()
    expect(store.mode.value).toBe('play')
    expect(store.status.value).toBe('loading')
    store.completePlayLoad(midi)
    expect(store.loadedMidi.value).toBe(midi)
    expect(store.duration.value).toBe(20)
    expect(store.status.value).toBe('ready')
    expect(store.hasLoadedFile).toBe(true)
  })

  it('enterPlay no-ops when no MIDI is loaded', () => {
    const store = new AppStore()
    const entered = store.enterPlay()
    expect(entered).toBe(false)
    expect(store.mode.value).toBe('home')
  })

  it('enterPlay restores play mode from any other mode when a MIDI is loaded', () => {
    const store = new AppStore()
    const midi = fakeMidi()
    store.completePlayLoad(midi)
    store.enterLive()
    expect(store.mode.value).toBe('live')
    const entered = store.enterPlay()
    expect(entered).toBe(true)
    expect(store.mode.value).toBe('play')
    expect(store.loadedMidi.value).toBe(midi)
  })

  it('enterPlay(false) preserves the current playhead for resume', () => {
    const store = new AppStore()
    store.completePlayLoad(fakeMidi())
    store.setCurrentTime(7.5)
    store.enterLive(false)
    store.enterPlay(false)
    expect(store.currentTime.value).toBe(7.5)
  })

  it('Play-mode loads do not touch Learn-mode state', () => {
    // Learn owns its own LearnState (see `src/learn/core/LearnState`).
    // A Play-mode load flips AppStore into 'play' regardless of where the
    // user was — Learn's MIDI pipeline never goes through AppStore, so
    // there's no longer a "preserve Learn" special case here.
    const store = new AppStore()
    // Simulate a user who was in Learn — AppStore.mode still carries the
    // router value because mode itself is cross-cutting.
    store.mode.set('learn')
    store.beginPlayLoad()
    expect(store.mode.value).toBe('play')
    expect(store.status.value).toBe('loading')
    store.completePlayLoad(fakeMidi('play-import.mid', 10))
    expect(store.mode.value).toBe('play')
    expect(store.loadedMidi.value?.name).toBe('play-import.mid')
  })

  it('status transitions notify subscribers in order', () => {
    // The HUD, chord overlay, and renderer all gate on status transitions.
    // Guarding against reordering here is what keeps those consumers simple
    // (they can trust "playing → paused" was a real user-intent flip, not
    // a transient setState thrash).
    const store = new AppStore()
    const seen: string[] = []
    store.status.subscribe((s) => seen.push(s))
    store.beginPlayLoad()
    store.completePlayLoad(fakeMidi())
    store.startPlaying()
    store.pausePlayback()
    store.setReady()
    expect(seen).toEqual(['loading', 'ready', 'playing', 'paused', 'ready'])
  })
})
