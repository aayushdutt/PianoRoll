import type { BusNoteEvent, InputSource } from '../input/InputBus'

/** A note event that has passed through the LivePerformanceBus — enriched with
 *  the merged pedal state so subscribers don't each re-derive it. */
export interface RoutedNoteEvent {
  pitch: number
  velocity: number
  clockTime: number
  source: InputSource
  sourceId?: string
  channel?: number
  voiceId?: string
  string?: number
  fret?: number
  /** True while any pedal source (MIDI or keyboard) is held. */
  pedalDown: boolean
}

export type NoteSink = (evt: RoutedNoteEvent) => void
export type PedalSink = (down: boolean) => void

/** Central fan-out hub for live performance note/pedal events. Owns:
 *  1. Pedal merge — keyboard OR MIDI pedal = global sustain.
 *  2. Sustained-pitches bookkeeping — repress-release logic.
 *  3. Subscriber fan-out — sinks receive normalised events.
 *
 *  The bus does NOT gate on app mode — callers (app.ts, modes) decide
 *  whether to route events through it. This keeps the bus pure while
 *  letting the orchestrator own policy. */
export interface LivePerformanceBus {
  readonly pedalDown: boolean
  /** Pitches currently held by the sustain pedal. Read-only. */
  readonly sustainedPitches: ReadonlySet<number>
  readonly sustainedVoiceIds: ReadonlySet<string>

  subscribeNotes(onNoteOn: NoteSink, onNoteOff: NoteSink): () => void
  subscribePedal(sink: PedalSink): () => void

  routeNoteOn(evt: BusNoteEvent): void
  routeNoteOff(evt: BusNoteEvent): void
  routePedalDown(source: InputSource): void
  routePedalUp(source: InputSource): void

  /** Emergency reset (blur / visibility hidden). Clears all pedal source
   *  flags, releases sustained pitches through note-off sinks (with real
   *  clockTime), and fires pedal subscribers (false). Leaves no stale
   *  state that could defer the next note-off. */
  forceReleaseAll(clockTime: number): void
}

export function createLivePerformanceBus(): LivePerformanceBus {
  const noteOnSinks = new Set<NoteSink>()
  const noteOffSinks = new Set<NoteSink>()
  const pedalSinks = new Set<PedalSink>()

  let _pedalDown = false
  const pedalSourceDown: Record<InputSource, boolean> = {
    midi: false,
    keyboard: false,
    touch: false,
    pi: false,
    guitar: false,
  }
  const sustainedVoices = new Map<string, RoutedNoteEvent>()

  function voiceKey(evt: BusNoteEvent): string {
    return (
      evt.voiceId ?? `legacy:${evt.source}:${evt.sourceId ?? ''}:${evt.channel ?? ''}:${evt.pitch}`
    )
  }

  function route(evt: BusNoteEvent, pedalDown: boolean): RoutedNoteEvent {
    return { ...evt, pedalDown }
  }

  function recomputePedal(): boolean {
    return (
      pedalSourceDown.midi ||
      pedalSourceDown.keyboard ||
      pedalSourceDown.touch ||
      pedalSourceDown.pi ||
      pedalSourceDown.guitar
    )
  }

  return {
    get pedalDown(): boolean {
      return _pedalDown
    },

    get sustainedPitches(): ReadonlySet<number> {
      return new Set(Array.from(sustainedVoices.values(), (event) => event.pitch))
    },

    get sustainedVoiceIds(): ReadonlySet<string> {
      return new Set(sustainedVoices.keys())
    },

    subscribeNotes(onNoteOn: NoteSink, onNoteOff: NoteSink): () => void {
      noteOnSinks.add(onNoteOn)
      noteOffSinks.add(onNoteOff)
      return () => {
        noteOnSinks.delete(onNoteOn)
        noteOffSinks.delete(onNoteOff)
      }
    },

    subscribePedal(sink: PedalSink): () => void {
      pedalSinks.add(sink)
      return () => {
        pedalSinks.delete(sink)
      }
    },

    routeNoteOn(evt: BusNoteEvent): void {
      // Repress-release: if a pitch was pedal-sustained, emit note-off first
      // so subscribers don't see overlapping note-ons.
      const key = voiceKey(evt)
      const sustained = sustainedVoices.get(key)
      if (sustained) {
        for (const fn of noteOffSinks) {
          fn({ ...sustained, velocity: 0, clockTime: evt.clockTime, pedalDown: _pedalDown })
        }
        sustainedVoices.delete(key)
      }

      for (const fn of noteOnSinks) fn(route(evt, _pedalDown))
    },

    routeNoteOff(evt: BusNoteEvent): void {
      if (_pedalDown) {
        sustainedVoices.set(voiceKey(evt), route(evt, _pedalDown))
        return
      }

      for (const fn of noteOffSinks) {
        fn(route(evt, _pedalDown))
      }
    },

    routePedalDown(source: InputSource): void {
      pedalSourceDown[source] = true
      const was = _pedalDown
      _pedalDown = recomputePedal()
      if (!was && _pedalDown) {
        for (const fn of pedalSinks) fn(true)
      }
    },

    routePedalUp(source: InputSource): void {
      pedalSourceDown[source] = false
      const was = _pedalDown
      _pedalDown = recomputePedal()
      if (was && !_pedalDown) {
        // Use a sentinel clockTime of -1 — natural pedal-up has no single
        // event time. Subscribers that care about clockTime should use
        // their own clock.currentTime; this value is a clear signal that
        // the timestamp is synthetic.
        for (const event of sustainedVoices.values()) {
          for (const fn of noteOffSinks) {
            fn({ ...event, velocity: 0, clockTime: -1, pedalDown: false })
          }
        }
        sustainedVoices.clear()
        for (const fn of pedalSinks) fn(false)
      }
    },

    forceReleaseAll(clockTime: number): void {
      const wasDown = _pedalDown
      pedalSourceDown.midi = false
      pedalSourceDown.keyboard = false
      pedalSourceDown.touch = false
      pedalSourceDown.pi = false
      pedalSourceDown.guitar = false
      _pedalDown = false

      if (wasDown) {
        for (const event of sustainedVoices.values()) {
          for (const fn of noteOffSinks) {
            fn({ ...event, velocity: 0, clockTime, pedalDown: false })
          }
        }
        for (const fn of pedalSinks) fn(false)
      }
      sustainedVoices.clear()
    },
  }
}
