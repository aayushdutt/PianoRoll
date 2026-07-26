import { describe, expect, it, vi } from 'vitest'
import type { SurfaceHit } from '../renderer/VisualizationSurface'
import { AUTO_FOLLOW_SUSPEND_MS, FretboardInteraction } from './FretboardInteraction'

describe('FretboardInteraction', () => {
  it('reuses one normalized voice ID for each pointer note-on/off lifecycle', () => {
    const hits: SurfaceHit[] = []
    const interaction = new FretboardInteraction((hit) => hits.push(hit))
    interaction.pointerDown(1, { string: 0, fret: 3 }, 43, 0.8)
    interaction.pointerDown(2, { string: 5, fret: 5 }, 69)
    interaction.pointerUp(2)
    interaction.pointerUp(1)

    expect(hits.map(({ type, pitch }) => [type, pitch])).toEqual([
      ['note-on', 43],
      ['note-on', 69],
      ['note-off', 69],
      ['note-off', 43],
    ])
    expect(hits[0]).toMatchObject({
      velocity: 0.8,
      sourceId: 'guitar:fretboard',
      string: 0,
      fret: 3,
    })
    expect(hits[0]!.voiceId).toBe(hits[3]!.voiceId)
    expect(hits[1]!.voiceId).toBe(hits[2]!.voiceId)
    expect(hits[0]!.voiceId).not.toBe(hits[1]!.voiceId)
  })

  it('emits note-off on cancel and creates a new ID on pointer retrigger', () => {
    const hits: SurfaceHit[] = []
    const interaction = new FretboardInteraction((hit) => hits.push(hit))
    interaction.pointerDown(1, { string: 1, fret: 2 }, 47)
    interaction.pointerDown(1, { string: 1, fret: 3 }, 48)
    interaction.pointerCancel(1)
    interaction.pointerCancel(1)

    expect(hits.map((hit) => hit.type)).toEqual(['note-on', 'note-off', 'note-on', 'note-off'])
    expect(hits[0]!.voiceId).toBe(hits[1]!.voiceId)
    expect(hits[2]!.voiceId).toBe(hits[3]!.voiceId)
    expect(hits[0]!.voiceId).not.toBe(hits[2]!.voiceId)
  })

  it('cleans all held pointers exactly once', () => {
    const emit = vi.fn<(hit: SurfaceHit) => void>()
    const interaction = new FretboardInteraction(emit)
    interaction.pointerDown(1, { string: 1, fret: 2 }, 47)
    interaction.pointerDown(2, { string: 2, fret: 4 }, 54)
    interaction.cancelAll()
    interaction.cancelAll()
    expect(emit.mock.calls.map(([hit]) => hit.type)).toEqual([
      'note-on',
      'note-on',
      'note-off',
      'note-off',
    ])
  })

  it('gives each keyboard activation its own normalized voice lifecycle', () => {
    const hits: SurfaceHit[] = []
    const interaction = new FretboardInteraction((hit) => hits.push(hit))
    interaction.keyboardActivate({ string: 4, fret: 1 }, 60)
    interaction.keyboardActivate({ string: 4, fret: 1 }, 60)
    expect(hits.map((hit) => hit.type)).toEqual(['note-on', 'note-off', 'note-on', 'note-off'])
    expect(hits[0]!.voiceId).toBe(hits[1]!.voiceId)
    expect(hits[2]!.voiceId).toBe(hits[3]!.voiceId)
    expect(hits[0]!.voiceId).not.toBe(hits[2]!.voiceId)
  })

  it('suspends auto-follow for exactly three seconds after manual pan', () => {
    const interaction = new FretboardInteraction(() => {})
    interaction.noteManualPan(1_000)
    expect(interaction.canAutoFollow(1_000 + AUTO_FOLLOW_SUSPEND_MS - 1)).toBe(false)
    expect(interaction.canAutoFollow(1_000 + AUTO_FOLLOW_SUSPEND_MS)).toBe(true)
  })
})
