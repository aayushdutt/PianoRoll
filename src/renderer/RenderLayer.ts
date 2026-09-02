import type { Container } from 'pixi.js'
import type { Theme } from './theme'
import type { Viewport } from './viewport'

// Per-frame / on-rebuild context passed to every external layer. Exposes the
// primitives a layer needs to draw without giving it a handle on the renderer
// itself — keeps dependencies one-way and lets the renderer evolve without
// breaking layer implementations.
export interface RenderContext {
  viewport: Viewport
  theme: Theme
  time: number
  dt: number
}

// A pluggable visual overlay hosted by PianoRollRenderer. Learn-mode overlays
// (target zone, loop-region band, staff cursor, etc.)
// implement this interface and register themselves via `addLayer` when the
// exercise mounts. The renderer owns draw order via `zIndex`; ties break in
// insertion order.
//
// Built-in scene pieces (notes, keyboard, particles, beat grid, live notes)
// remain inside the renderer today — this interface is only for *additive*
// layers on top. If a future refactor wants to migrate the built-ins onto the
// same interface, that's a deliberate follow-up, not a prerequisite.
export interface RenderLayer {
  readonly id: string
  // Higher z renders later (on top). Built-in layers occupy integer slots
  // 0–10 roughly; external layers should pick a zone that matches intent:
  //   5  — above the note roll, below the keyboard
  //   15 — above the keyboard (foreground HUD-ish overlays)
  readonly zIndex: number

  // Called once when the layer is attached. Implementations typically create
  // a Pixi Container / Graphics and add it to `stage`.
  mount(stage: Container): void

  // Called once when the layer is detached. Must release any Pixi objects
  // and detach event listeners — the renderer does not clean up for you.
  unmount(): void

  // Called every animation frame while the renderer is ticking. Skip if the
  // layer is purely static after `rebuild`.
  update?(ctx: RenderContext): void

  // Called when static state changes (viewport resize, theme swap, keyboard
  // height, zoom). Redraw anything that depends on layout.
  rebuild?(ctx: RenderContext): void

  // Whether this layer still has something to animate right now. The renderer
  // idle-stops its ticker once nothing on screen is moving; a layer that
  // returns `false` is declaring it will draw identical pixels until something
  // calls back into it.
  //
  // Omitting the hook (or returning `true`) means "always animating", which
  // keeps the render loop alive. That is the safe default: a layer whose
  // imperative API (pulse, celebrate, …) doesn't call `renderer.wake()` MUST
  // NOT return `false`, or the effect would never be drawn.
  isAnimating?(): boolean
}

// Whether any registered layer still needs per-frame redraws. Extracted as a
// pure function so the idle-stop decision is testable without a Pixi
// Application: `PianoRollRenderer.onTick` folds it in with the clock / live
// note / particle checks.
export function layersAnimating(layers: readonly RenderLayer[]): boolean {
  for (const layer of layers) {
    // Omitting the hook means "always animating" — the conservative default
    // that matches the behaviour before `isAnimating` existed.
    if (!layer.isAnimating || layer.isAnimating()) return true
  }
  return false
}
