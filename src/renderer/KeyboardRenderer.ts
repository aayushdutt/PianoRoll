import { Container, Graphics, RenderTexture, Sprite } from 'pixi.js'
import type { Application } from 'pixi.js'
import { MIDI_MIN, MIDI_MAX, isBlackKey } from '../core/midi/types'
import type { Theme } from './theme'
import type { Viewport } from './viewport'

// The static keyboard base is rendered once into a RenderTexture.
// The active-key overlay is a regular Graphics redrawn each frame —
// but it's cheap because only a handful of keys are ever active at once.

export class KeyboardRenderer {
  readonly container: Container

  private keyboardSprite: Sprite | null = null
  private activeLayer: Graphics
  private keyboardTexture: RenderTexture | null = null

  constructor(
    private app: Application,
    private theme: Theme,
  ) {
    this.container = new Container()
    this.container.label = 'keyboard'

    this.activeLayer = new Graphics()
    this.activeLayer.label = 'keyboard-active'
    this.container.addChild(this.activeLayer)
  }

  // Build or rebuild the static keyboard texture.
  // Call on init and whenever the canvas is resized.
  build(viewport: Viewport, yOffset: number): void {
    const { keyboardHeight, canvasWidth } = viewport.config
    const positions = viewport.getAllKeyPositions()

    // Destroy previous texture to avoid memory leaks
    this.keyboardTexture?.destroy()
    this.keyboardSprite?.destroy()

    const keyboardGraphics = new Graphics()

    // Background fill
    keyboardGraphics.rect(0, 0, canvasWidth, keyboardHeight)
    keyboardGraphics.fill({ color: this.theme.blackKey })

    // White keys first (drawn underneath black keys)
    for (let p = MIDI_MIN; p <= MIDI_MAX; p++) {
      if (isBlackKey(p)) continue
      const pos = positions.get(p)
      if (!pos) continue
      const margin = 1
      keyboardGraphics.roundRect(
        pos.x + margin,
        2,
        pos.width - margin * 2,
        keyboardHeight - 4,
        3,
      )
      keyboardGraphics.fill({ color: this.theme.whiteKey })
    }

    // Black keys on top
    for (let p = MIDI_MIN; p <= MIDI_MAX; p++) {
      if (!isBlackKey(p)) continue
      const pos = positions.get(p)
      if (!pos) continue
      keyboardGraphics.roundRect(
        pos.x,
        0,
        pos.width,
        keyboardHeight * 0.62,
        2,
      )
      keyboardGraphics.fill({ color: this.theme.blackKey })
    }

    // Render to texture once
    this.keyboardTexture = RenderTexture.create({ width: canvasWidth, height: keyboardHeight })
    this.app.renderer.render({ container: keyboardGraphics, target: this.keyboardTexture })
    keyboardGraphics.destroy()

    this.keyboardSprite = new Sprite(this.keyboardTexture)
    this.keyboardSprite.y = yOffset
    // Insert behind active layer
    this.container.addChildAt(this.keyboardSprite, 0)

    this.activeLayer.y = yOffset
  }

  // Called every frame — draws only the keys that are currently pressed.
  // Synthesia-style: a tinted key body plus a bright accent band at the top
  // where the falling note "lands", giving a clear landing-point cue.
  drawActiveKeys(activePitches: Set<number>, viewport: Viewport): void {
    this.activeLayer.clear()

    const { keyboardHeight } = viewport.config
    const positions = viewport.getAllKeyPositions()
    const accent = this.theme.trackColors[0] ?? this.theme.nowLine
    const bandThickness = Math.max(3, Math.round(keyboardHeight * 0.045))

    for (const pitch of activePitches) {
      const pos = positions.get(pitch)
      if (!pos) continue

      const isBlack = isBlackKey(pitch)
      const bodyColor = isBlack ? this.theme.blackKeyActive : this.theme.whiteKeyActive
      const h = isBlack ? keyboardHeight * 0.62 : keyboardHeight - 4
      const margin = isBlack ? 0 : 1
      const x = pos.x + margin
      const w = pos.width - margin * 2
      const y = isBlack ? 0 : 2
      const radius = isBlack ? 2 : 3

      // Body tint
      this.activeLayer.roundRect(x, y, w, h, radius)
      this.activeLayer.fill({ color: bodyColor, alpha: 0.88 })

      // Landing band (top edge, where notes meet the key)
      this.activeLayer.roundRect(x, y, w, bandThickness, radius)
      this.activeLayer.fill({ color: accent, alpha: 1 })
    }
  }

  updateTheme(theme: Theme): void {
    this.theme = theme
  }
}
