import { describe, expect, it } from 'vitest'
import { type MidiFile, nominalTempoMap } from '../core/midi/types'
import { createEventSignal } from './eventSignal'
import { createAppStore } from './state'
import { watch } from './watch'

function fakeMidi(name = 'demo.mid', duration = 12.5): MidiFile {
  return {
    name,
    duration,
    bpm: 120,
    timeSignature: [4, 4],
    ...nominalTempoMap(120, [4, 4]),
    tracks: [],
  }
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

// Transpose is the only field that re-derives `loadedMidi` after the initial
// load. Its contract: clamp to ±12, reset on every load, never touch
// `sourceMidi`, and never move the timeline (pitches shift, timing doesn't).
describe('createAppStore transpose', () => {
  function midiWithPitches(...pitches: number[]): MidiFile {
    return {
      ...fakeMidi('pitched.mid', 8),
      tracks: [
        {
          id: 't0',
          name: 'Piano',
          channel: 0,
          instrument: 0,
          isDrum: false,
          colorIndex: 0,
          notes: pitches.map((pitch, i) => ({
            pitch,
            time: i * 0.5,
            duration: 0.4,
            velocity: 0.8,
          })),
        },
      ],
    }
  }

  const pitchesOf = (m: MidiFile | null): number[] => m?.tracks[0]?.notes.map((n) => n.pitch) ?? []

  it('defaults to 0', () => {
    expect(createAppStore().state.transpose).toBe(0)
  })

  it('clamps to ±12 semitones and truncates to an integer', () => {
    const store = createAppStore()
    store.completePlayLoad(midiWithPitches(60))
    expect(store.setTranspose(99)).toBe(12)
    expect(store.state.transpose).toBe(12)
    expect(store.setTranspose(-99)).toBe(-12)
    expect(store.state.transpose).toBe(-12)
    expect(store.setTranspose(3.7)).toBe(3)
    expect(store.setTranspose(Number.NaN)).toBe(0)
  })

  it('re-derives loadedMidi from sourceMidi and leaves the source untouched', () => {
    const store = createAppStore()
    store.completePlayLoad(midiWithPitches(60, 64, 67))
    store.setTranspose(2)
    expect(pitchesOf(store.state.loadedMidi)).toEqual([62, 66, 69])
    expect(pitchesOf(store.state.sourceMidi)).toEqual([60, 64, 67])
    // Derives always run from the source, never from the previous derive.
    store.setTranspose(-1)
    expect(pitchesOf(store.state.loadedMidi)).toEqual([59, 63, 66])
    expect(pitchesOf(store.state.sourceMidi)).toEqual([60, 64, 67])
    store.setTranspose(0)
    expect(pitchesOf(store.state.loadedMidi)).toEqual([60, 64, 67])
  })

  it('does not move the timeline — pitches shift, timing does not', () => {
    const store = createAppStore()
    store.completePlayLoad(midiWithPitches(60, 62))
    store.setState('currentTime', 3.25)
    store.setState('status', 'playing')
    store.setTranspose(5)
    expect(store.state.duration).toBe(8)
    expect(store.state.currentTime).toBe(3.25)
    expect(store.state.status).toBe('playing')
  })

  it('resets to 0 on every new file load', () => {
    const store = createAppStore()
    store.completePlayLoad(midiWithPitches(60))
    store.setTranspose(7)
    store.completePlayLoad(midiWithPitches(72))
    expect(store.state.transpose).toBe(0)
    expect(pitchesOf(store.state.loadedMidi)).toEqual([72])
  })

  it('resets to 0 on enterHome', () => {
    const store = createAppStore()
    store.completePlayLoad(midiWithPitches(60))
    store.setTranspose(-4)
    store.enterHome()
    expect(store.state.transpose).toBe(0)
  })

  it('records the value with no file loaded, without deriving', () => {
    const store = createAppStore()
    expect(store.setTranspose(4)).toBe(4)
    expect(store.state.transpose).toBe(4)
    expect(store.state.loadedMidi).toBeNull()
  })

  it('folds notes a transpose pushes past C8 back into the 88-key range', () => {
    // deriveMidi order is transpose-then-fold: C8 (108) + 5 = 113, which has
    // no key geometry, so it comes back an octave down at 101.
    const store = createAppStore()
    store.completePlayLoad(midiWithPitches(108, 21))
    expect(pitchesOf(store.state.loadedMidi)).toEqual([108, 21])
    store.setTranspose(5)
    expect(pitchesOf(store.state.loadedMidi)).toEqual([101, 26])
    // …and symmetrically off the bottom: A0 (21) − 5 = 16 → 28.
    store.setTranspose(-5)
    expect(pitchesOf(store.state.loadedMidi)).toEqual([103, 28])
  })

  it('preserves releaseAt (pedal-extended notes) through a transpose', () => {
    const store = createAppStore()
    const src = midiWithPitches(60)
    src.tracks[0]!.notes[0]!.releaseAt = 4.2
    store.completePlayLoad(src)
    store.setTranspose(3)
    const note = store.state.loadedMidi?.tracks[0]?.notes[0]
    expect(note?.pitch).toBe(63)
    expect(note?.releaseAt).toBe(4.2)
    expect(note?.time).toBe(0)
    expect(note?.duration).toBe(0.4)
  })

  it('notifies loadedMidi subscribers so the renderer/synth re-read the file', () => {
    // <PlayMode/>'s effect drives renderer.loadMidi off `loadedMidi`; a
    // transpose has to look like a new file to it.
    const store = createAppStore()
    store.completePlayLoad(midiWithPitches(60))
    const seen: number[][] = []
    const stop = watch(
      () => store.state.loadedMidi,
      (m) => seen.push(pitchesOf(m)),
    )
    store.setTranspose(2)
    store.setTranspose(2) // no-op — same value, no second notification
    stop()
    expect(seen).toEqual([[62]])
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
