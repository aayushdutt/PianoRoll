import type { Application } from 'pixi.js'
import { Container, Graphics, RenderTexture, Sprite, Texture, TilingSprite } from 'pixi.js'
import { isBlackKey, MIDI_MAX, MIDI_MIN } from '../core/midi/types'
import type { Theme } from './theme'
import type { Viewport } from './viewport'

// The static keyboard base is split into two RenderTextures — a white-keys
// sprite and a black-keys sprite — with the active-key overlay sandwiched
// between them. This lets a pressed white key's color be naturally clipped
// by any black keys sitting on top: the overlay draws on top of the white
// sprite, and the black sprite renders on top of the overlay, covering the
// occluded portions for free via z-order. No masks, no polygon math.
//
// Z-order (bottom → top):
//   1. whiteSprite       — bg + whites + depth + ivory wash + noise
//   2. whiteActiveLayer  — per-frame: tinted overlay for pressed white keys
//   3. blackSprite       — blacks + bevels + rails
//   4. blackActiveLayer  — per-frame: tinted overlay for pressed black keys

// One 96×96 greyscale noise tile is enough — it tiles imperceptibly
// across 88 keys. Cached at module scope so theme rebuilds don't
// re-roll the RNG (would cause visible shimmer across theme cycles).
let ivoryNoiseCanvas: HTMLCanvasElement | null = null
function getIvoryNoiseCanvas(): HTMLCanvasElement {
  if (ivoryNoiseCanvas) return ivoryNoiseCanvas
  const size = 96
  const c = document.createElement('canvas')
  c.width = size
  c.height = size
  const ctx = c.getContext('2d')!
  const img = ctx.createImageData(size, size)
  for (let i = 0; i < img.data.length; i += 4) {
    // Bias brightness high so the grain reads as "ivory", not "static".
    // Alpha is ~8% — subtle but visible on close look.
    const v = 200 + Math.random() * 55
    img.data[i] = v
    img.data[i + 1] = v
    img.data[i + 2] = v
    img.data[i + 3] = 20
  }
  ctx.putImageData(img, 0, 0)
  ivoryNoiseCanvas = c
  return c
}

export class KeyboardRenderer {
  readonly container: Container

  // Static baked layers
  private whiteSprite: Sprite | null = null
  private whiteTexture: RenderTexture | null = null
  private blackSprite: Sprite | null = null
  private blackTexture: RenderTexture | null = null

  // Per-frame active overlays — one per key colour (white vs black) so we
  // can insert the black sprite between them for automatic clipping.
  private whiteActiveLayer: Graphics
  private blackActiveLayer: Graphics

  // Snapshot of the last-drawn pitch→color map as a single signature string.
  // If nothing changed we skip the clear + redraw entirely (common during
  // sustained chords and idle frames).
  private lastSignature = ''
  private activeLayerDirty = true

  constructor(
    private app: Application,
    private theme: Theme,
  ) {
    this.container = new Container()
    this.container.label = 'keyboard'

    this.whiteActiveLayer = new Graphics()
    this.whiteActiveLayer.label = 'keyboard-active-white'
    this.blackActiveLayer = new Graphics()
    this.blackActiveLayer.label = 'keyboard-active-black'
    // Order matters: white active must sit above the white sprite but
    // below the black sprite. Black active sits at the top of the stack.
    // Sprites are inserted by build() at the correct indices.
    this.container.addChild(this.whiteActiveLayer)
    this.container.addChild(this.blackActiveLayer)
  }

  // Build or rebuild the static keyboard textures.
  // Call on init and whenever the canvas is resized.
  build(viewport: Viewport, yOffset: number): void {
    const { keyboardHeight, canvasWidth } = viewport.config
    const positions = viewport.getAllKeyPositions()

    // Destroy previous textures/sprites to avoid memory leaks. destroy()
    // also removes the sprite from its parent container.
    this.whiteTexture?.destroy()
    this.whiteSprite?.destroy()
    this.blackTexture?.destroy()
    this.blackSprite?.destroy()

    // ─── White bake ──────────────────────────────────────────────────
    // bg + white keys + depth cues + ivory wash + ivory grain noise.
    const whiteBake = new Container()

    // Background fill (shows through the 1px seams between white keys)
    const bg = new Graphics()
    bg.rect(0, 0, canvasWidth, keyboardHeight).fill({ color: this.theme.blackKey })
    whiteBake.addChild(bg)

    // White keys: body + ivory warmth + lighting depth.
    const whiteLayer = new Graphics()
    const wMargin = 1
    const wRadius = 3
    for (let p = MIDI_MIN; p <= MIDI_MAX; p++) {
      if (isBlackKey(p)) continue
      const pos = positions.get(p)
      if (!pos) continue
      const x = pos.x + wMargin
      const y = 2
      const w = pos.width - wMargin * 2
      const h = keyboardHeight - 4

      // Body
      whiteLayer.roundRect(x, y, w, h, wRadius).fill({ color: this.theme.whiteKey })

      // Ivory warmth wash — pure white keys read sterile; real ivory has a
      // cream undertone. A ~4% cream overlay shifts the whole material
      // toward "instrument" without tinting any one area obviously.
      whiteLayer.roundRect(x, y, w, h, wRadius).fill({ color: 0xfff1d8, alpha: 0.05 })

      // Top highlight — 4px, stacked rects simulate a soft gradient. Inset
      // by the corner radius so the highlight respects the key's rounded
      // corners and doesn't bleed into the seam between keys.
      whiteLayer.rect(x + wRadius, y, w - wRadius * 2, 1).fill({ color: 0xffffff, alpha: 0.35 })
      whiteLayer.rect(x + 1, y + 1, w - 2, 2).fill({ color: 0xffffff, alpha: 0.18 })
      whiteLayer.rect(x + 1, y + 3, w - 2, 2).fill({ color: 0xffffff, alpha: 0.08 })

      // Bottom shadow — 5px, three stacked rects fading into a strong 1px
      // edge line. Gives each key the "slightly dipped at the player's
      // edge" read you'd see on a real piano under stage lighting.
      whiteLayer.rect(x + 1, y + h - 5, w - 2, 3).fill({ color: 0x000000, alpha: 0.07 })
      whiteLayer.rect(x + 1, y + h - 2, w - 2, 1).fill({ color: 0x000000, alpha: 0.18 })
      whiteLayer
        .rect(x + wRadius, y + h - 1, w - wRadius * 2, 1)
        .fill({ color: 0x000000, alpha: 0.3 })
    }
    whiteBake.addChild(whiteLayer)

    // Ivory grain — tiled from a 96×96 noise canvas. Only appears on white
    // keys; the dark inter-key seams absorb it to invisibility against
    // the near-black bg.
    const noiseTex = Texture.from(getIvoryNoiseCanvas())
    const noise = new TilingSprite({
      texture: noiseTex,
      width: canvasWidth,
      height: keyboardHeight,
    })
    whiteBake.addChild(noise)

    this.whiteTexture = RenderTexture.create({ width: canvasWidth, height: keyboardHeight })
    this.app.renderer.render({ container: whiteBake, target: this.whiteTexture })
    whiteBake.destroy({ children: true })
    noiseTex.destroy(true)

    // ─── Black bake ──────────────────────────────────────────────────
    // Black keys + bevels + rails. Transparent background so the active
    // overlay below can show through inter-black-key gaps.
    const blackBake = new Container()
    const blackLayer = new Graphics()
    const bRadius = 2
    const blackHeight = keyboardHeight * 0.62
    for (let p = MIDI_MIN; p <= MIDI_MAX; p++) {
      if (!isBlackKey(p)) continue
      const pos = positions.get(p)
      if (!pos) continue
      const x = pos.x
      const y = 0
      const w = pos.width
      const h = blackHeight

      // Body
      blackLayer.roundRect(x, y, w, h, bRadius).fill({ color: this.theme.blackKey })

      // Top bevel — hints at the rounded physical top of a real black key.
      blackLayer.rect(x + bRadius, y, w - bRadius * 2, 1).fill({ color: 0xffffff, alpha: 0.28 })
      blackLayer.rect(x + 1, y + 1, w - 2, 2).fill({ color: 0xffffff, alpha: 0.12 })

      // Bottom lip — where the finger rests on a physical piano. A thin
      // bright edge catches light and sells the 3D form cheaply.
      blackLayer.rect(x + 1, y + h - 3, w - 2, 2).fill({ color: 0xffffff, alpha: 0.1 })
      blackLayer
        .rect(x + bRadius, y + h - 1, w - bRadius * 2, 1)
        .fill({ color: 0xffffff, alpha: 0.22 })

      // Side-edge rails — reflective highlights along the left and right
      // edges, running the full length. Directional asymmetry (left
      // brighter than right) sells a light source from the upper-left.
      const railY = y + bRadius
      const railH = h - bRadius * 2
      // Left rail (toward the light source)
      blackLayer.rect(x, railY, 1, railH).fill({ color: 0xffffff, alpha: 0.44 })
      blackLayer.rect(x + 1, railY, 1, railH).fill({ color: 0xffffff, alpha: 0.2 })
      // Right rail (opposite side, dimmer)
      blackLayer.rect(x + w - 1, railY, 1, railH).fill({ color: 0xffffff, alpha: 0.28 })
      blackLayer.rect(x + w - 2, railY, 1, railH).fill({ color: 0xffffff, alpha: 0.12 })
    }
    blackBake.addChild(blackLayer)

    this.blackTexture = RenderTexture.create({ width: canvasWidth, height: keyboardHeight })
    this.app.renderer.render({ container: blackBake, target: this.blackTexture })
    blackBake.destroy({ children: true })

    // ─── Assemble the z-stack ────────────────────────────────────────
    // After the destroys above, the container holds only the two active
    // layers [whiteActiveLayer, blackActiveLayer]. Reinsert the sprites
    // at the correct indices so the final order is:
    //   whiteSprite, whiteActiveLayer, blackSprite, blackActiveLayer
    this.whiteSprite = new Sprite(this.whiteTexture)
    this.whiteSprite.y = yOffset
    this.container.addChildAt(this.whiteSprite, 0)

    this.blackSprite = new Sprite(this.blackTexture)
    this.blackSprite.y = yOffset
    // After the whiteSprite insert at 0, the stack is:
    //   [whiteSprite, whiteActiveLayer, blackActiveLayer]
    // Insert blackSprite at index 2 so it lands between whiteActiveLayer
    // and blackActiveLayer.
    this.container.addChildAt(this.blackSprite, 2)

    this.whiteActiveLayer.y = yOffset
    this.blackActiveLayer.y = yOffset
  }

  // Called every frame — draws only the keys that are currently pressed, each
  // tinted with the color of the track/source it came from. Routes white and
  // black presses to separate Graphics layers so the black static sprite can
  // clip the white overlay by sitting on top of it in the z-stack.
  drawActiveKeys(activeByPitch: Map<number, number>, viewport: Viewport): void {
    const sig = this.signatureFor(activeByPitch)
    if (!this.activeLayerDirty && sig === this.lastSignature) return
    this.activeLayerDirty = false
    this.lastSignature = sig
    this.whiteActiveLayer.clear()
    this.blackActiveLayer.clear()

    const { keyboardHeight } = viewport.config
    const positions = viewport.getAllKeyPositions()
    const fallback = this.theme.trackColors[0] ?? this.theme.nowLine

    // Halos drawn first (so the solid body sits on top).
    const halos: readonly [number, number][] = [
      [10, 0.05],
      [6, 0.1],
      [3, 0.18],
    ]
    for (const [pitch, color] of activeByPitch) {
      const pos = positions.get(pitch)
      if (!pos) continue
      const tint = color || fallback
      const isBlack = isBlackKey(pitch)
      const layer = isBlack ? this.blackActiveLayer : this.whiteActiveLayer
      const h = isBlack ? keyboardHeight * 0.62 : keyboardHeight - 4
      const margin = isBlack ? 0 : 1
      const x = pos.x + margin
      const w = pos.width - margin * 2
      const y = isBlack ? 0 : 2
      const radius = isBlack ? 2 : 3

      for (const [expand, alpha] of halos) {
        layer.roundRect(x - expand, y - expand, w + expand * 2, h + expand * 2, radius + expand)
        layer.fill({ color: tint, alpha })
      }

      // Body — exact static-key shape so the active state lives inside the key's border.
      layer.roundRect(x, y, w, h, radius)
      layer.fill({ color: tint, alpha: isBlack ? 0.92 : 0.78 })
    }
  }

  updateTheme(theme: Theme): void {
    this.theme = theme
    // Colors baked into the active-key fill changed — force a redraw.
    this.activeLayerDirty = true
  }

  // Cheap change-detection: concatenate sorted pitch:color pairs. The map is
  // small (≤ ~10 active pitches at once) so this is essentially free and
  // catches both pitch-change and color-change in one check.
  private signatureFor(activeByPitch: Map<number, number>): string {
    if (activeByPitch.size === 0) return ''
    const parts: string[] = []
    for (const [pitch, color] of activeByPitch) parts.push(`${pitch}:${color}`)
    parts.sort()
    return parts.join(',')
  }
}
