import { describe, expect, it } from 'vitest'
import { layersAnimating, type RenderLayer } from './RenderLayer'

const layer = (id: string, isAnimating?: () => boolean): RenderLayer => ({
  id,
  zIndex: 5,
  mount: () => {},
  unmount: () => {},
  ...(isAnimating ? { isAnimating } : {}),
})

describe('layersAnimating', () => {
  it('is false with no layers registered', () => {
    expect(layersAnimating([])).toBe(false)
  })

  it('treats a layer without the hook as always animating', () => {
    expect(layersAnimating([layer('legacy')])).toBe(true)
  })

  it('is false when every layer opts out', () => {
    expect(layersAnimating([layer('a', () => false), layer('b', () => false)])).toBe(false)
  })

  it('is true when any layer is still animating', () => {
    expect(layersAnimating([layer('a', () => false), layer('b', () => true)])).toBe(true)
  })

  it('is true when a hookless layer is mixed with opted-out ones', () => {
    expect(layersAnimating([layer('a', () => false), layer('legacy')])).toBe(true)
  })

  it('re-reads the hook on every call (idle state can flip back)', () => {
    let animating = true
    const layers = [layer('a', () => animating)]
    expect(layersAnimating(layers)).toBe(true)
    animating = false
    expect(layersAnimating(layers)).toBe(false)
  })
})
