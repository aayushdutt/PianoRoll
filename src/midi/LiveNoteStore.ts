export interface LiveNote {
  pitch: number
  startTime: number // MasterClock.currentTime when key was pressed
  endTime: number | null
  velocity: number // 0–1
}

// Tracks held keys plus released note trails that should keep scrolling upward
// until they leave the visible roll.
export class LiveNoteStore {
  private _held = new Map<number, LiveNote>() // pitch → note
  private _released: LiveNote[] = []

  get heldNotes(): ReadonlyMap<number, LiveNote> {
    return this._held
  }

  get releasedNotes(): readonly LiveNote[] {
    return this._released
  }

  get hasRenderableNotes(): boolean {
    return this._held.size > 0 || this._released.length > 0
  }

  press(pitch: number, velocity: number, clockTime: number): void {
    // If somehow already held (e.g. stuck note), release it first
    if (this._held.has(pitch)) this.release(pitch, clockTime)
    this._held.set(pitch, { pitch, startTime: clockTime, endTime: null, velocity })
  }

  release(pitch: number, clockTime: number): void {
    const note = this._held.get(pitch)
    if (!note) return
    this._held.delete(pitch)
    note.endTime = Math.max(clockTime, note.startTime)
    this._released.push(note)
  }

  // Release every held key but keep the finished trails around so the timeline
  // can continue carrying them upward.
  releaseAll(clockTime: number): void {
    for (const pitch of Array.from(this._held.keys())) {
      this.release(pitch, clockTime)
    }
  }

  pruneInvisible(currentTime: number, maxAgeAfterRelease: number): void {
    // In-place compaction — no allocation per frame.
    const arr = this._released
    let writeIdx = 0
    for (let i = 0; i < arr.length; i++) {
      const note = arr[i]!
      const keep = note.endTime === null || currentTime - note.endTime < maxAgeAfterRelease
      if (keep) {
        if (writeIdx !== i) arr[writeIdx] = note
        writeIdx++
      }
    }
    arr.length = writeIdx
  }

  // Clear everything — new file loaded or user explicitly resets.
  reset(): void {
    this._held.clear()
    this._released = []
  }
}
