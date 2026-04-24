import type { MidiNoteEvent } from '../../midi/MidiInputManager'
import { Signal } from '../../store/state'

// Where a note/pedal event entered the app. Subscribers use this for telemetry
// (per-source first-note counting) and occasionally to gate behavior — but the
// default policy is "treat every source equally; the user pressed a key".
export type InputSource = 'midi' | 'keyboard' | 'touch'

export interface BusNoteEvent extends MidiNoteEvent {
  source: InputSource
}

export interface BusPedalEvent {
  down: boolean
  source: InputSource
}

// Single fan-out point for note-ons / note-offs / pedal events from any input
// source (hardware MIDI, computer keyboard, on-screen touch). Producers call
// the `emit*` methods; consumers (App live handler, exercise runners, ...)
// subscribe to the signals.
//
// The bus is a transport layer — it does not merge multi-source pedal state.
// Callers that need a "pedal is down from any source" view maintain their own
// per-source flags and OR them (see App.applyPedalState). Keeping the bus
// dumb means exercises can observe each source independently if they want.
export class InputBus {
  readonly noteOn = new Signal<BusNoteEvent | null>(null)
  readonly noteOff = new Signal<BusNoteEvent | null>(null)
  readonly pedal = new Signal<BusPedalEvent | null>(null)

  emitNoteOn(evt: MidiNoteEvent, source: InputSource): void {
    this.noteOn.set({ ...evt, source })
  }

  emitNoteOff(evt: MidiNoteEvent, source: InputSource): void {
    this.noteOff.set({ ...evt, source })
  }

  emitPedal(down: boolean, source: InputSource): void {
    this.pedal.set({ down, source })
  }
}
