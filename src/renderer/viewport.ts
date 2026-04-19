import { isBlackKey, MIDI_MAX, MIDI_MIN } from '../core/midi/types'

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

    const blackZoneBottom = keyboardTop + keyboardHeight * 0.62
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
