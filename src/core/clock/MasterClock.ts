// Single source of truth for playback time.
// Everything reads currentTime — renderer, audio scheduler, UI scrubber.

type ClockListener = (time: number) => void

export class MasterClock {
  private context: AudioContext
  private _startContextTime = 0 // AudioContext.currentTime when play() was called
  private _startOffset = 0 // where in the track we started from
  private _playing = false
  private _speed = 1
  private listeners = new Set<ClockListener>()
  private rafId: number | null = null

  constructor() {
    this.context = new AudioContext()
  }

  get audioContext(): AudioContext {
    return this.context
  }

  get currentTime(): number {
    if (!this._playing) return this._startOffset
    const elapsed = (this.context.currentTime - this._startContextTime) * this._speed
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
      this._startContextTime = this.context.currentTime
    }
    this._speed = s
  }

  prime(): void {
    if (this.context.state === 'suspended') {
      void this.context.resume()
    }
  }

  play(): void {
    if (this._playing) return
    // AudioContext may be suspended (browser autoplay policy)
    this.prime()
    this._startContextTime = this.context.currentTime
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
      this._startContextTime = this.context.currentTime
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
    void this.context.close()
  }
}
