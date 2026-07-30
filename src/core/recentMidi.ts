// Recently-opened MIDI files, persisted in IndexedDB so a returning user can
// re-open the last piece they dropped in without hunting for the file again.
//
// Why IndexedDB and not `core/persistence.ts`: that layer is localStorage —
// synchronous, string-only, and sharing a ~5 MB quota with every other
// setting. One multi-MB orchestral export would blow the quota and take the
// rest of the settings down with it. IDB stores the raw bytes off the main
// thread and keeps them out of everyone else's budget.
//
// We persist the ORIGINAL .mid bytes, never the parsed `MidiFile`: the parsed
// shape is derived data owned by `midi/parser.ts` (track ids, colour
// assignment, min-duration clamp) and would need its own schema version the
// moment that file changes. Re-parsing costs ~2 ms. Card metadata (title,
// duration, sparkline) is stored alongside so Home can paint recents without
// parsing anything on the critical path.
//
// Everything here is best-effort, exactly like `persistence.ts`: private
// browsing, evicted storage, blocked upgrades and quota errors all resolve to
// "no recents" rather than throwing at the caller. Losing a recent is never
// worth breaking a load.

import { parseMidiFile } from './midi/parser'
import type { MidiFile } from './midi/types'
import { computeSparkline } from './samples'

// How many entries survive; older ones are dropped on the next write. Deeper
// than the row can show on purpose — dismissing a card promotes the next one
// instead of leaving a hole, and the depth costs nothing until it's needed.
export const MAX_RECENTS = 5

/** Bars in the stored sparkline — must match the card renderer's bar count. */
export const SPARKLINE_BINS = 32

// Files above this never get stored. A recent is a convenience, not a backup:
// keeping a 20 MB import around risks eviction of the whole origin's storage.
const MAX_STORED_BYTES = 5 * 1024 * 1024

const DB_NAME = 'midee'
const DB_VERSION = 1
const STORE = 'recentMidi'

/** Card-facing metadata. Cheap to list; carries no note data. */
export interface RecentMidi {
  /** Content hash — re-opening the same file updates in place instead of duplicating. */
  id: string
  /** Original name as picked from disk, extension included. */
  fileName: string
  /** Parsed `MidiFile.name` — extension stripped. What the card shows. */
  displayName: string
  sizeBytes: number
  durationS: number
  trackCount: number
  noteCount: number
  /** Pitch-density bars in [0,1], `SPARKLINE_BINS` long. */
  sparkline: number[]
  addedAt: number
}

interface RecentMidiRecord extends RecentMidi {
  bytes: ArrayBuffer
}

// ── IndexedDB plumbing ────────────────────────────────────────────────────

let dbPromise: Promise<IDBDatabase | null> | null = null

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') {
        resolve(null)
        return
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = (): void => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' })
      }
      req.onsuccess = (): void => resolve(req.result)
      req.onerror = (): void => {
        console.warn('[recentMidi] open failed:', req.error)
        resolve(null)
      }
      // Another tab holds an older version open. Give up rather than hang.
      req.onblocked = (): void => resolve(null)
    } catch (err) {
      console.warn('[recentMidi] open threw:', err)
      resolve(null)
    }
  })
  return dbPromise
}

// Runs one request in its own transaction and resolves `null` on any failure.
// Each public operation is independently best-effort, so a partial sequence
// (put succeeded, trim failed) still leaves a usable store.
function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest,
): Promise<T | null> {
  return openDb().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) {
          resolve(null)
          return
        }
        try {
          const tx = db.transaction(STORE, mode)
          const req = run(tx.objectStore(STORE))
          req.onsuccess = (): void => resolve(req.result as T)
          req.onerror = (): void => {
            console.warn('[recentMidi] request failed:', req.error)
            resolve(null)
          }
          tx.onabort = (): void => resolve(null)
        } catch (err) {
          console.warn('[recentMidi] transaction threw:', err)
          resolve(null)
        }
      }),
  )
}

// Guards against schema drift and hand-edited databases — anything that isn't
// a well-formed record is treated as absent rather than crashing the card.
function isValidRecord(value: unknown): value is RecentMidiRecord {
  if (typeof value !== 'object' || value === null) return false
  const r = value as Partial<RecentMidiRecord>
  return (
    typeof r.id === 'string' &&
    typeof r.displayName === 'string' &&
    typeof r.addedAt === 'number' &&
    Array.isArray(r.sparkline) &&
    isArrayBuffer(r.bytes)
  )
}

// Not `instanceof`: structured clone can hand back a buffer from a different
// realm (iframe, test environment), where the constructor identity differs.
function isArrayBuffer(value: unknown): value is ArrayBuffer {
  return Object.prototype.toString.call(value) === '[object ArrayBuffer]'
}

function toMeta(record: RecentMidiRecord): RecentMidi {
  const { bytes: _bytes, ...meta } = record
  return meta
}

/** Newest first, capped at `MAX_RECENTS`. Never rejects. */
export async function listRecents(): Promise<RecentMidi[]> {
  const all = await withStore<unknown[]>('readonly', (s) => s.getAll())
  if (!all) return []
  return all
    .filter(isValidRecord)
    .sort((a, b) => b.addedAt - a.addedAt)
    .slice(0, MAX_RECENTS)
    .map(toMeta)
}

/**
 * Record a successfully-parsed upload. Call *after* the parse so we never
 * persist a file the app couldn't open. Fire-and-forget: failures are logged,
 * never thrown.
 */
export async function rememberRecent(file: File, midi: MidiFile): Promise<void> {
  try {
    if (file.size > MAX_STORED_BYTES) return
    const bytes = await file.arrayBuffer()
    const record: RecentMidiRecord = {
      // Same bytes → same id → `put` overwrites and bumps `addedAt`, so
      // re-opening a file moves it back to the front instead of taking a
      // second slot. Opening the same piece ten times still costs one entry.
      id: await hashBytes(bytes, file),
      fileName: file.name,
      displayName: midi.name,
      sizeBytes: file.size,
      durationS: midi.duration,
      trackCount: midi.tracks.length,
      noteCount: midi.tracks.reduce((n, track) => n + track.notes.length, 0),
      sparkline: computeSparkline(midi, SPARKLINE_BINS),
      addedAt: Date.now(),
      bytes,
    }
    await withStore('readwrite', (s) => s.put(record))
    await trimToCap()
  } catch (err) {
    console.warn('[recentMidi] remember failed:', err)
  }
}

/**
 * Re-parse a stored recent. Resolves `null` when the entry is gone (evicted,
 * cleared in another tab); rejects only if the stored bytes fail to parse,
 * which callers should treat as "drop this entry".
 */
export async function readRecentMidi(id: string): Promise<MidiFile | null> {
  const record = await withStore<unknown>('readonly', (s) => s.get(id))
  if (!isValidRecord(record)) return null
  return parseMidiFile(record.bytes, record.displayName)
}

/** Remove one entry. Never rejects. */
export async function forgetRecent(id: string): Promise<void> {
  await withStore('readwrite', (s) => s.delete(id))
}

async function trimToCap(): Promise<void> {
  const all = await withStore<unknown[]>('readonly', (s) => s.getAll())
  if (!all) return
  const stale = all
    .filter(isValidRecord)
    .sort((a, b) => b.addedAt - a.addedAt)
    .slice(MAX_RECENTS)
  for (const record of stale) await forgetRecent(record.id)
}

// Content hash so re-opening the same file dedupes even when it was renamed.
// `crypto.subtle` needs a secure context — over plain http (or in jsdom) we
// fall back to size+name, which still dedupes the common "same file twice"
// case without pulling in a hashing dependency.
async function hashBytes(bytes: ArrayBuffer, file: File): Promise<string> {
  try {
    if (typeof crypto === 'undefined' || !crypto.subtle) return fallbackId(file)
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    return Array.from(new Uint8Array(digest).slice(0, 8))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  } catch {
    return fallbackId(file)
  }
}

function fallbackId(file: File): string {
  return `sz${file.size}-${file.name}`
}
