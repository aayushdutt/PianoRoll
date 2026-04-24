import type { MidiFile } from '../../core/midi/types'
import { Signal } from '../../store/state'

// Learn mode's own transport + loaded-MIDI state. Kept isolated from `AppStore`
// so Learn never pollutes Play/Live and vice versa — a user can have a big
// piece loaded in Play, switch to Learn, load a short exercise MIDI, and
// return to Play without either mode's playhead or file being disturbed.
//
// The `mode` signal itself still lives on `AppStore` (it's the cross-cutting
// router). Everything else is mode-local: currentTime, duration, status,
// loadedMidi.
//
// Status is a narrower enum than `AppStore.status` — Learn has no 'exporting'
// phase and no 'loading' mid-play (exercises own their own loading UX).

export type LearnStatus = 'idle' | 'loading' | 'ready' | 'playing' | 'paused'

export class LearnState {
  readonly loadedMidi = new Signal<MidiFile | null>(null)
  readonly currentTime = new Signal<number>(0)
  readonly duration = new Signal<number>(0)
  readonly status = new Signal<LearnStatus>('idle')

  get hasLoadedMidi(): boolean {
    return this.loadedMidi.value !== null
  }

  beginLoad(): void {
    this.currentTime.set(0)
    this.status.set('loading')
  }

  completeLoad(midi: MidiFile): void {
    this.loadedMidi.set(midi)
    this.duration.set(midi.duration)
    this.currentTime.set(0)
    this.status.set('ready')
  }

  clearMidi(): void {
    this.loadedMidi.set(null)
    this.duration.set(0)
    this.currentTime.set(0)
    this.status.set('idle')
  }

  setCurrentTime(time: number): void {
    this.currentTime.set(time)
  }

  startPlaying(): void {
    this.status.set('playing')
  }

  pausePlayback(): void {
    this.status.set('paused')
  }

  setReady(): void {
    this.status.set('ready')
  }
}
