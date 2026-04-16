import type { MidiFile } from '../core/midi/types'

// Minimal reactive signal — no deps, typed, GC-friendly.
// Subscribers receive the new value synchronously on set().

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

export const appState = {
  status:           new Signal<PlaybackStatus>('idle'),
  midi:             new Signal<MidiFile | null>(null),
  currentTime:      new Signal<number>(0),
  duration:         new Signal<number>(0),
  volume:           new Signal<number>(0.8),
  speed:            new Signal<number>(1),
}
