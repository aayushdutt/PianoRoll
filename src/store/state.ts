import type { MidiFile } from '../core/midi/types'

export class Signal<T> {
  private _value: T
  private subs = new Set<(v: T) => void>()

  constructor(initial: T) {
    this._value = initial
  }

  get value(): T {
    return this._value
  }

  set(v: T): void {
    this._value = v
    for (const sub of this.subs) sub(v)
  }

  subscribe(fn: (v: T) => void): () => void {
    this.subs.add(fn)
    return () => this.subs.delete(fn)
  }
}

export type PlaybackStatus = 'idle' | 'loading' | 'ready' | 'playing' | 'paused' | 'exporting'
export type AppMode = 'home' | 'play' | 'live' | 'learn'

export class AppStore {
  readonly mode = new Signal<AppMode>('home')
  readonly status = new Signal<PlaybackStatus>('idle')
  readonly loadedMidi = new Signal<MidiFile | null>(null)
  readonly currentTime = new Signal<number>(0)
  readonly duration = new Signal<number>(0)
  readonly volume = new Signal<number>(0.8)
  readonly speed = new Signal<number>(1)

  get hasLoadedFile(): boolean {
    return this.loadedMidi.value !== null
  }

  enterHome(): void {
    this.clearLoadedFile()
    this.mode.set('home')
    this.status.set('idle')
  }

  beginPlayLoad(): void {
    this.currentTime.set(0)
    this.mode.set('play')
    this.status.set('loading')
  }

  completePlayLoad(midi: MidiFile): void {
    this.loadedMidi.set(midi)
    this.duration.set(midi.duration)
    this.currentTime.set(0)
    this.mode.set('play')
    this.status.set('ready')
  }

  enterPlay(resetTime = true): boolean {
    const midi = this.loadedMidi.value
    if (!midi) return false
    this.duration.set(midi.duration)
    if (resetTime) this.currentTime.set(0)
    this.mode.set('play')
    this.status.set('ready')
    return true
  }

  enterLive(resetTime = true): void {
    if (resetTime) this.currentTime.set(0)
    this.mode.set('live')
    this.status.set('ready')
  }

  clearLoadedFile(): void {
    this.loadedMidi.set(null)
    this.duration.set(0)
    this.currentTime.set(0)
  }

  setCurrentTime(time: number): void {
    this.currentTime.set(time)
  }

  setStatus(status: PlaybackStatus): void {
    this.status.set(status)
  }

  setReady(): void {
    this.status.set('ready')
  }

  startPlaying(): void {
    this.status.set('playing')
  }

  pausePlayback(): void {
    this.status.set('paused')
  }

  beginExport(): void {
    this.status.set('exporting')
  }

  setVolume(volume: number): void {
    this.volume.set(volume)
  }

  setSpeed(speed: number): void {
    this.speed.set(speed)
  }
}

export const appState = new AppStore()
