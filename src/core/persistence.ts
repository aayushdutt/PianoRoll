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

/** Integer index in [0, maxExclusive). Returns null if the value is out of range. */
export function indexPersisted(
  key: string,
  fallback: number,
  maxExclusive: number,
): Persisted<number> {
  return persisted(key, fallback, (raw) => {
    const n = Number(raw)
    return Number.isInteger(n) && n >= 0 && n < maxExclusive ? n : null
  })
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
