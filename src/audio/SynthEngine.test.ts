import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MidiFile, MidiNote, MidiTrack } from '../core/midi/types'
import { fakeAudioContext } from '../test/fakeAudioContext'

// ── Tone + instruments module mocks ────────────────────────────────────────
//
// SynthEngine reaches into Tone for the audio clock (`getContext`), the
// transport singleton (`getTransport`), `immediate()`, the `Part` scheduler,
// `gainToDb`/`getDestination`, and `start()`. It also pulls real instruments
// (which import Tone's synth classes) via `./instruments`. Both import chains
// fail to resolve under vitest's node ESM loader, so we mock them with fakes
// that RECORD calls — letting us assert scheduling order, the bpm
// double-scaling sequence, and the latest-wins race guard deterministically.
//
// `vi.mock` is hoisted above imports, so all shared state lives in a hoisted
// holder; the fakes read it lazily on every call (SynthEngine reads
// getContext()/getTransport() many times).

const holder = vi.hoisted(() => {
  // Ordered log of timing-relevant operations. The bpm double-scaling bug is
  // fundamentally about ORDER, so we capture a single interleaved sequence
  // rather than separate spies.
  const order: string[] = []

  const transport = {
    state: 'stopped' as 'stopped' | 'started' | 'paused',
    position: 0 as number | string,
    bpm: {
      _value: 120,
      get value() {
        return this._value
      },
      set value(v: number) {
        this._value = v
        order.push(`bpm=${v}`)
      },
    },
    start: vi.fn(() => {
      order.push('transport.start')
      transport.state = 'started'
    }),
    stop: vi.fn(() => {
      order.push('transport.stop')
      transport.state = 'stopped'
    }),
    pause: vi.fn(() => {
      transport.state = 'paused'
    }),
  }

  // Resolver for the awaited `toneStart()` inside play() — lets tests open a
  // window between play() being called and its async tail running so we can
  // inject a pause()/seek() to exercise the race guard.
  let startResolve: (() => void) | null = null
  let startPromise: Promise<void> = Promise.resolve()
  const armStartGate = () => {
    startPromise = new Promise<void>((res) => {
      startResolve = res
    })
  }
  const releaseStartGate = () => {
    startResolve?.()
    startResolve = null
  }

  return {
    ctx: null as ReturnType<typeof fakeAudioContext> | null,
    transport,
    order,
    // Records [callback, events] for every Part constructed so tests can
    // inspect the binary-search-sliced event list and fire the callback.
    parts: [] as Array<{
      events: [number, unknown][]
      callback: (time: number, ev: unknown) => void
      start: ReturnType<typeof vi.fn>
      stop: ReturnType<typeof vi.fn>
      clear: ReturnType<typeof vi.fn>
      dispose: ReturnType<typeof vi.fn>
    }>,
    destinationVolume: { value: 0 },
    immediateTime: 0,
    armStartGate,
    releaseStartGate,
    getStartPromise: () => startPromise,
  }
})

vi.mock('tone', () => {
  class FakePart {
    events: [number, unknown][]
    callback: (time: number, ev: unknown) => void
    start = vi.fn((_t?: number) => {
      holder.order.push('part.start')
    })
    stop = vi.fn()
    clear = vi.fn()
    dispose = vi.fn()
    constructor(callback: (time: number, ev: unknown) => void, events: [number, unknown][]) {
      this.callback = callback
      this.events = events
      holder.parts.push(this)
    }
  }
  return {
    getContext: () => holder.ctx,
    getTransport: () => holder.transport,
    getDestination: () => ({ volume: holder.destinationVolume }),
    gainToDb: (v: number) => v, // identity is fine for assertion purposes
    immediate: () => holder.immediateTime,
    Part: FakePart,
    start: () => holder.getStartPromise(),
  }
})

// Fake instrument runtime that records every trigger. createInstrument is async
// and resolves immediately so `ensureInstrument` settles on the first
// microtask flush.
const instrumentTriggers = vi.hoisted(
  () => [] as Array<{ note: string; duration: number; time: number; velocity: number }>,
)

// Records every created instrument runtime (one per instrument id, cached by
// SynthEngine) so tests can inspect `triggerAttack`/`triggerRelease` calls —
// used by the live-voice ref-counting tests below.
const createdInstruments = vi.hoisted(
  () =>
    [] as Array<{
      triggerAttack: ReturnType<typeof vi.fn>
      triggerRelease: ReturnType<typeof vi.fn>
    }>,
)

vi.mock('./instruments', async () => {
  // Pull in the real (tone-free) note-name table so slicing assertions read
  // human note names exactly as production would.
  const { midiToNoteName } = await import('./midiNoteName')
  return {
    INSTRUMENTS: [],
    midiToNoteName,
    createInstrument: vi.fn(async () => {
      const inst = {
        triggerAttack: vi.fn(),
        triggerRelease: vi.fn(),
        triggerAttackRelease: vi.fn(
          (note: string, duration: number, time: number, velocity: number) => {
            instrumentTriggers.push({ note, duration, time, velocity })
          },
        ),
        releaseAll: vi.fn(),
        dispose: vi.fn(),
      }
      createdInstruments.push(inst)
      return inst
    }),
  }
})

// Import AFTER the mocks are registered.
import { SynthEngine } from './SynthEngine'

// ── Fixtures ────────────────────────────────────────────────────────────────

function note(pitch: number, time: number, duration = 0.5, velocity = 0.8): MidiNote {
  return { pitch, time, duration, velocity }
}

function track(id: string, notes: MidiNote[]): MidiTrack {
  return {
    id,
    name: id,
    channel: 0,
    instrument: 0,
    isDrum: false,
    notes,
    color: 0xffffff,
    colorIndex: 0,
  }
}

function makeMidi(tracks: MidiTrack[], bpm = 120): MidiFile {
  const duration = Math.max(0, ...tracks.flatMap((t) => t.notes.map((n) => n.time + n.duration)))
  return { name: 'test.mid', duration, bpm, timeSignature: [4, 4], tracks }
}

// Build a SynthEngine with its instrument loaded so play() doesn't await a
// pending instrument load (load() resolves on the next microtask).
async function loadedEngine(midi: MidiFile): Promise<SynthEngine> {
  const engine = new SynthEngine()
  await engine.load(midi)
  return engine
}

// ── Setup / teardown ─────────────────────────────────────────────────────────

// jsdom has no `AudioBuffer`, but `load()` does `source instanceof AudioBuffer`.
// A plain class stub is enough: MidiFile fixtures are never instances of it, so
// the `instanceof` check is just false (the MidiFile branch is taken).
beforeAll(() => {
  if (!(globalThis as { AudioBuffer?: unknown }).AudioBuffer) {
    ;(globalThis as { AudioBuffer?: unknown }).AudioBuffer = class StubAudioBuffer {}
  }
})

beforeEach(() => {
  holder.ctx = fakeAudioContext(0)
  holder.order.length = 0
  holder.parts.length = 0
  holder.transport.state = 'stopped'
  holder.transport.position = 0
  holder.transport.bpm._value = 120
  holder.transport.start.mockClear()
  holder.transport.stop.mockClear()
  holder.transport.pause.mockClear()
  holder.destinationVolume.value = 0
  holder.immediateTime = 0
  instrumentTriggers.length = 0
  createdInstruments.length = 0
})

afterEach(() => {
  vi.clearAllMocks()
})

// ── 1. bpm double-scaling sequence ───────────────────────────────────────────

describe('SynthEngine.play — bpm double-scaling sequence', () => {
  it('schedules the Part at nominal bpm, then scales bpm AFTER part.start', async () => {
    const midi = makeMidi([track('a', [note(60, 0)])], 100)
    const engine = await loadedEngine(midi)
    engine.setSpeed(2)
    // setSpeed wrote a bpm value already; clear the log so we only assert the
    // play() sequence.
    holder.order.length = 0

    await engine.play(0)

    // The order that the long source comment warns must not be reordered:
    //   1. bpm set to NOMINAL (so Tone encodes ticks at the original tempo)
    //   2. part.start (events encoded at nominal-tick positions)
    //   3. bpm scaled to nominal*speed (transport now ticks `speed×` faster)
    //   4. transport.start
    const seq = holder.order.filter(
      (e) => e === 'part.start' || e === 'transport.start' || e.startsWith('bpm='),
    )
    expect(seq).toEqual(['bpm=100', 'part.start', 'bpm=200', 'transport.start'])
  })

  it('leaves the transport bpm at nominalBpm * speed when playback starts', async () => {
    const midi = makeMidi([track('a', [note(60, 0)])], 90)
    const engine = await loadedEngine(midi)
    engine.setSpeed(1.5)

    await engine.play(0)

    expect(holder.transport.bpm.value).toBe(135) // 90 * 1.5
  })

  it('keeps part.start strictly before the speed-scaled bpm write', async () => {
    const midi = makeMidi([track('a', [note(60, 0)])], 120)
    const engine = await loadedEngine(midi)
    engine.setSpeed(3)
    holder.order.length = 0

    await engine.play(0)

    const partIdx = holder.order.indexOf('part.start')
    const scaledIdx = holder.order.indexOf('bpm=360')
    expect(partIdx).toBeGreaterThanOrEqual(0)
    expect(scaledIdx).toBeGreaterThanOrEqual(0)
    // A reorder here silently desyncs audio vs the visual MasterClock.
    expect(partIdx).toBeLessThan(scaledIdx)
  })

  it('at speed 1 still performs both bpm writes around part.start (no skipped write)', async () => {
    const midi = makeMidi([track('a', [note(60, 0)])], 140)
    const engine = await loadedEngine(midi)
    holder.order.length = 0

    await engine.play(0)

    // At speed 1 both writes are bpm=140, but the sequence must still be
    // nominal-write → part.start → scaled-write. Asserting only the final value
    // would pass even if SynthEngine skipped the nominal write entirely, so we
    // pin the full bpm sub-sequence and that part.start sits between the writes.
    const bpmWrites = holder.order.filter((e) => e.startsWith('bpm='))
    expect(bpmWrites).toEqual(['bpm=140', 'bpm=140'])
    const firstBpmIdx = holder.order.indexOf('bpm=140')
    const lastBpmIdx = holder.order.lastIndexOf('bpm=140')
    const partIdx = holder.order.indexOf('part.start')
    expect(partIdx).toBeGreaterThan(firstBpmIdx)
    expect(partIdx).toBeLessThan(lastBpmIdx)
    expect(holder.transport.bpm.value).toBe(140)
  })
})

// ── 2. playGeneration latest-wins race ───────────────────────────────────────

describe('SynthEngine.play — latest-wins race guard', () => {
  it('aborts the stale play() when pause() runs during the toneStart() await', async () => {
    const midi = makeMidi([track('a', [note(60, 0)])], 120)
    const engine = await loadedEngine(midi)

    // Gate the awaited toneStart() so play() suspends right after readyPromise.
    holder.armStartGate()
    const playP = engine.play(0)
    // play() is now parked at `await toneStart()`. A user pauses mid-await.
    engine.pause()
    // Now let toneStart() resolve; the stale play() should bail at the
    // generation check and never reach transport.start().
    holder.releaseStartGate()
    await playP

    expect(holder.transport.start).not.toHaveBeenCalled()
    // No Part should have been scheduled for the aborted generation.
    expect(holder.parts.length).toBe(0)
  })

  it('aborts the stale play() when seek() runs during the await', async () => {
    const midi = makeMidi([track('a', [note(60, 0)])], 120)
    const engine = await loadedEngine(midi)

    // seek() only re-plays when the transport was already 'started'. Keep it
    // stopped so seek() just bumps the generation without launching a new play.
    holder.transport.state = 'stopped'

    holder.armStartGate()
    const playP = engine.play(0)
    engine.seek(5)
    holder.releaseStartGate()
    await playP

    expect(holder.transport.start).not.toHaveBeenCalled()
    expect(holder.parts.length).toBe(0)
  })

  it('a non-raced play() still reaches transport.start', async () => {
    const midi = makeMidi([track('a', [note(60, 0)])], 120)
    const engine = await loadedEngine(midi)

    await engine.play(0)

    expect(holder.transport.start).toHaveBeenCalledTimes(1)
    expect(holder.parts.length).toBe(1)
  })

  it('pause() bumps the generation so a later in-flight play tail aborts', async () => {
    const midi = makeMidi([track('a', [note(60, 0)])], 120)
    const engine = await loadedEngine(midi)

    // First, a clean play to put transport in 'started'.
    await engine.play(0)
    holder.transport.start.mockClear()
    holder.parts.length = 0

    // Now race: a fresh play() parked at the await, then a pause().
    holder.armStartGate()
    const playP = engine.play(2)
    engine.pause()
    holder.releaseStartGate()
    await playP

    expect(holder.transport.start).not.toHaveBeenCalled()
  })
})

// ── 3. binary-search note slicing at fromTime boundary ───────────────────────

describe('SynthEngine.play — binary-search slicing at fromTime', () => {
  it('includes notes at exactly fromTime (boundary not dropped)', async () => {
    const midi = makeMidi([track('a', [note(60, 0), note(62, 1), note(64, 2)])], 120)
    const engine = await loadedEngine(midi)

    await engine.play(1) // fromTime exactly on the second note

    const part = holder.parts[0]!
    // notes[mid].time < fromTime advances lo; `=== fromTime` is kept (>=).
    // So the note at t=1 and t=2 survive; t=0 is dropped.
    const offsets = part.events.map(([t]) => t)
    expect(offsets).toEqual([0, 1]) // (1-1)=0 and (2-1)=1
  })

  it('drops every note strictly before fromTime and rebases offsets', async () => {
    const midi = makeMidi(
      [track('a', [note(60, 0.0), note(62, 0.5), note(64, 1.0), note(65, 1.5)])],
      120,
    )
    const engine = await loadedEngine(midi)

    await engine.play(1.0)

    const part = holder.parts[0]!
    const offsets = part.events.map(([t]) => t)
    // 0.0 and 0.5 dropped; 1.0 → 0, 1.5 → 0.5
    expect(offsets).toEqual([0, 0.5])
  })

  it('does not duplicate the boundary note', async () => {
    const midi = makeMidi([track('a', [note(60, 1), note(62, 1), note(64, 1)])], 120)
    const engine = await loadedEngine(midi)

    await engine.play(1)

    const part = holder.parts[0]!
    // Three distinct notes all at t=1 — each appears exactly once, none twice.
    expect(part.events.length).toBe(3)
  })

  it('keeps everything when fromTime is 0', async () => {
    const midi = makeMidi([track('a', [note(60, 0), note(62, 1)])], 120)
    const engine = await loadedEngine(midi)

    await engine.play(0)

    expect(holder.parts[0]!.events.length).toBe(2)
  })

  it('slices each track independently across a multi-track file', async () => {
    const midi = makeMidi(
      [track('lead', [note(60, 0), note(62, 2)]), track('bass', [note(36, 1), note(38, 3)])],
      120,
    )
    const engine = await loadedEngine(midi)

    await engine.play(2)

    const part = holder.parts[0]!
    // lead: t=2 kept (offset 0); bass: t=3 kept (offset 1). t=0,1 dropped.
    const offsets = part.events.map(([t]) => t).sort((a, b) => a - b)
    expect(offsets).toEqual([0, 1])
  })

  it('the Part callback skips disabled-track notes but plays enabled ones', async () => {
    const midi = makeMidi([track('lead', [note(60, 0)]), track('mute', [note(48, 0)])], 120)
    const engine = await loadedEngine(midi)
    engine.setTrackEnabled('mute', false)

    await engine.play(0)

    const part = holder.parts[0]!
    // Fire the Part callback for every scheduled event as Tone's transport
    // would; only the enabled track should reach the instrument.
    for (const [, ev] of part.events) {
      part.callback(0.25, ev)
    }
    expect(instrumentTriggers.map((t) => t.note)).toEqual(['C4'])
  })
})

// ── 4. paused-resume fast path (does not rebuild the Part) ───────────────────

describe('SynthEngine.play — paused resume fast path', () => {
  it('resumes via transport.start without rebuilding the Part when fromTime matches', async () => {
    const midi = makeMidi([track('a', [note(60, 0)])], 120)
    const engine = await loadedEngine(midi)

    await engine.play(0)
    expect(holder.parts.length).toBe(1)

    // Simulate a pause: transport goes to 'paused', scheduledFromTime stays 0.
    holder.transport.state = 'paused'
    holder.transport.start.mockClear()

    await engine.play(0.01) // within the 0.05 tolerance of scheduledFromTime=0

    // Fast path: just resume, no second Part built.
    expect(holder.parts.length).toBe(1)
    expect(holder.transport.start).toHaveBeenCalledTimes(1)
  })

  it('rebuilds the Part when resuming at a different fromTime', async () => {
    const midi = makeMidi([track('a', [note(60, 0), note(62, 5)])], 120)
    const engine = await loadedEngine(midi)

    await engine.play(0)
    holder.transport.state = 'paused'

    await engine.play(5) // far from scheduledFromTime=0 → full rebuild

    expect(holder.parts.length).toBe(2)
  })
})

// ── 5. setSpeed / setVolume basic contracts ──────────────────────────────────

describe('SynthEngine — setSpeed / setVolume', () => {
  it('setSpeed scales transport bpm by midi.bpm immediately', async () => {
    const midi = makeMidi([track('a', [note(60, 0)])], 100)
    const engine = await loadedEngine(midi)

    engine.setSpeed(2)
    expect(holder.transport.bpm.value).toBe(200)
  })

  it('setSpeed falls back to 120 bpm when no midi is loaded', () => {
    const engine = new SynthEngine()
    engine.setSpeed(0.5)
    expect(holder.transport.bpm.value).toBe(60) // 120 * 0.5
  })

  it('setVolume routes through gainToDb onto the destination', async () => {
    const midi = makeMidi([track('a', [note(60, 0)])], 120)
    const engine = await loadedEngine(midi)

    engine.setVolume(0.42)
    expect(holder.destinationVolume.value).toBe(0.42) // gainToDb mocked to identity
  })
})

// ── 6. play() guards ─────────────────────────────────────────────────────────

describe('SynthEngine.play — guards', () => {
  it('is a no-op when no midi is loaded', async () => {
    const engine = new SynthEngine()
    await engine.play(0)
    expect(holder.transport.start).not.toHaveBeenCalled()
    expect(holder.parts.length).toBe(0)
  })

  it('clears the previous Part before building a new one on a fresh play', async () => {
    const midi = makeMidi([track('a', [note(60, 0), note(62, 5)])], 120)
    const engine = await loadedEngine(midi)

    await engine.play(0)
    const first = holder.parts[0]!

    holder.transport.state = 'started'
    await engine.play(5) // different fromTime → rebuild

    expect(first.dispose).toHaveBeenCalled()
    expect(holder.parts.length).toBe(2)
  })
})

// ── 7. live-voice equal-pitch reference counting ─────────────────────────────
//
// Multiple input sources (MIDI, computer keyboard, guitar fretboard) can hold
// the same MIDI pitch simultaneously — e.g. two guitar strings fretted to the
// same pitch, or a doubled note across MIDI + keyboard. Releasing one must not
// silence the pitch while another source still holds it.

describe('SynthEngine live-voice ref counting', () => {
  it('two sources on the same pitch: releasing one leaves the note sounding', async () => {
    const midi = makeMidi([track('a', [note(60, 0)])], 120)
    const engine = await loadedEngine(midi)
    const inst = createdInstruments[0]!

    engine.liveNoteOn(64, 0.8, 'source-a:1')
    engine.liveNoteOn(64, 0.8, 'source-b:1')
    expect(inst.triggerAttack).toHaveBeenCalledTimes(2)

    engine.liveNoteOff(64, 'source-a:1')
    expect(inst.triggerRelease).not.toHaveBeenCalled()

    engine.liveNoteOff(64, 'source-b:1')
    expect(inst.triggerRelease).toHaveBeenCalledTimes(1)
  })

  it('releases immediately when only one voice ever held the pitch', async () => {
    const midi = makeMidi([track('a', [note(60, 0)])], 120)
    const engine = await loadedEngine(midi)
    const inst = createdInstruments[0]!

    engine.liveNoteOn(67, 0.8, 'source-a:1')
    engine.liveNoteOff(67, 'source-a:1')
    expect(inst.triggerRelease).toHaveBeenCalledTimes(1)
  })

  it('is order-independent — the last release (regardless of which source) silences it', async () => {
    const midi = makeMidi([track('a', [note(60, 0)])], 120)
    const engine = await loadedEngine(midi)
    const inst = createdInstruments[0]!

    engine.liveNoteOn(60, 0.8, 'guitar:string-1')
    engine.liveNoteOn(60, 0.8, 'guitar:string-2')
    engine.liveNoteOn(60, 0.8, 'guitar:string-3')
    engine.liveNoteOff(60, 'guitar:string-2')
    engine.liveNoteOff(60, 'guitar:string-3')
    expect(inst.triggerRelease).not.toHaveBeenCalled()
    engine.liveNoteOff(60, 'guitar:string-1')
    expect(inst.triggerRelease).toHaveBeenCalledTimes(1)
  })

  it('a duplicate release for an already-cleared voice does not go negative and re-block release', async () => {
    const midi = makeMidi([track('a', [note(60, 0)])], 120)
    const engine = await loadedEngine(midi)
    const inst = createdInstruments[0]!

    engine.liveNoteOn(60, 0.8, 'v1')
    engine.liveNoteOff(60, 'v1')
    expect(inst.triggerRelease).toHaveBeenCalledTimes(1)
    // A second, redundant note-on/off pair for the same pitch behaves fresh —
    // the earlier pitch entry was already cleaned up.
    engine.liveNoteOn(60, 0.8, 'v2')
    engine.liveNoteOff(60, 'v2')
    expect(inst.triggerRelease).toHaveBeenCalledTimes(2)
  })

  it('liveReleaseAll clears held-voice tracking so a stale note-off cannot suppress a fresh press', async () => {
    const midi = makeMidi([track('a', [note(60, 0)])], 120)
    const engine = await loadedEngine(midi)
    const inst = createdInstruments[0]!

    engine.liveNoteOn(60, 0.8, 'v1')
    engine.liveNoteOn(60, 0.8, 'v2')
    engine.liveReleaseAll()
    inst.triggerRelease.mockClear()

    // Tracking was wiped by liveReleaseAll — a fresh single voice must release
    // on its own note-off instead of waiting for a phantom second release.
    engine.liveNoteOn(60, 0.8, 'v3')
    engine.liveNoteOff(60, 'v3')
    expect(inst.triggerRelease).toHaveBeenCalledTimes(1)
  })

  it('omitted voiceId (legacy touch/mouse) still round-trips through its own pitch key', async () => {
    const midi = makeMidi([track('a', [note(60, 0)])], 120)
    const engine = await loadedEngine(midi)
    const inst = createdInstruments[0]!

    engine.liveNoteOn(72, 0.8)
    engine.liveNoteOff(72)
    expect(inst.triggerRelease).toHaveBeenCalledTimes(1)
  })
})
