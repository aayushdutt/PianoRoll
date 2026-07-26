import type { SurfaceHit } from '../renderer/VisualizationSurface'
import type { GuitarPosition } from './types'

export const AUTO_FOLLOW_SUSPEND_MS = 3_000

const FRETBOARD_SOURCE_ID = 'guitar:fretboard'

export class FretboardInteraction {
  private readonly activePointers = new Map<
    number,
    { position: GuitarPosition; pitch: number; voiceId: string }
  >()
  private manualPanUntil = 0
  private nextVoiceId = 1

  constructor(private readonly emit: (hit: SurfaceHit) => void) {}

  pointerDown(pointerId: number, position: GuitarPosition, pitch: number, velocity = 1): void {
    const existing = this.activePointers.get(pointerId)
    if (existing) this.endPointer(pointerId)
    const voiceId = this.createVoiceId(`pointer-${pointerId}`)
    this.activePointers.set(pointerId, { position, pitch, voiceId })
    this.emit({
      type: 'note-on',
      pitch,
      velocity,
      sourceId: FRETBOARD_SOURCE_ID,
      voiceId,
      ...position,
    })
  }

  pointerUp(pointerId: number): void {
    this.endPointer(pointerId)
  }

  pointerCancel(pointerId: number): void {
    this.endPointer(pointerId)
  }

  keyboardActivate(position: GuitarPosition, pitch: number): void {
    const base = {
      pitch,
      ...position,
      sourceId: FRETBOARD_SOURCE_ID,
      voiceId: this.createVoiceId('keyboard'),
    }
    this.emit({ type: 'note-on', velocity: 1, ...base })
    this.emit({ type: 'note-off', velocity: 0, ...base })
  }

  noteManualPan(now: number): void {
    this.manualPanUntil = now + AUTO_FOLLOW_SUSPEND_MS
  }

  canAutoFollow(now: number): boolean {
    return now >= this.manualPanUntil
  }

  cancelAll(): void {
    for (const pointerId of Array.from(this.activePointers.keys())) {
      this.endPointer(pointerId)
    }
  }

  private endPointer(pointerId: number): void {
    const active = this.activePointers.get(pointerId)
    if (!active) return
    this.activePointers.delete(pointerId)
    this.emit({
      type: 'note-off',
      pitch: active.pitch,
      velocity: 0,
      sourceId: FRETBOARD_SOURCE_ID,
      voiceId: active.voiceId,
      ...active.position,
    })
  }

  private createVoiceId(origin: string): string {
    return `${FRETBOARD_SOURCE_ID}:${origin}:${this.nextVoiceId++}`
  }
}
