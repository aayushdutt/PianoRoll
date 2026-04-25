// Single source of truth for playback time.
// Everything reads currentTime — renderer, audio scheduler, UI scrubber.
//
// Clock source is Tone's AudioContext (same one that drives audio output) so
// visuals stay phase-locked to audio. We intentionally do NOT own a separate
// AudioContext here — a second context would reserve its own realtime audio
// thread and compete with Tone's, which on weaker systems is audible as
// dropouts under main-thread pressure.

import { getContext, start as toneStart } from 'tone'

type ClockListener = (time: number) => void

export class MasterClock {
  private _startContextTime = 0 // context.currentTime when play() was called
  private _startOffset = 0 // where in the track we started from
  private _playing = false
  private _speed = 1
  private listeners = new Set<ClockListener>()
  private rafId: number | null = null

  private get contextTime(): number {
    return getContext().currentTime
  }

  get currentTime(): number {
    if (!this._playing) return this._startOffset
    const elapsed = (this.contextTime - this._startContextTime) * this._speed
    return this._startOffset + elapsed
  }

  get playing(): boolean {
    return this._playing
  }

  get speed(): number {
    return this._speed
  }

  set speed(s: number) {
    if (this._playing) {
      // Preserve current position then re-anchor at new speed
      this._startOffset = this.currentTime
      this._startContextTime = this.contextTime
    }
    this._speed = s
  }

  prime(): void {
    const ctx = getContext().rawContext as AudioContext
    if (ctx.state === 'suspended') {
      void toneStart()
    }
  }

  play(): void {
    if (this._playing) return
    // AudioContext may be suspended (browser autoplay policy)
    this.prime()
    this._startContextTime = this.contextTime
    this._playing = true
    this.tick()
  }

  pause(): void {
    if (!this._playing) return
    this._startOffset = this.currentTime
    this._playing = false
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId)
      this.rafId = null
    }
  }

  seek(time: number): void {
    this._startOffset = Math.max(0, time)
    if (this._playing) {
      this._startContextTime = this.contextTime
    }
    this.emit()
  }

  subscribe(listener: ClockListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private tick = (): void => {
    this.emit()
    if (this._playing) {
      this.rafId = requestAnimationFrame(this.tick)
    }
  }

  private emit(): void {
    const t = this.currentTime
    this.listeners.forEach((l) => {
      l(t)
    })
  }

  dispose(): void {
    this.pause()
    this.listeners.clear()
  }
}
