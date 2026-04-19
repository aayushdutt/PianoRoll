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

// Convert a CSS-style hex color (`#abcdef` / `#abc`) into a Pixi 0xRRGGBB
// number. Returns null on parse failure so callers can fall back.
function parseHexColor(s: string): number | null {
  const m = s.trim().match(/^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/)
  if (!m) return null
  let hex = m[1]!
  if (hex.length === 3) {
    hex = hex.split('').map(c => c + c).join('')
  }
  const n = parseInt(hex, 16)
  return Number.isFinite(n) ? n : null
}

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

  // Persistent practice-mode hint layer — sits underneath the active overlay
  // so a key the user has already pressed shows its accent over the hint
  // glow rather than fighting with it. Redrawn only when the hint changes.
  private practiceHintLayer: Graphics
  private practiceSignature = ''
  private practicePulsePhase = 0
  private practiceTickerHandler: ((ticker: import('pixi.js').Ticker) => void) | null = null
  private practicePending: ReadonlySet<number> | null = null
  private practiceAccepted: ReadonlySet<number> | null = null
  private practiceTheme: Theme | null = null

  // Snapshot of the last-drawn pitch→color map as a single signature string.
  // If nothing changed we skip the clear + redraw entirely (common during
  // sustained chords and idle frames).
  private lastSignature = ''
  private activeLayerDirty = true
  // Signature of the last baked-texture inputs (size + key positions + theme
  // colors). Used to short-circuit build() when nothing that affects the
  // baked RenderTextures has actually changed — skips a texture destroy/
  // recreate that would otherwise stall the GPU on every theme re-apply.
  private lastBuildSignature = ''

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
    this.practiceHintLayer = new Graphics()
    this.practiceHintLayer.label = 'keyboard-practice-hint'
    // Order matters: white active must sit above the white sprite but
    // below the black sprite. Black active sits at the top of the stack.
    // Sprites are inserted by build() at the correct indices.
    this.container.addChild(this.whiteActiveLayer)
    this.container.addChild(this.blackActiveLayer)
    // Practice hint sits at the very top so its pulse reads on both white
    // and black keys regardless of static-sprite layering.
    this.container.addChild(this.practiceHintLayer)
  }

  // Build or rebuild the static keyboard textures.
  // Call on init and whenever the canvas is resized.
  build(viewport: Viewport, yOffset: number): void {
    const { keyboardHeight, canvasWidth, pitchMin, pitchMax } = viewport.config
    const positions = viewport.getAllKeyPositions()

    // Skip the destroy+re-bake when every input to the bake is unchanged. All
    // the baked pixels depend on: canvas width, keyboard height, the pitch
    // range (which determines key positions), and the three theme colours
    // that tint the white/black keys and gap. Hitting this cache path turns
    // a theme re-apply or redundant rebuildStaticLayers() into a no-op.
    const sig =
      `${canvasWidth}x${keyboardHeight}|${pitchMin ?? 21}-${pitchMax ?? 108}|` +
      `${this.theme.whiteKey}.${this.theme.blackKey}.${this.theme.keyBorder}|y=${yOffset}`
    if (sig === this.lastBuildSignature && this.whiteSprite && this.blackSprite) {
      // Positions may still need to be re-cached if the caller swapped the
      // Viewport instance — but sig encodes every positional input, so
      // referential equality is fine here too.
      if (!this.lastPositions) this.lastPositions = new Map(positions)
      return
    }
    this.lastBuildSignature = sig

    // Snapshot for the practice-hint layer (which redraws on its own ticker
    // and doesn't otherwise have a Viewport reference handy).
    this.lastPositions = new Map(positions)

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
    this.practiceHintLayer.y = yOffset
    // Force a redraw of the hint layer on the next setPracticeHints call —
    // the geometry depends on the freshly-built viewport.
    this.practiceSignature = ''
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
    // Practice hint colours follow the active theme accent.
    this.practiceTheme = theme
    this.practiceSignature = ''
  }

  // Public hook for the parent renderer to swap in the current practice-mode
  // hint. Pass `null` to clear. The pulse animation runs on a private ticker so
  // the hint breathes even on frames where the main render loop is idle (file
  // playback paused, no live notes pending).
  setPracticeHints(
    pending: ReadonlySet<number> | null,
    accepted: ReadonlySet<number> | null,
    theme: Theme,
  ): void {
    this.practicePending = pending
    this.practiceAccepted = accepted
    this.practiceTheme = theme
    const sig = this.hintSignature(pending, accepted)
    if (sig !== this.practiceSignature) {
      this.practiceSignature = sig
      this.drawPracticeHints()
    }

    const wantTicker = !!pending && pending.size > 0
    if (wantTicker && !this.practiceTickerHandler) {
      this.practiceTickerHandler = (ticker) => {
        // ticker.deltaTime is Pixi units (~1 per 16.6ms). Scale to a slow
        // pulse — about one full breath every 1.4 seconds.
        this.practicePulsePhase += ticker.deltaTime * 0.075
        this.drawPracticeHints()
      }
      this.app.ticker.add(this.practiceTickerHandler)
    } else if (!wantTicker && this.practiceTickerHandler) {
      this.app.ticker.remove(this.practiceTickerHandler)
      this.practiceTickerHandler = null
      this.practicePulsePhase = 0
      this.practiceHintLayer.clear()
    }
  }

  private drawPracticeHints(): void {
    const layer = this.practiceHintLayer
    layer.clear()
    const pending = this.practicePending
    if (!pending || pending.size === 0) return
    const theme = this.practiceTheme ?? this.theme
    // Find any cached viewport positions via the static sprite as a proxy —
    // we need geometry, so we lazily walk the same map drawActiveKeys uses.
    // The container hosts a sprite for whites whose width matches canvasWidth.
    const yOffset = this.whiteSprite?.y ?? 0
    const totalH = (this.whiteSprite?.height ?? 0)
    if (totalH === 0) return

    // Pulse: 0..1 sine, normalised so even when the user has played part of
    // the chord the remaining keys keep a strong baseline glow.
    const pulse = 0.55 + 0.45 * Math.abs(Math.sin(this.practicePulsePhase))

    // Re-walk the keys we know about — pull positions from the saved sprite
    // by re-deriving from MIDI bounds. We only use the same data the render
    // pipeline already has access to (positions live in the Viewport, but
    // they're keyed by pitch). We grab them via the locallyRetained sprite
    // dimensions.
    // For correctness, draw each requested pitch by querying the parent for
    // positions through the public hint API; here we recompute approximate x
    // by mapping pitch index to width.
    // Pull the same key positions used at build time.
    const positions = this.lastPositions
    if (!positions) return

    layer.y = yOffset
    const accent = theme.uiAccentCSS
    const tint = parseHexColor(accent) ?? (theme.trackColors[0] ?? theme.nowLine)
    const fullKbHeight = totalH

    for (const pitch of pending) {
      const pos = positions.get(pitch)
      if (!pos) continue
      const isBlack = isBlackKey(pitch)
      const w = pos.width
      const x = pos.x
      const h = isBlack ? fullKbHeight * 0.62 : fullKbHeight - 4
      const y = isBlack ? 0 : 2
      const radius = isBlack ? 2 : 3

      // Halo — soft, thick, expands beyond the key footprint.
      const halos: readonly [number, number][] = [
        [12, 0.05 * pulse],
        [7,  0.10 * pulse],
        [3,  0.18 * pulse],
      ]
      for (const [expand, alpha] of halos) {
        layer.roundRect(x - expand, y - expand, w + expand * 2, h + expand * 2, radius + expand)
        layer.fill({ color: tint, alpha })
      }

      // Soft body fill — gentle, not as opaque as a press so the user can
      // still distinguish "next up" from "playing".
      const bodyAlpha = (isBlack ? 0.32 : 0.22) * pulse
      layer.roundRect(x, y, w, h, radius)
      layer.fill({ color: tint, alpha: bodyAlpha })

      // Top accent strip — a thin bar of the accent so the pulse has a focal
      // line. Sits inside the rounded corners.
      layer.rect(x + radius, y, w - radius * 2, 2)
      layer.fill({ color: tint, alpha: 0.55 * pulse })
    }
  }

  private hintSignature(
    pending: ReadonlySet<number> | null,
    accepted: ReadonlySet<number> | null,
  ): string {
    const p = pending ? Array.from(pending).sort().join('.') : ''
    const a = accepted ? Array.from(accepted).sort().join('.') : ''
    return `${p}|${a}`
  }

  // Cached so practice-hints can render without reaching back into Viewport.
  // Captured during `build()` from the same Viewport instance.
  private lastPositions: Map<number, { x: number; width: number }> | null = null

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
