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
      const raw = localStorage.getItem(key)
      if (raw === null) return fallback
      const parsed = parse(raw)
      return parsed === null ? fallback : parsed
    },
    save(value: T): void {
      localStorage.setItem(key, String(value))
    },
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
