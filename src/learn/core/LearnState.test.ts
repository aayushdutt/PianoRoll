import { describe, expect, it } from 'vitest'
import { type MidiFile, nominalTempoMap } from '../../core/midi/types'
import { watch } from '../../store/watch'
import { createLearnState } from './LearnState'

function fakeMidi(name = 'etude.mid', duration = 15): MidiFile {
  return {
    name,
    duration,
    bpm: 120,
    timeSignature: [4, 4],
    ...nominalTempoMap(120, [4, 4]),
    tracks: [],
  }
}

describe('createLearnState', () => {
  it('starts empty', () => {
    const s = createLearnState()
    expect(s.state.loadedMidi).toBeNull()
    expect(s.state.currentTime).toBe(0)
    expect(s.state.duration).toBe(0)
    expect(s.state.status).toBe('idle')
    expect(s.hasLoadedMidi).toBe(false)
  })

  it('beginLoad → completeLoad walks through loading → ready', () => {
    const s = createLearnState()
    const seen: string[] = []
    const stop = watch(
      () => s.state.status,
      (v) => seen.push(v),
    )
    s.beginLoad()
    s.completeLoad(fakeMidi('ode.mid', 30))
    stop()
    // watch() defers the initial read — only transitions fire.
    expect(seen).toEqual(['loading', 'ready'])
    expect(s.state.duration).toBe(30)
    expect(s.state.loadedMidi?.name).toBe('ode.mid')
    expect(s.state.currentTime).toBe(0)
  })

  it('clearMidi resets everything back to idle', () => {
    const s = createLearnState()
    s.completeLoad(fakeMidi())
    s.setState('currentTime', 8)
    s.setState('status', 'playing')
    s.clearMidi()
    expect(s.state.loadedMidi).toBeNull()
    expect(s.state.duration).toBe(0)
    expect(s.state.currentTime).toBe(0)
    expect(s.state.status).toBe('idle')
  })

  it('status flips preserve loadedMidi and duration', () => {
    const s = createLearnState()
    s.completeLoad(fakeMidi())
    s.setState('status', 'playing')
    expect(s.state.status).toBe('playing')
    s.setState('status', 'paused')
    expect(s.state.status).toBe('paused')
    s.setState('status', 'ready')
    expect(s.state.status).toBe('ready')
    expect(s.state.loadedMidi).not.toBeNull()
  })
})
