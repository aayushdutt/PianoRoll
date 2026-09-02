// Typed localStorage-backed values. Each entry knows its key, its default, and
// how to parse the stored string — so call sites just see `.load()` and
// `.save(value)` without repeating the parse/fallback dance.
//
// Everything is namespaced under `midee.*` in localStorage. Bump the prefix
// here if we ever need a schema reset.

export interface Persisted<T> {
  load: () => T
  save: (value: T) => void
}

function persisted<T>(key: string, fallback: T, parse: (raw: string) => T | null): Persisted<T> {
  return {
    load(): T {
      const raw = safeGetItem(key)
      if (raw === null) return fallback
      const parsed = parse(raw)
      return parsed === null ? fallback : parsed
    },
    save(value: T): void {
      safeSetItem(key, String(value))
    },
  }
}

// Swallow localStorage I/O failures — quota exceeded, Safari private mode,
// disabled storage, cross-origin iframe. Persistence is best-effort: a save
// that fails shouldn't crash the caller or the subscribe chain that triggered
// it. Errors still get surfaced in the console for diagnosis.
function safeGetItem(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch (err) {
    console.warn(`[persistence] getItem failed for ${key}:`, err)
    return null
  }
}

function safeSetItem(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch (err) {
    console.warn(`[persistence] setItem failed for ${key}:`, err)
  }
}

// String id from a fixed roster (theme / instrument / particle style). Ids are
// order-independent, so reordering a roster can't change a saved preference.
// `legacy` migrates an old integer-index key once: when the new key is absent
// and the index is valid, the id is returned and written under the new key.
export function idPersisted<T extends string>(
  key: string,
  fallback: T,
  validIds: readonly T[],
  legacy?: { key: string; ids: readonly T[] },
): Persisted<T> {
  const parse = (raw: string): T | null =>
    (validIds as readonly string[]).includes(raw) ? (raw as T) : null

  const save = (value: T): void => {
    safeSetItem(key, value)
  }

  return {
    load(): T {
      const raw = safeGetItem(key)
      // Present but unrecognised → fallback, without consulting the legacy key.
      if (raw !== null) return parse(raw) ?? fallback
      const migrated = legacy === undefined ? null : migrateLegacyIndex(legacy, parse)
      if (migrated === null) return fallback
      save(migrated)
      return migrated
    },
    save,
  }
}

function migrateLegacyIndex<T extends string>(
  legacy: { key: string; ids: readonly T[] },
  parse: (raw: string) => T | null,
): T | null {
  const raw = safeGetItem(legacy.key)
  if (raw === null) return null
  const idx = Number(raw)
  if (!Number.isInteger(idx) || idx < 0 || idx >= legacy.ids.length) return null
  const id = legacy.ids[idx]
  return id === undefined ? null : parse(id)
}

/** Finite number clamped to [min, max]. */
export function numberPersisted(
  key: string,
  fallback: number,
  min: number,
  max: number,
): Persisted<number> {
  return persisted(key, fallback, (raw) => {
    const n = Number(raw)
    return Number.isFinite(n) && n >= min && n <= max ? Math.round(n) : null
  })
}

/** Boolean stored as 'true' / 'false'. */
export function booleanPersisted(key: string, fallback: boolean): Persisted<boolean> {
  return persisted(key, fallback, (raw) => raw === 'true')
}

// Structured value serialised as JSON. Callers supply a fallback used when the
// key is missing, invalid, or a migration throws; and an optional `migrate`
// hook that runs on every successful parse so older schemas can be upgraded
// transparently. Keep migrations pure and idempotent — running them twice
// against already-migrated data must yield the same result.
export function jsonPersisted<T>(
  key: string,
  fallback: T,
  migrate: (raw: unknown) => T = (raw) => raw as T,
): Persisted<T> {
  return {
    load(): T {
      const raw = safeGetItem(key)
      if (raw === null) return fallback
      try {
        const parsed = JSON.parse(raw)
        return migrate(parsed)
      } catch {
        return fallback
      }
    },
    save(value: T): void {
      safeSetItem(key, JSON.stringify(value))
    },
  }
}
