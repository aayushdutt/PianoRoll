export interface LiveNote {
  pitch: number
  startTime: number   // MasterClock.currentTime when key was pressed
  velocity: number    // 0–1
}

// Tracks keys currently held on the MIDI keyboard.
export class LiveNoteStore {
  private _active = new Map<number, LiveNote>()   // pitch → note

  get activeNotes(): ReadonlyMap<number, LiveNote> {
    return this._active
  }

  press(pitch: number, velocity: number, clockTime: number): void {
    // If somehow already held (e.g. stuck note), release it first
    if (this._active.has(pitch)) this.release(pitch)
    this._active.set(pitch, { pitch, startTime: clockTime, velocity })
  }

  release(pitch: number): void {
    this._active.delete(pitch)
  }

  // Release every held key (pause, seek, blur).
  releaseAll(): void {
    this._active.clear()
  }

  // Clear everything — new file loaded or user explicitly resets.
  reset(): void {
    this._active.clear()
  }
}
