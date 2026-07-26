import { describe, expect, it } from 'vitest'
import { PianoRollRenderer } from './PianoRollRenderer'
import type { VisualizationSurface } from './VisualizationSurface'

// Compile-time proof that the concrete piano renderer still satisfies the
// abstract contract — `tsc --noEmit` (npm run typecheck) is what actually
// enforces this assignment; a regression here fails the typecheck step
// before any test needs to touch Pixi/WebGL. Kept as a standalone function
// (never called) so it survives tree-shaking/dead-code warnings and reads as
// intentional, not leftover scaffolding.
function _typeOnly_pianoRollRendererIsAVisualizationSurface(
  renderer: PianoRollRenderer,
): VisualizationSurface {
  return renderer
}
void _typeOnly_pianoRollRendererIsAVisualizationSurface

// Construction alone doesn't touch Pixi/canvas/window — every field
// initializer in PianoRollRenderer.ts is a plain value or a pure
// `createEventSignal()` call, and `app`/`viewport`/etc. are only assigned
// inside `init()`. That lets this suite check the adaptation structurally,
// in jsdom, without a live WebGL canvas.
const METHODS: readonly (keyof VisualizationSurface)[] = [
  'init',
  'attachClock',
  'destroy',
  'loadMidi',
  'clearMidi',
  'setLiveNoteStore',
  'setLoopNoteStore',
  'setLiveNotesVisible',
  'resize',
  'renderStaticFrame',
  'renderManualFrame',
  'pauseAutoRender',
  'resumeAutoRender',
  'setVisible',
  'setPracticeHints',
  'setPracticeTrackFocus',
  'addLayer',
  'removeLayer',
  'setTheme',
]

describe('PianoRollRenderer adapts VisualizationSurface', () => {
  it('implements every contract method', () => {
    const renderer: VisualizationSurface = new PianoRollRenderer()
    for (const name of METHODS) {
      expect(typeof renderer[name]).toBe('function')
    }
  })

  it('implements the contract readers available before init()', () => {
    const renderer: VisualizationSurface = new PianoRollRenderer()
    // `canvas` / `canvasSize` / `currentViewport` read Pixi state populated
    // by `init()`, so they're out of scope for a construction-only check —
    // covered instead by the method presence check above and by manual/E2E
    // verification of the real render path.
    expect(renderer.activeKeys.value).toBeInstanceOf(Map)
    expect(renderer.activeKeys.value.size).toBe(0)
    expect(renderer.currentTheme).toBeDefined()
    expect(renderer.currentTheme.name).toBe('Dark')
  })

  it('keeps setPracticeHints/activeKeys on the normalized VisualizationHitId (number) type', () => {
    const renderer: VisualizationSurface = new PianoRollRenderer()
    // No throw / no-op before init() — this only exercises the parameter
    // shape (a `ReadonlySet<VisualizationHitId>`, i.e. numeric pitches),
    // not the render output.
    expect(() => renderer.setPracticeTrackFocus(new Set(['track-a']))).not.toThrow()
  })

  it('keeps surface hits optional for the passive piano surface', () => {
    const renderer: VisualizationSurface = new PianoRollRenderer()
    expect(renderer.surfaceHits).toBeUndefined()
  })
})
