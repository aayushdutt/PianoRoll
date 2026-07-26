import { batch } from 'solid-js'
import { createStore } from 'solid-js/store'
import type { MidiFile } from '../core/midi/types'
import { stringEnumPersisted } from '../core/persistence'
import type { VisualizationMode } from '../guitar/types'

export type AppMode = 'home' | 'play' | 'live' | 'learn'
export type PlaybackStatus = 'idle' | 'loading' | 'ready' | 'playing' | 'paused' | 'exporting'

// Persisted user preference for which instrument surface renders — piano or
// guitar. Invalid/missing localStorage values fall back to 'piano'. Kept
// separate from `visualizationForced` (below) so a Learn-mode override never
// clobbers what the user actually chose.
const visualizationModeStore = stringEnumPersisted<VisualizationMode>(
  'midee.visualizationMode',
  'piano',
  ['piano', 'guitar'],
)

export interface AppStoreState {
  mode: AppMode
  status: PlaybackStatus
  loadedMidi: MidiFile | null
  currentTime: number
  duration: number
  volume: number
  speed: number
  // User's saved visualization preference — only ever written by explicit
  // selection (topbar selector). See `effectiveVisualizationMode`.
  visualizationMode: VisualizationMode
  // Non-null while a Learn exercise (other than Play-Along) is active and
  // needs the piano surface regardless of preference — Sight Reading, ear
  // training, etc. Cleared on exit; never itself persisted.
  visualizationForced: VisualizationMode | null
}

// The AppStore is the single source of truth for mode transitions, playback
// status, and the loaded MIDI. Consumers read `store.state.foo` (reactive
// inside a tracking scope, raw value outside) and write either through an
// intent method (multi-field, batched) or directly via `store.setState`.
export function createAppStore() {
  const [state, setState] = createStore<AppStoreState>({
    mode: 'home',
    status: 'idle',
    loadedMidi: null,
    currentTime: 0,
    duration: 0,
    volume: 0.8,
    speed: 1,
    visualizationMode: visualizationModeStore.load(),
    visualizationForced: null,
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
          loadedMidi: null,
          duration: 0,
          currentTime: 0,
        })
      })
    },
    beginPlayLoad() {
      batch(() => {
        setState({ mode: 'play', status: 'loading', currentTime: 0 })
      })
    },
    completePlayLoad(m: MidiFile) {
      batch(() => {
        setState({
          loadedMidi: m,
          duration: m.duration,
          currentTime: 0,
          mode: 'play',
          status: 'ready',
        })
      })
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
    // Explicit user selection only — the topbar selector calls this, and
    // only when it isn't disabled by a Learn-mode force. Persists
    // immediately so a reload keeps the choice.
    setVisualizationMode(mode: VisualizationMode) {
      setState('visualizationMode', mode)
      visualizationModeStore.save(mode)
    },
    // Learn-mode override. Never persisted — clearing it (`null`) restores
    // whatever the user's saved preference was without touching it.
    setVisualizationForced(mode: VisualizationMode | null) {
      setState('visualizationForced', mode)
    },
    // What the surface router should actually display: the Learn-mode force
    // when active, else the user's saved preference.
    get effectiveVisualizationMode(): VisualizationMode {
      return state.visualizationForced ?? state.visualizationMode
    },
  }
}

export type AppStore = ReturnType<typeof createAppStore>
