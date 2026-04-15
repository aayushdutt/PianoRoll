import type { MidiFile } from '../core/midi/types'

export interface AudioEngine {
  load(source: MidiFile | AudioBuffer): Promise<void>
  play(fromTime: number): Promise<void>
  pause(): void
  seek(time: number): void
  setVolume(v: number): void  // 0–1
  setSpeed(s: number): void   // 0.25–2
  dispose(): void
}
