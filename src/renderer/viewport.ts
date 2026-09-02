import { isBlackKey, MIDI_MAX, MIDI_MIN, type MidiNote } from '../core/midi/types'
import { BLACK_KEY_HEIGHT_RATIO } from './keyGeometry'

// The strike line sits directly on the keyboard edge so notes "land" where the
// keys begin instead of floating relative to the HUD.
const TRAIL_PX = 0

export interface ViewportConfig {
  canvasWidth: number
  canvasHeight: number
  keyboardHeight: number
  pixelsPerSecond: number
  // Visible pitch range — defaults to the full piano (21..108). Narrowing
  // these bounds makes each key wider and focuses the roll on a piece's
  // actual range (used by the "Fit to piece" export option).
  pitchMin?: number
  pitchMax?: number
}

export class Viewport {
  private cfg: ViewportConfig
  private keyPositions: Map<number, { x: number; width: number }> = new Map()

  constructor(cfg: ViewportConfig) {
    this.cfg = cfg
    this.buildKeyLayout()
  }

  update(partial: Partial<ViewportConfig>): void {
    const prevWidth = this.cfg.canvasWidth
    const prevMin = this.cfg.pitchMin
    const prevMax = this.cfg.pitchMax
    this.cfg = { ...this.cfg, ...partial }
    // Key layout depends on canvasWidth and the pitch range; skip the rebuild
    // when only zoom / keyboard height / canvas height change.
    if (
      this.cfg.canvasWidth !== prevWidth ||
      this.cfg.pitchMin !== prevMin ||
      this.cfg.pitchMax !== prevMax
    )
      this.buildKeyLayout()
  }

  get config(): Readonly<ViewportConfig> {
    return this.cfg
  }

  get rollHeight(): number {
    return this.cfg.canvasHeight - this.cfg.keyboardHeight
  }

  // Fixed position — aligned to the top edge of the keyboard.
  get nowLineY(): number {
    return this.rollHeight - TRAIL_PX
  }

  // How many seconds of "past" are visible below the now-line (decreases as zoom increases)
  get trailSeconds(): number {
    return TRAIL_PX / this.cfg.pixelsPerSecond
  }

  // How many seconds of "future" are visible above the now-line (decreases as zoom increases)
  get lookaheadSeconds(): number {
    return Math.max(1, this.rollHeight - TRAIL_PX) / this.cfg.pixelsPerSecond
  }

  // Convert a time offset relative to currentTime → Y pixel.
  // Positive delta = future (above now-line, smaller Y), negative = past (below, larger Y).
  timeOffsetToY(deltaSeconds: number): number {
    return this.nowLineY - deltaSeconds * this.cfg.pixelsPerSecond
  }

  pitchToX(pitch: number): number {
    return this.keyPositions.get(pitch)?.x ?? 0
  }

  pitchWidth(pitch: number): number {
    return this.keyPositions.get(pitch)?.width ?? 0
  }

  isTimeVisible(time: number, duration: number, currentTime: number): boolean {
    const start = time - currentTime
    const end = start + duration
    return end > -(this.trailSeconds + 0.5) && start < this.lookaheadSeconds + 0.5
  }

  getAllKeyPositions(): Map<number, { x: number; width: number }> {
    return this.keyPositions
  }

  // Find which piano key the given canvas-space point falls on.
  // Black keys are checked first because they visually sit on top of whites.
  pitchAtPoint(x: number, y: number): number | null {
    const { keyboardHeight, canvasHeight } = this.cfg
    const keyboardTop = canvasHeight - keyboardHeight
    if (y < keyboardTop || y > canvasHeight) return null

    const blackZoneBottom = keyboardTop + keyboardHeight * BLACK_KEY_HEIGHT_RATIO
    if (y <= blackZoneBottom) {
      for (const [pitch, pos] of this.keyPositions) {
        if (!isBlackKey(pitch)) continue
        if (x >= pos.x && x < pos.x + pos.width) return pitch
      }
    }

    for (const [pitch, pos] of this.keyPositions) {
      if (isBlackKey(pitch)) continue
      if (x >= pos.x && x < pos.x + pos.width) return pitch
    }
    return null
  }

  private buildKeyLayout(): void {
    this.keyPositions.clear()

    const pMin = Math.max(MIDI_MIN, this.cfg.pitchMin ?? MIDI_MIN)
    const pMax = Math.min(MIDI_MAX, this.cfg.pitchMax ?? MIDI_MAX)

    let wCount = 0
    for (let p = pMin; p <= pMax; p++) {
      if (!isBlackKey(p)) wCount++
    }
    if (wCount === 0) return

    const whiteW = this.cfg.canvasWidth / wCount
    const blackW = whiteW * 0.58
    const blackOffset = whiteW - blackW / 2

    let wIndex = 0
    for (let p = pMin; p <= pMax; p++) {
      if (isBlackKey(p)) continue
      this.keyPositions.set(p, { x: wIndex * whiteW, width: whiteW })
      wIndex++
    }

    for (let p = pMin; p <= pMax; p++) {
      if (!isBlackKey(p)) continue
      const left = this.keyPositions.get(p - 1)
      if (!left) continue
      this.keyPositions.set(p, { x: left.x + blackOffset, width: blackW })
    }
  }
}

/**
 * Returns a half-open index range [lo, hi) of the notes in `notes` (sorted by
 * note.time ascending) whose time window overlaps [visStart, visEnd].
 *
 * Upper bound — first note starting strictly after visEnd — is found in O(log N).
 * Lower bound — first note that might still extend into visStart — is found by
 * binary-searching for the first note.time >= visStart, then scanning backward
 * over any long notes that started before visStart but haven't ended yet.  That
 * scan is O(K) where K is the number of overlapping long-held notes (typically 0–3).
 *
 * Total cost: O(log N + K) vs the previous O(N) linear scan.
 */
export function visibleNoteRange(
  notes: readonly MidiNote[],
  visStart: number,
  visEnd: number,
): [number, number] {
  const len = notes.length
  if (len === 0) return [0, 0]

  // Upper bound: first index where note.time > visEnd.
  let lo = 0,
    hi = len
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (notes[mid]!.time <= visEnd) lo = mid + 1
    else hi = mid
  }
  const upper = lo

  // Lower bound: binary-search for first index where note.time >= visStart,
  // then scan back for any note that started before visStart but still extends in.
  lo = 0
  hi = upper
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (notes[mid]!.time < visStart) lo = mid + 1
    else hi = mid
  }
  while (lo > 0 && notes[lo - 1]!.time + notes[lo - 1]!.duration > visStart) lo--

  return [lo, upper]
}
