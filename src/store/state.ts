import { batch } from 'solid-js'
import { createStore } from 'solid-js/store'
import { deriveMidi } from '../core/midi/derive'
import type { MidiFile } from '../core/midi/types'

export type AppMode = 'home' | 'play' | 'live' | 'learn'
export type PlaybackStatus = 'idle' | 'loading' | 'ready' | 'playing' | 'paused' | 'exporting'

export interface AppStoreState {
  mode: AppMode
  status: PlaybackStatus
  // The parser's output, untransposed, kept only so a transpose change can
  // re-derive without re-parsing (and so "download MIDI" can hand back the
  // original pitches). Nothing renders or plays from it.
  sourceMidi: MidiFile | null
  // What every consumer reads: `sourceMidi` after deriveMidi (transpose).
  // The same object as `sourceMidi` while transpose is 0. Set only via
  // completePlayLoad / setTranspose.
  loadedMidi: MidiFile | null
  currentTime: number
  duration: number
  volume: number
  speed: number
  // Playback transpose in semitones, integer, clamped to ±TRANSPOSE_LIMIT.
  // Per-piece, not a preference: every load resets it to 0. Pitches move,
  // timing does not — so `duration` / `currentTime` never change with it.
  transpose: number
}

export const TRANSPOSE_LIMIT = 12

// ±1 octave. Wider and most of a piece leaves the 88 keys, where notes are
// still audible but nothing is drawn.
export function clampTranspose(n: number): number {
  if (!Number.isFinite(n)) return 0
  const i = Math.trunc(n)
  return i < -TRANSPOSE_LIMIT ? -TRANSPOSE_LIMIT : i > TRANSPOSE_LIMIT ? TRANSPOSE_LIMIT : i
}

// The AppStore is the single source of truth for mode transitions, playback
// status, and the loaded MIDI. Consumers read `store.state.foo` (reactive
// inside a tracking scope, raw value outside) and write either through an
// intent method (multi-field, batched) or directly via `store.setState`.
export function createAppStore() {
  const [state, setState] = createStore<AppStoreState>({
    mode: 'home',
    status: 'idle',
    sourceMidi: null,
    loadedMidi: null,
    currentTime: 0,
    duration: 0,
    volume: 0.8,
    speed: 1,
    transpose: 0,
  })

  return {
    state,
    setState,
    // Multi-field transitions only — single-field writes go through setState.
    enterHome() {
      batch(() => {
        setState({
          mode: 'home',
          status: 'idle',
          sourceMidi: null,
          loadedMidi: null,
          duration: 0,
          currentTime: 0,
          transpose: 0,
        })
      })
    },
    beginPlayLoad() {
      batch(() => {
        setState({ mode: 'play', status: 'loading', currentTime: 0 })
      })
    },
    // The single gate a parsed MidiFile passes through on its way into Play
    // state — every loader (file, sample, recent, live session) funnels here.
    // Transpose is a per-piece setting, so a new file always starts at 0 and
    // `loadedMidi` IS `sourceMidi` until the user transposes.
    completePlayLoad(m: MidiFile): void {
      batch(() => {
        setState({
          sourceMidi: m,
          loadedMidi: m,
          duration: m.duration,
          currentTime: 0,
          transpose: 0,
          mode: 'play',
          status: 'ready',
        })
      })
    },
    // Re-derives `loadedMidi` from the untouched `sourceMidi`. Only pitches
    // move, so duration/currentTime/status are deliberately left alone — the
    // caller (App) pushes the new file at the synth and reschedules. Returns
    // the clamped value actually applied so the caller can skip a no-op.
    setTranspose(n: number): number {
      const next = clampTranspose(n)
      if (next === state.transpose) return next
      const src = state.sourceMidi
      if (src === null) {
        setState('transpose', next)
        return next
      }
      batch(() => {
        setState({ transpose: next, loadedMidi: deriveMidi(src, { transpose: next }) })
      })
      return next
    },
    // Re-entry into Play mode without reloading MIDI — e.g. switching back
    // from Live or recovering from a failed load. Returns false when no MIDI
    // is loaded so the caller can fall back to the file picker.
    enterPlay(resetTime = true): boolean {
      if (state.loadedMidi === null) return false
      batch(() => {
        setState({
          mode: 'play',
          status: 'ready',
          duration: state.loadedMidi!.duration,
          ...(resetTime ? { currentTime: 0 } : {}),
        })
      })
      return true
    },
    enterLive(resetTime = true) {
      batch(() => {
        setState({
          mode: 'live',
          status: 'ready',
          ...(resetTime ? { currentTime: 0 } : {}),
        })
      })
    },
    get hasLoadedFile(): boolean {
      return state.loadedMidi !== null
    },
  }
}

export type AppStore = ReturnType<typeof createAppStore>
