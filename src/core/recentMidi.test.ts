import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type MidiFile, nominalTempoMap } from './midi/types'

// `recentMidi` caches its IDB handle at module level, so every test re-imports
// the module after installing (or removing) a fake `indexedDB`.

interface FakeStore {
  records: Map<string, unknown>
}

function installFakeIndexedDB(): FakeStore {
  const records = new Map<string, unknown>()

  // Minimal IDBRequest: resolve on a microtask so the caller has already
  // attached onsuccess/onerror by the time we fire.
  const request = (result: unknown): unknown => {
    const req: Record<string, unknown> = { result, error: null, onsuccess: null, onerror: null }
    queueMicrotask(() => (req.onsuccess as (() => void) | null)?.())
    return req
  }

  const objectStore = {
    getAll: () => request([...records.values()]),
    get: (id: string) => request(records.get(id)),
    put: (record: { id: string }) => {
      records.set(record.id, record)
      return request(undefined)
    },
    delete: (id: string) => {
      records.delete(id)
      return request(undefined)
    },
  }

  const db = {
    objectStoreNames: { contains: () => true },
    createObjectStore: () => objectStore,
    transaction: () => ({ objectStore: () => objectStore, onabort: null }),
  }

  ;(globalThis as { indexedDB?: unknown }).indexedDB = {
    open: () => {
      const req: Record<string, unknown> = {
        result: db,
        error: null,
        onsuccess: null,
        onerror: null,
        onupgradeneeded: null,
        onblocked: null,
      }
      queueMicrotask(() => {
        ;(req.onupgradeneeded as (() => void) | null)?.()
        ;(req.onsuccess as (() => void) | null)?.()
      })
      return req
    },
  }

  return { records }
}

function midiFixture(name: string, duration = 60): MidiFile {
  return {
    name,
    duration,
    bpm: 120,
    timeSignature: [4, 4],
    ...nominalTempoMap(120, [4, 4]),
    tracks: [
      {
        id: 'track-0',
        name: 'Piano',
        channel: 0,
        instrument: 0,
        isDrum: false,
        notes: [
          { pitch: 60, time: 0, duration: 1, velocity: 0.8 },
          { pitch: 64, time: 1, duration: 1, velocity: 0.8 },
        ],
        colorIndex: 0,
      },
    ],
  }
}

function midiFile(contents: string, fileName = `${contents}.mid`): File {
  const bytes = new TextEncoder().encode(contents)
  const file = new File([bytes], fileName, { type: 'audio/midi' })
  // jsdom's File has no `arrayBuffer()`; every browser we ship to does.
  Object.defineProperty(file, 'arrayBuffer', {
    value: async () => bytes.buffer.slice(0) as ArrayBuffer,
  })
  return file
}

async function loadModule(): Promise<typeof import('./recentMidi')> {
  vi.resetModules()
  return import('./recentMidi')
}

describe('recentMidi', () => {
  afterEach(() => {
    ;(globalThis as { indexedDB?: unknown }).indexedDB = undefined
    vi.useRealTimers()
  })

  describe('with storage available', () => {
    let store: FakeStore

    beforeEach(() => {
      store = installFakeIndexedDB()
    })

    it('stores a parsed upload and lists it back', async () => {
      const { listRecents, rememberRecent } = await loadModule()
      await rememberRecent(midiFile('alpha', 'alpha.mid'), midiFixture('alpha', 42))

      const [entry, ...rest] = await listRecents()
      expect(rest).toHaveLength(0)
      expect(entry).toMatchObject({
        fileName: 'alpha.mid',
        displayName: 'alpha',
        durationS: 42,
        trackCount: 1,
        noteCount: 2,
      })
      // Sparkline is precomputed so cards paint without re-parsing.
      expect(entry?.sparkline).toHaveLength(32)
    })

    it('dedupes a re-opened file instead of consuming both slots', async () => {
      vi.useFakeTimers()
      const { listRecents, rememberRecent } = await loadModule()

      await rememberRecent(midiFile('alpha'), midiFixture('alpha'))
      const first = (await listRecents())[0]?.addedAt

      vi.advanceTimersByTime(1000)
      await rememberRecent(midiFile('alpha'), midiFixture('alpha'))

      const entries = await listRecents()
      expect(entries).toHaveLength(1)
      // Same entry, refreshed — not a duplicate.
      expect(entries[0]?.addedAt).toBeGreaterThan(first ?? 0)
    })

    it('keeps only the newest MAX_RECENTS and evicts the rest from storage', async () => {
      vi.useFakeTimers()
      const { listRecents, MAX_RECENTS, rememberRecent } = await loadModule()

      // One more than the cap, oldest first.
      const names = Array.from({ length: MAX_RECENTS + 1 }, (_, i) => `file-${i}`)
      for (const name of names) {
        await rememberRecent(midiFile(name), midiFixture(name))
        vi.advanceTimersByTime(1000)
      }

      const entries = await listRecents()
      expect(entries).toHaveLength(MAX_RECENTS)
      // Newest first, and the oldest fell off the end.
      expect(entries.map((e) => e.displayName)).toEqual([...names].reverse().slice(0, MAX_RECENTS))
      // Trimmed entries are deleted, not merely hidden by the list cap.
      expect(store.records.size).toBe(MAX_RECENTS)
    })

    it('forgets an entry on request', async () => {
      const { forgetRecent, listRecents, rememberRecent } = await loadModule()
      await rememberRecent(midiFile('alpha'), midiFixture('alpha'))

      const id = (await listRecents())[0]?.id ?? ''
      await forgetRecent(id)

      expect(await listRecents()).toEqual([])
    })

    it('resolves null for an entry that is no longer stored', async () => {
      const { readRecentMidi } = await loadModule()
      expect(await readRecentMidi('missing')).toBeNull()
    })

    it('skips files too large to be worth keeping', async () => {
      const { listRecents, rememberRecent } = await loadModule()
      const huge = new File([new Uint8Array(6 * 1024 * 1024)], 'huge.mid')

      await rememberRecent(huge, midiFixture('huge'))

      expect(await listRecents()).toEqual([])
    })
  })

  describe('without storage', () => {
    // Private browsing, disabled storage, cross-origin iframe. Recents are a
    // convenience — every operation degrades to "no recents", never throws.
    it('degrades to an empty list instead of throwing', async () => {
      const { forgetRecent, listRecents, readRecentMidi, rememberRecent } = await loadModule()

      await expect(rememberRecent(midiFile('alpha'), midiFixture('alpha'))).resolves.toBeUndefined()
      await expect(listRecents()).resolves.toEqual([])
      await expect(readRecentMidi('anything')).resolves.toBeNull()
      await expect(forgetRecent('anything')).resolves.toBeUndefined()
    })
  })
})
