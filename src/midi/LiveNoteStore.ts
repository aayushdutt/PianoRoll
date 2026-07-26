export interface LiveNote {
  pitch: number
  startTime: number // MasterClock.currentTime when key was pressed
  endTime: number | null
  velocity: number // 0–1
  sourceId?: string
  channel?: number
  voiceId: string
  string?: number
  fret?: number
}

// Tracks held keys plus released note trails that should keep scrolling upward
// until they leave the visible roll.
export class LiveNoteStore {
  private _heldVoices = new Map<string, LiveNote>()
  private _released: LiveNote[] = []
  private changeListeners = new Set<() => void>()

  // Fires after press / release / reset — i.e. whenever the renderable
  // contents change from *outside* the render loop. The renderer subscribes
  // to wake its (otherwise idle-stopped) ticker. pruneInvisible is
  // deliberately silent: it only runs inside the render loop and only
  // discards already-invisible trails, so notifying would self-wake forever.
  onChange(fn: () => void): () => void {
    this.changeListeners.add(fn)
    return () => this.changeListeners.delete(fn)
  }

  private notifyChange(): void {
    for (const fn of this.changeListeners) fn()
  }

  get heldNotes(): ReadonlyMap<number, LiveNote> {
    const pitches = new Map<number, LiveNote>()
    for (const note of this._heldVoices.values()) pitches.set(note.pitch, note)
    return pitches
  }

  get heldVoices(): ReadonlyMap<string, LiveNote> {
    return this._heldVoices
  }

  get releasedNotes(): readonly LiveNote[] {
    return this._released
  }

  get hasRenderableNotes(): boolean {
    return this._heldVoices.size > 0 || this._released.length > 0
  }

  press(
    pitch: number,
    velocity: number,
    clockTime: number,
    identity?: {
      sourceId?: string
      channel?: number
      voiceId?: string
      string?: number
      fret?: number
    },
  ): void {
    const voiceId = identity?.voiceId ?? `legacy:${pitch}`
    // If somehow already held (e.g. stuck note), release it first
    if (this._heldVoices.has(voiceId)) this.releaseVoice(voiceId, clockTime)
    this._heldVoices.set(voiceId, {
      pitch,
      startTime: clockTime,
      endTime: null,
      velocity,
      voiceId,
      ...(identity?.sourceId ? { sourceId: identity.sourceId } : {}),
      ...(identity?.channel !== undefined ? { channel: identity.channel } : {}),
      ...(identity?.string !== undefined ? { string: identity.string } : {}),
      ...(identity?.fret !== undefined ? { fret: identity.fret } : {}),
    })
    this.notifyChange()
  }

  release(pitch: number, clockTime: number): void {
    const voice = Array.from(this._heldVoices).find(([, note]) => note.pitch === pitch)
    if (!voice) return
    this.releaseVoice(voice[0], clockTime)
  }

  releaseVoice(voiceId: string, clockTime: number): void {
    const note = this._heldVoices.get(voiceId)
    if (!note) return
    this._heldVoices.delete(voiceId)
    note.endTime = Math.max(clockTime, note.startTime)
    this._released.push(note)
    this.notifyChange()
  }

  // Release every held key but keep the finished trails around so the timeline
  // can continue carrying them upward.
  releaseAll(clockTime: number): void {
    for (const voiceId of Array.from(this._heldVoices.keys())) {
      this.releaseVoice(voiceId, clockTime)
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
    this._heldVoices.clear()
    this._released = []
    this.notifyChange()
  }
}
