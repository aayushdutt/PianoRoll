import { describe, expect, it } from 'vitest'
import type { MidiFile } from '../../core/midi/types'
import { LearnState } from './LearnState'

function fakeMidi(name = 'etude.mid', duration = 15): MidiFile {
  return { name, duration, bpm: 120, timeSignature: [4, 4], tracks: [] }
}

describe('LearnState', () => {
  it('starts empty', () => {
    const s = new LearnState()
    expect(s.loadedMidi.value).toBeNull()
    expect(s.currentTime.value).toBe(0)
    expect(s.duration.value).toBe(0)
    expect(s.status.value).toBe('idle')
    expect(s.hasLoadedMidi).toBe(false)
  })

  it('beginLoad → completeLoad walks through loading → ready', () => {
    const s = new LearnState()
    const seen: string[] = []
    s.status.subscribe((v) => seen.push(v))
    s.beginLoad()
    s.completeLoad(fakeMidi('ode.mid', 30))
    expect(seen).toEqual(['loading', 'ready'])
    expect(s.duration.value).toBe(30)
    expect(s.loadedMidi.value?.name).toBe('ode.mid')
    expect(s.currentTime.value).toBe(0)
  })

  it('clearMidi resets everything back to idle', () => {
    const s = new LearnState()
    s.completeLoad(fakeMidi())
    s.setCurrentTime(8)
    s.startPlaying()
    s.clearMidi()
    expect(s.loadedMidi.value).toBeNull()
    expect(s.duration.value).toBe(0)
    expect(s.currentTime.value).toBe(0)
    expect(s.status.value).toBe('idle')
  })

  it('startPlaying / pausePlayback / setReady flip status only', () => {
    const s = new LearnState()
    s.completeLoad(fakeMidi())
    s.startPlaying()
    expect(s.status.value).toBe('playing')
    s.pausePlayback()
    expect(s.status.value).toBe('paused')
    s.setReady()
    expect(s.status.value).toBe('ready')
    // MIDI and duration should survive status flips.
    expect(s.loadedMidi.value).not.toBeNull()
  })
})
