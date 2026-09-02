import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { booleanPersisted, idPersisted, jsonPersisted, numberPersisted } from './persistence'

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

// booleanPersisted / numberPersisted / idPersisted each have distinct
// parse logic. jsdom provides localStorage; clear between each test.

describe('booleanPersisted', () => {
  const key = 'midee.test.bool'
  beforeEach(() => localStorage.clear())

  it('round-trips true', () => {
    const s = booleanPersisted(key, false)
    s.save(true)
    expect(s.load()).toBe(true)
  })

  it('round-trips false', () => {
    const s = booleanPersisted(key, true)
    s.save(false)
    expect(s.load()).toBe(false)
  })

  it('returns the fallback when the key is missing', () => {
    expect(booleanPersisted(key, true).load()).toBe(true)
    expect(booleanPersisted(key, false).load()).toBe(false)
  })

  it('treats only the exact string "true" as truthy — "1" and "yes" return false', () => {
    // save() serialises via String(value), so only 'true'/'false' are ever
    // written by this module. The parse guard protects against external edits.
    localStorage.setItem(key, '1')
    expect(booleanPersisted(key, true).load()).toBe(false)
    localStorage.setItem(key, 'yes')
    expect(booleanPersisted(key, true).load()).toBe(false)
  })
})

describe('numberPersisted', () => {
  const key = 'midee.test.num'
  beforeEach(() => localStorage.clear())

  it('round-trips a value in range', () => {
    const s = numberPersisted(key, 50, 0, 100)
    s.save(75)
    expect(s.load()).toBe(75)
  })

  it('rounds fractional values on load', () => {
    // save() writes String(value); Number('75.7') is 75.7 → Math.round → 76.
    localStorage.setItem(key, '75.7')
    expect(numberPersisted(key, 50, 0, 100).load()).toBe(76)
  })

  it('returns the fallback for values above max', () => {
    localStorage.setItem(key, '101')
    expect(numberPersisted(key, 50, 0, 100).load()).toBe(50)
  })

  it('returns the fallback for values below min', () => {
    localStorage.setItem(key, '-1')
    expect(numberPersisted(key, 50, 0, 100).load()).toBe(50)
  })

  it('returns the fallback for NaN', () => {
    localStorage.setItem(key, 'NaN')
    expect(numberPersisted(key, 50, 0, 100).load()).toBe(50)
  })

  it('accepts exact boundary values', () => {
    const s = numberPersisted(key, 50, 0, 100)
    s.save(0)
    expect(s.load()).toBe(0)
    s.save(100)
    expect(s.load()).toBe(100)
  })
})

describe('idPersisted', () => {
  const key = 'midee.test.id'
  const legacyKey = 'midee.test.idIndex'
  const ids = ['dark', 'midnight', 'neon', 'sunset'] as const
  type Id = (typeof ids)[number]
  const legacy = { key: legacyKey, ids }

  beforeEach(() => localStorage.clear())

  it('round-trips a valid id', () => {
    const s = idPersisted<Id>(key, 'sunset', ids)
    s.save('neon')
    expect(localStorage.getItem(key)).toBe('neon')
    expect(s.load()).toBe('neon')
  })

  it('returns the fallback when the key is missing', () => {
    expect(idPersisted<Id>(key, 'sunset', ids).load()).toBe('sunset')
  })

  it('returns the fallback for an id that is not in the roster', () => {
    localStorage.setItem(key, 'chartreuse')
    expect(idPersisted<Id>(key, 'sunset', ids).load()).toBe('sunset')
  })

  it('migrates a legacy integer index and writes it under the new key', () => {
    localStorage.setItem(legacyKey, '2') // ids[2] === 'neon'
    const s = idPersisted<Id>(key, 'sunset', ids, legacy)
    expect(s.load()).toBe('neon')
    expect(localStorage.getItem(key)).toBe('neon')
    // Legacy key is left alone — inert once the new key exists.
    expect(localStorage.getItem(legacyKey)).toBe('2')
  })

  it('ignores a legacy index that is out of range', () => {
    localStorage.setItem(legacyKey, '9')
    const s = idPersisted<Id>(key, 'sunset', ids, legacy)
    expect(s.load()).toBe('sunset')
    expect(localStorage.getItem(key)).toBeNull()
  })

  it('ignores a non-integer legacy value', () => {
    localStorage.setItem(legacyKey, 'neon')
    expect(idPersisted<Id>(key, 'sunset', ids, legacy).load()).toBe('sunset')
  })

  it('prefers the new key over the legacy index and never re-migrates', () => {
    localStorage.setItem(key, 'midnight')
    localStorage.setItem(legacyKey, '2')
    expect(idPersisted<Id>(key, 'sunset', ids, legacy).load()).toBe('midnight')
  })

  it('does not consult the legacy key when the stored id is invalid', () => {
    localStorage.setItem(key, 'bogus')
    localStorage.setItem(legacyKey, '2')
    expect(idPersisted<Id>(key, 'sunset', ids, legacy).load()).toBe('sunset')
  })
})
