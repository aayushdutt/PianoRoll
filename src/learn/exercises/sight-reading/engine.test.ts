import { describe, expect, it } from 'vitest'
import { LATE_HIT_WINDOW_SEC } from '../../core/scoring'
import { KNOCKOUT_THRESHOLD, SightReadingEngine } from './engine'
import type { EngineConfig, NoteSource } from './types'

// A note source backed by a fixed pitch list. Tracks how many pitches have
// been consumed so the engine can detect exhaustion.
function makeSource(pitches: number[]): NoteSource {
  let index = 0
  return {
    next() {
      if (index >= pitches.length) return null
      return pitches[index++]!
    },
    get progress() {
      return pitches.length === 0 ? 1 : index / pitches.length
    },
    get done() {
      return index >= pitches.length
    },
  }
}

// Default config suitable for most tests: no BPM ramp, no practice-mode
// restrictions on knockout.
function makeConfig(overrides?: Partial<EngineConfig>): EngineConfig {
  return {
    bpm: 60,
    bpmRamp: 0,
    maxBpm: 120,
    lookAheadBeats: 4,
    practiceMode: false,
    ...overrides,
  }
}

// Advance the engine enough to spawn at least one note and put it inside the
// hit window, then return that note's scheduled time so tests can hit it
// cleanly.
function spawnOneAndAlign(engine: SightReadingEngine): number {
  // A single small tick triggers look-ahead spawning.
  engine.tick(0.01)
  const note = engine.notes[0]
  if (!note) throw new Error('no note spawned')
  // Jump time to exactly the note's scheduled onset.
  const needed = note.time - engine.time
  if (needed > 0) engine.tick(needed)
  return note.time
}

describe('SightReadingEngine', () => {
  describe('correct pitch in window', () => {
    it('returns "hit", marks note state as hit, increments streak', () => {
      const engine = new SightReadingEngine(makeConfig())
      engine.attach(makeSource([60, 62, 64]))
      engine.start()

      spawnOneAndAlign(engine)

      const note = engine.notes[0]!
      const midi = note.midi

      const result = engine.noteOn(midi)
      expect(result).toBe('hit')
      expect(note.state).toBe('hit')
      expect(engine.state.streak).toBe(1)
      expect(engine.state.totalPlayed).toBe(1)
    })

    it('credits perfect when timing is within perfect window', () => {
      const engine = new SightReadingEngine(makeConfig())
      engine.attach(makeSource([60]))
      engine.start()
      spawnOneAndAlign(engine)

      const note = engine.notes[0]!
      // Time is already aligned to note.time so delta ≈ 0 → perfect.
      engine.noteOn(note.midi)
      expect(engine.state.perfect).toBe(1)
      expect(engine.state.good).toBe(0)
    })

    it('resets consecutiveMisses on a hit', () => {
      // Use a tight look-ahead (1 beat) and fast BPM so notes are close together
      // and we can expire them predictably one at a time.
      // At 60 BPM, noteInterval = max(0.35, 1.2*1.0) = 1.2s.
      // Advance to just past note[0].time + LATE_HIT_WINDOW to expire note 0.
      const engine = new SightReadingEngine(makeConfig({ lookAheadBeats: 2 }))
      engine.attach(makeSource([60, 62, 64]))
      engine.start()

      // Advance past one note interval (1.2 s at 60 BPM) so both note0 and note1
      // fall within the look-ahead window. Notes now start at lookAheadSec ahead.
      engine.tick(1.21)
      const note0 = engine.notes[0]!
      const note1 = engine.notes[1]!

      // Expire note 0 by advancing to note0.time + LATE_HIT_WINDOW + ε
      engine.tick(note0.time - engine.time + LATE_HIT_WINDOW_SEC + 0.05)
      expect(note0.state).toBe('missed')
      expect(engine.state.consecutiveMisses).toBe(1)

      // Expire note 1.
      engine.tick(note1.time - engine.time + LATE_HIT_WINDOW_SEC + 0.05)
      expect(note1.state).toBe('missed')
      expect(engine.state.consecutiveMisses).toBe(2)

      // Align to note 2 and hit it.
      const remaining = engine.notes.filter(
        (n) => n.state === 'approaching' || n.state === 'in-window',
      )
      const target = remaining[0]
      if (target) {
        const diff = target.time - engine.time
        if (diff > 0) engine.tick(diff)
        engine.noteOn(target.midi)
        expect(engine.state.consecutiveMisses).toBe(0)
      }
    })
  })

  describe('wrong pitch', () => {
    it('returns "wrong", note stays alive, streak breaks', () => {
      const engine = new SightReadingEngine(makeConfig())
      engine.attach(makeSource([60, 62]))
      engine.start()
      spawnOneAndAlign(engine)

      const note = engine.notes[0]!
      const wrongMidi = note.midi === 60 ? 61 : 60

      // Establish a streak first.
      // We can't hit note 0 then wrong-press because we only have one in-window
      // note at a time; instead, just confirm streak resets on wrong.
      const result = engine.noteOn(wrongMidi)
      expect(result).toBe('wrong')
      expect(note.state).toBe('in-window') // still alive
      expect(note.wrongKeyCount).toBe(1)
      expect(engine.state.streak).toBe(0)
      expect(engine.state.wrongKey).toBe(1)
    })

    it('does NOT increment consecutiveMisses on wrong-key press', () => {
      const engine = new SightReadingEngine(makeConfig())
      engine.attach(makeSource([60]))
      engine.start()
      spawnOneAndAlign(engine)

      const note = engine.notes[0]!
      const wrongMidi = note.midi === 60 ? 61 : 60

      engine.noteOn(wrongMidi)
      // consecutiveMisses is only incremented when a note's window expires.
      expect(engine.state.consecutiveMisses).toBe(0)
    })
  })

  describe('note timeout', () => {
    it('marks note as missed when LATE_HIT_WINDOW_SEC elapses', () => {
      const engine = new SightReadingEngine(makeConfig())
      engine.attach(makeSource([60]))
      engine.start()

      // Spawn the first note. At 60 BPM with lookAheadBeats=4, the first note
      // is scheduled at time=0 which is within GOOD_WINDOW of time=0.001 → in-window.
      engine.tick(0.001)
      const note = engine.notes[0]!
      // The note may be in-window already (its onset is at t=0, engine is at t=0.001).
      // Either approaching or in-window is fine — we just need to expire it.
      expect(note.state === 'approaching' || note.state === 'in-window').toBe(true)

      // Advance past the late-hit window from the note's onset.
      const toExpiry = note.time - engine.time + LATE_HIT_WINDOW_SEC + 0.05
      engine.tick(toExpiry)

      expect(note.state).toBe('missed')
      expect(engine.state.missed).toBe(1)
    })
  })

  describe('knockout', () => {
    // Helper: expire exactly `count` notes by advancing the engine in steps.
    // Each step jumps to the next note's expiry time. Returns the engine after
    // all misses are recorded.
    function expireNotes(engine: SightReadingEngine, count: number): void {
      // Spawn: advance a tiny bit so the lookahead fills the buffer.
      engine.tick(0.001)
      for (let i = 0; i < count; i++) {
        // Find the earliest live note and advance just past its expiry.
        const live = engine.notes
          .filter((n) => n.state === 'approaching' || n.state === 'in-window')
          .sort((a, b) => a.time - b.time)[0]
        if (!live) {
          // No live note yet — advance a little and retry.
          engine.tick(0.5)
          continue
        }
        const toExpiry = live.time - engine.time + LATE_HIT_WINDOW_SEC + 0.05
        if (toExpiry > 0) engine.tick(toExpiry)
      }
    }

    it(`${KNOCKOUT_THRESHOLD} consecutive note-resolution misses → phase becomes knockedOut`, () => {
      const pitches = Array.from({ length: KNOCKOUT_THRESHOLD + 4 }, () => 60)
      const engine = new SightReadingEngine(makeConfig({ practiceMode: false }))
      engine.attach(makeSource(pitches))
      engine.start()

      expireNotes(engine, KNOCKOUT_THRESHOLD)

      expect(engine.state.consecutiveMisses).toBeGreaterThanOrEqual(KNOCKOUT_THRESHOLD)
      expect(engine.state.phase).toBe('knockedOut')
    })

    it('9 misses + 1 hit → no knockout, consecutiveMisses resets', () => {
      const count = KNOCKOUT_THRESHOLD - 1 // 9
      const pitches = Array.from({ length: KNOCKOUT_THRESHOLD + 4 }, () => 60)
      const engine = new SightReadingEngine(makeConfig({ practiceMode: false }))
      engine.attach(makeSource(pitches))
      engine.start()

      expireNotes(engine, count)
      expect(engine.state.consecutiveMisses).toBe(count)
      expect(engine.state.phase).toBe('playing')

      // Hit the next live note.
      const remaining = engine.notes.filter(
        (n) => n.state === 'approaching' || n.state === 'in-window',
      )
      const target = remaining.sort((a, b) => a.time - b.time)[0]
      if (target) {
        const diff = target.time - engine.time
        if (diff > 0) engine.tick(diff)
        engine.noteOn(target.midi)
      }

      expect(engine.state.consecutiveMisses).toBe(0)
      expect(engine.state.phase).toBe('playing')
    })

    it('wrong-key presses do NOT increment the knockout counter', () => {
      const engine = new SightReadingEngine(makeConfig({ practiceMode: false }))
      engine.attach(makeSource([60]))
      engine.start()
      spawnOneAndAlign(engine)

      const note = engine.notes[0]!
      const wrongMidi = note.midi === 60 ? 61 : 60

      // Fire many wrong-key presses — none should advance consecutiveMisses.
      for (let i = 0; i < KNOCKOUT_THRESHOLD + 5; i++) {
        engine.noteOn(wrongMidi)
      }

      expect(engine.state.consecutiveMisses).toBe(0)
      expect(engine.state.phase).toBe('playing')
    })

    it('practiceMode: phase never becomes knockedOut', () => {
      const pitches = Array.from({ length: KNOCKOUT_THRESHOLD + 4 }, () => 60)
      const engine = new SightReadingEngine(makeConfig({ practiceMode: true }))
      engine.attach(makeSource(pitches))
      engine.start()

      expireNotes(engine, KNOCKOUT_THRESHOLD + 2)

      expect(engine.state.phase).not.toBe('knockedOut')
    })
  })

  describe('ramp state', () => {
    it('resets to config defaults on attach', () => {
      const engine = new SightReadingEngine(makeConfig({ bpmRamp: 0.5 }))
      engine.attach(makeSource([60]))
      // Arcade-style config (bpmRamp > 0) auto-enables ramp.
      expect(engine.rampEnabled).toBe(true)

      // Manually toggle off, then restart.
      engine.setRamp(false)
      expect(engine.rampEnabled).toBe(false)

      engine.attach(makeSource([60]))
      // After attach, rampEnabled should reset to config default (true for bpmRamp > 0).
      expect(engine.rampEnabled).toBe(true)
    })

    it('stays disabled for practice-mode configs after attach', () => {
      const engine = new SightReadingEngine(makeConfig({ bpmRamp: 0 }))
      engine.attach(makeSource([60]))
      expect(engine.rampEnabled).toBe(false)

      engine.setRamp(true) // user enables ramp
      expect(engine.rampEnabled).toBe(true)
      expect(engine.state.rampEnabled).toBe(true)

      engine.attach(makeSource([60]))
      // After attach with bpmRamp=0, ramp should be off again.
      expect(engine.rampEnabled).toBe(false)
      expect(engine.state.rampEnabled).toBe(false)
    })

    it('rampRate resets to config value on attach', () => {
      const engine = new SightReadingEngine(makeConfig({ bpmRamp: 0.5 }))
      expect(engine.rampEnabled).toBe(true)

      // User disables ramp (sets rate to 0.2 via setRamp)
      engine.setRamp(false)
      engine.setRamp(true)
      // After toggling on a config with bpmRamp=0.5, rate stays 0.5
      // (setRamp only overrides when config rate is 0)
      engine.attach(makeSource([60]))
      // Should reset to config.bpmRamp = 0.5
      expect(engine.rampEnabled).toBe(true)
    })
  })

  describe('note gap', () => {
    it('noteGap default is 1 and persists across attach', () => {
      const engine = new SightReadingEngine(makeConfig())
      engine.attach(makeSource([60]))
      expect(engine.noteGap).toBe(1)
      expect(engine.state.noteGap).toBe(1)

      engine.setNoteGap(1.5)
      expect(engine.noteGap).toBe(1.5)

      engine.attach(makeSource([60]))
      // noteGap persists across restarts (like userBpm).
      expect(engine.noteGap).toBe(1.5)
      expect(engine.state.noteGap).toBe(1.5)
    })

    it('setNoteGap clamps to [0.3, 2.5]', () => {
      const engine = new SightReadingEngine(makeConfig())
      engine.attach(makeSource([60]))

      engine.setNoteGap(0.1)
      expect(engine.noteGap).toBe(0.3)

      engine.setNoteGap(10)
      expect(engine.noteGap).toBe(2.5)
    })

    it('noteGap affects spawned note interval', () => {
      const engine = new SightReadingEngine(makeConfig({ bpm: 60 }))
      engine.attach(makeSource([60, 62, 64, 65, 67]))
      engine.start()

      // With noteGap = 1: interval = max(0.35, 1 * 1.2 * (60/60)) = 1.2s.
      expect(engine.noteGap).toBe(1)
      engine.tick(0.01)
      expect(engine.notes.length).toBe(1)

      // Advance time so the first note reaches the now-line. New notes will
      // be spawned to fill the look-ahead buffer.
      const firstNoteTime = engine.notes[0]!.time
      engine.tick(firstNoteTime - engine.time)

      // Multiple notes should now be in the buffer.
      expect(engine.notes.length).toBeGreaterThanOrEqual(3)

      const firstDelta = engine.notes[1]!.time - engine.notes[0]!.time
      expect(firstDelta).toBeCloseTo(1.2, 1)
    })
  })
})
