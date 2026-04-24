import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { jsonPersisted } from './persistence'

// Vitest runs in Node — no real DOM. Shim just enough of Storage for these
// tests; reverted in afterAll so this file doesn't leak globals into others.
function installLocalStorageShim(): () => void {
  const data = new Map<string, string>()
  const shim: Storage = {
    get length() {
      return data.size
    },
    clear: () => data.clear(),
    getItem: (k) => (data.has(k) ? data.get(k)! : null),
    key: (i) => Array.from(data.keys())[i] ?? null,
    removeItem: (k) => {
      data.delete(k)
    },
    setItem: (k, v) => {
      data.set(k, String(v))
    },
  }
  const prev = (globalThis as { localStorage?: Storage }).localStorage
  ;(globalThis as { localStorage?: Storage }).localStorage = shim
  return () => {
    if (prev === undefined) delete (globalThis as { localStorage?: Storage }).localStorage
    else (globalThis as { localStorage?: Storage }).localStorage = prev
  }
}

describe('jsonPersisted', () => {
  const key = 'midee.test.json'
  let uninstall: () => void

  beforeAll(() => {
    uninstall = installLocalStorageShim()
  })
  afterAll(() => {
    uninstall()
  })
  beforeEach(() => {
    localStorage.clear()
  })
  afterEach(() => {
    localStorage.clear()
  })

  it('returns the fallback when the key is missing', () => {
    const store = jsonPersisted(key, { count: 0 })
    expect(store.load()).toEqual({ count: 0 })
  })

  it('round-trips values through save/load', () => {
    const store = jsonPersisted<{ count: number; flags: string[] }>(key, { count: 0, flags: [] })
    store.save({ count: 3, flags: ['a', 'b'] })
    expect(store.load()).toEqual({ count: 3, flags: ['a', 'b'] })
  })

  it('returns the fallback on corrupted JSON', () => {
    localStorage.setItem(key, '{not valid json')
    const store = jsonPersisted(key, { count: -1 })
    expect(store.load()).toEqual({ count: -1 })
  })

  it('applies the migrate hook on load', () => {
    interface V1 {
      version: 1
      name: string
    }
    interface V2 {
      version: 2
      displayName: string
    }
    localStorage.setItem(key, JSON.stringify({ version: 1, name: 'old' }))
    const store = jsonPersisted<V2>(key, { version: 2, displayName: 'fresh' }, (raw) => {
      const v = raw as Partial<V1> | Partial<V2>
      if ('version' in v && v.version === 1 && 'name' in v && typeof v.name === 'string') {
        return { version: 2, displayName: v.name }
      }
      return raw as V2
    })
    expect(store.load()).toEqual({ version: 2, displayName: 'old' })
  })

  it('returns the fallback when migrate throws', () => {
    localStorage.setItem(key, JSON.stringify({ bogus: true }))
    const store = jsonPersisted(key, { ok: true }, () => {
      throw new Error('bad shape')
    })
    expect(store.load()).toEqual({ ok: true })
  })
})
