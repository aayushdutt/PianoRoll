import { describe, expect, it } from 'vitest'
import { LiveNoteStore } from './LiveNoteStore'

describe('LiveNoteStore', () => {
  it('tracks a held note until released, then moves it to the released trail', () => {
    const store = new LiveNoteStore()
    expect(store.hasRenderableNotes).toBe(false)

    store.press(60, 0.8, 1)
    expect(store.heldNotes.size).toBe(1)
    expect(store.heldNotes.get(60)).toMatchObject({
      pitch: 60,
      startTime: 1,
      endTime: null,
      velocity: 0.8,
    })
    expect(store.releasedNotes).toHaveLength(0)
    expect(store.hasRenderableNotes).toBe(true)

    store.release(60, 2.5)
    expect(store.heldNotes.size).toBe(0)
    expect(store.releasedNotes).toHaveLength(1)
    expect(store.releasedNotes[0]).toMatchObject({ pitch: 60, startTime: 1, endTime: 2.5 })
  })

  it('auto-releases a stuck duplicate when the same pitch is pressed again', () => {
    const store = new LiveNoteStore()
    store.press(64, 0.5, 1)
    // No release arrived (stuck note); a new press of the same key should close
    // the previous one into the released trail before starting fresh.
    store.press(64, 0.9, 3)

    expect(store.heldNotes.size).toBe(1)
    expect(store.heldNotes.get(64)).toMatchObject({ startTime: 3, velocity: 0.9, endTime: null })
    expect(store.releasedNotes).toHaveLength(1)
    expect(store.releasedNotes[0]).toMatchObject({ startTime: 1, endTime: 3, velocity: 0.5 })
  })

  it('keeps equal pitches with distinct voice identities active independently', () => {
    const store = new LiveNoteStore()
    store.press(60, 0.7, 1, { sourceId: 'a', channel: 0, voiceId: 'voice-a' })
    store.press(60, 0.8, 2, { sourceId: 'b', channel: 1, voiceId: 'voice-b' })

    expect(store.heldVoices.size).toBe(2)
    expect(store.heldNotes.size).toBe(1) // compatibility pitch projection
    store.releaseVoice('voice-a', 3)
    expect(store.heldVoices.has('voice-b')).toBe(true)
    expect(store.releasedNotes[0]).toMatchObject({ voiceId: 'voice-a', sourceId: 'a', channel: 0 })
  })

  it('clamps endTime to be no earlier than startTime', () => {
    const store = new LiveNoteStore()
    store.press(67, 1, 5)
    // A back-dated release earlier than the press must not produce a negative
    // duration — endTime is floored at startTime.
    store.release(67, 4)
    expect(store.releasedNotes[0]!.endTime).toBe(5)
  })

  it('release is a no-op for an un-held pitch', () => {
    const store = new LiveNoteStore()
    store.release(60, 1)
    expect(store.releasedNotes).toHaveLength(0)
    expect(store.heldNotes.size).toBe(0)
  })

  it('releaseAll moves every held key to the released trail', () => {
    const store = new LiveNoteStore()
    store.press(60, 1, 0)
    store.press(64, 1, 0)
    store.press(67, 1, 0)
    store.releaseAll(2)
    expect(store.heldNotes.size).toBe(0)
    expect(store.releasedNotes).toHaveLength(3)
    expect(store.releasedNotes.every((n) => n.endTime === 2)).toBe(true)
  })

  it('pruneInvisible compacts in place, dropping aged-out released notes', () => {
    const store = new LiveNoteStore()
    // Three released notes ending at 1, 5, and 9.
    store.press(60, 1, 0)
    store.release(60, 1)
    store.press(62, 1, 0)
    store.release(62, 5)
    store.press(64, 1, 0)
    store.release(64, 9)
    expect(store.releasedNotes).toHaveLength(3)

    // At t=10 with a 2s window, keep only notes whose release is within 2s
    // (endTime 9 → age 1 kept; endTime 5 → age 5 dropped; endTime 1 dropped).
    store.pruneInvisible(10, 2)
    expect(store.releasedNotes.map((n) => n.pitch)).toEqual([64])
  })

  it('pruneInvisible keeps order stable during compaction', () => {
    const store = new LiveNoteStore()
    for (const [pitch, end] of [
      [60, 1],
      [61, 8],
      [62, 2],
      [63, 9],
    ] as const) {
      store.press(pitch, 1, 0)
      store.release(pitch, end)
    }
    // Window keeps endTimes >= 5 (at t=10): 61(end 8) and 63(end 9), in order.
    store.pruneInvisible(10, 5)
    expect(store.releasedNotes.map((n) => n.pitch)).toEqual([61, 63])
  })

  it('pruneInvisible keep-condition is a strict inequality at the exact age boundary', () => {
    // keep := currentTime - endTime < maxAgeAfterRelease (LiveNoteStore.ts:54).
    // A note released at t=0, pruned at currentTime=5 with maxAge=5 → age 5 is
    // NOT < 5, so it must be dropped; nudging maxAge above 5 keeps it. This pins
    // the boundary that decides when a released trail leaves the visible roll.
    const atBoundary = new LiveNoteStore()
    atBoundary.press(60, 1, 0)
    atBoundary.release(60, 0)
    atBoundary.pruneInvisible(5, 5)
    expect(atBoundary.releasedNotes.map((n) => n.pitch)).toEqual([])

    const justInside = new LiveNoteStore()
    justInside.press(60, 1, 0)
    justInside.release(60, 0)
    justInside.pruneInvisible(5, 5.0001)
    expect(justInside.releasedNotes.map((n) => n.pitch)).toEqual([60])
  })

  // NOTE: the `note.endTime === null` half of the keep-condition (LiveNoteStore.ts:54)
  // is unreachable via the public API — release() always sets endTime, and only
  // released notes enter _released. It is defensive dead code; intentionally not
  // tested rather than faked via private-field surgery.

  it('pruneInvisible never touches held notes', () => {
    const store = new LiveNoteStore()
    store.press(60, 1, 0)
    store.pruneInvisible(1000, 0.001) // aggressive prune; held map is a separate list
    expect(store.heldNotes.has(60)).toBe(true)
  })

  it('reset clears both held and released notes', () => {
    const store = new LiveNoteStore()
    store.press(60, 1, 0)
    store.release(60, 1)
    store.press(64, 1, 0)
    store.reset()
    expect(store.hasRenderableNotes).toBe(false)
    expect(store.heldNotes.size).toBe(0)
    expect(store.releasedNotes).toHaveLength(0)
  })

  it('preserves performed string and fret through held and released voice trails', () => {
    const store = new LiveNoteStore()
    store.press(45, 0.9, 1, { voiceId: 'guitar:low-e:5', string: 0, fret: 5 })
    expect(store.heldVoices.get('guitar:low-e:5')).toMatchObject({ string: 0, fret: 5 })
    store.releaseVoice('guitar:low-e:5', 2)
    expect(store.releasedNotes[0]).toMatchObject({ string: 0, fret: 5, endTime: 2 })
  })

  // onChange is the renderer's wake signal: it must fire on every mutation
  // that changes renderable content (press/release/reset) so the idle-stopped
  // ticker restarts, and must stay silent for pruneInvisible, which runs
  // *inside* the render loop and would otherwise self-wake forever.
  describe('onChange', () => {
    it('notifies on press, release, and reset — not on no-op release', () => {
      const store = new LiveNoteStore()
      let fired = 0
      store.onChange(() => fired++)

      store.press(60, 0.8, 1)
      expect(fired).toBe(1)
      store.release(60, 2)
      expect(fired).toBe(2)
      store.release(60, 3) // pitch not held — nothing changed
      expect(fired).toBe(2)
      store.reset()
      expect(fired).toBe(3)
    })

    it('releaseAll notifies once per held note', () => {
      const store = new LiveNoteStore()
      store.press(60, 0.8, 1)
      store.press(64, 0.8, 1)
      let fired = 0
      store.onChange(() => fired++)
      store.releaseAll(2)
      expect(fired).toBe(2)
    })

    it('pruneInvisible is silent', () => {
      const store = new LiveNoteStore()
      store.press(60, 0.8, 0)
      store.release(60, 1)
      let fired = 0
      store.onChange(() => fired++)
      store.pruneInvisible(1000, 0.001)
      expect(store.releasedNotes).toHaveLength(0)
      expect(fired).toBe(0)
    })

    it('unsubscribe stops notifications', () => {
      const store = new LiveNoteStore()
      let fired = 0
      const off = store.onChange(() => fired++)
      store.press(60, 0.8, 1)
      off()
      store.press(64, 0.8, 1)
      expect(fired).toBe(1)
    })
  })
})
