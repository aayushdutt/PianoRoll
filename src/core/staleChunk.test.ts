import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isChunkLoadError, reloadForStaleChunk } from './staleChunk'

const chunkErr = () =>
  new TypeError(
    'Failed to fetch dynamically imported module: https://midee.app/assets/ExportModal-BuPMcbdd.js',
  )

describe('staleChunk', () => {
  let reload: ReturnType<typeof vi.fn>

  beforeEach(() => {
    sessionStorage.clear()
    reload = vi.fn()
    vi.stubGlobal('location', { ...window.location, reload })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('recognises the browser chunk-fetch messages', () => {
    expect(isChunkLoadError(chunkErr())).toBe(true)
    expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true)
    expect(isChunkLoadError(new TypeError('error loading dynamically imported module'))).toBe(true)
    expect(isChunkLoadError(new Error('boom'))).toBe(false)
    expect(isChunkLoadError('Failed to fetch dynamically imported module')).toBe(false)
  })

  it('reloads once for a stale chunk', () => {
    expect(reloadForStaleChunk(chunkErr())).toBe(true)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('does not reload again inside the cooldown', () => {
    reloadForStaleChunk(chunkErr())
    expect(reloadForStaleChunk(chunkErr())).toBe(false)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('reloads again once the cooldown has passed', () => {
    sessionStorage.setItem('midee.staleChunkReload', String(Date.now() - 120_000))
    expect(reloadForStaleChunk(chunkErr())).toBe(true)
  })

  it('ignores unrelated errors', () => {
    expect(reloadForStaleChunk(new Error('boom'))).toBe(false)
    expect(reload).not.toHaveBeenCalled()
  })
})
