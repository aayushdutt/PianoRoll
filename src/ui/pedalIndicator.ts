// Policy for the top-strip sustain-pedal chip, kept pure so it can be tested
// without App. Two questions: should the chip be on screen at all, and is the
// pedal down right now.
//
// Sources: the piece playing in Play/Learn (holds resolved by the parser) and
// the player's own pedal (MIDI or computer keyboard, already merged by
// LivePerformanceBus). Either can hold; the chip shows the union.

import { pedalDownAt } from '../core/midi/sustain'
import type { PedalInterval } from '../core/midi/types'

export interface PedalIndicatorInput {
  // The current mode's piece, or null when no piece is in charge (Live/Home).
  pieceHolds: readonly PedalInterval[] | null | undefined
  time: number
  liveDown: boolean
  midiConnected: boolean
  // A pedal was used from any live source this session — the computer
  // keyboard has a pedal key too, with no device to announce it.
  liveEverUsed: boolean
}

export interface PedalIndicatorState {
  visible: boolean
  down: boolean
}

export const PEDAL_HIDDEN: PedalIndicatorState = { visible: false, down: false }

// Visible when there is something to show: a pedalled piece, a connected
// device, or a pedal the player has already used. Hidden otherwise so a
// pop arrangement with no pedal doesn't carry a chip that never lights.
export function pedalIndicatorState(i: PedalIndicatorInput): PedalIndicatorState {
  const holds = i.pieceHolds && i.pieceHolds.length > 0 ? i.pieceHolds : null
  const visible = holds !== null || i.midiConnected || i.liveEverUsed
  const down = i.liveDown || (holds !== null && pedalDownAt(holds, i.time))
  return { visible, down }
}
