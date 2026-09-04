import { reloadForStaleChunk } from './staleChunk'

export interface LazyHandle<T> {
  /** Returns the cached value, or triggers the loader on first call. Memoised and
   *  race-safe: concurrent calls attach to the same Promise. A rejection clears
   *  the in-flight promise so the next `get()` retries. */
  get(): Promise<T>
  /** Synchronous access to the cached value. Returns `null` if not yet loaded. */
  peek(): T | null
}

/** Wraps a lazy initialisation pattern (dynamic import → construct → cache)
 *  behind a race-safe `.get()` / `.peek()` interface. The `loader` function
 *  is called at most once for a *successful* load; a rejection clears the
 *  cached promise so the next `get()` retries. Concurrent callers while a
 *  load is in-flight all attach to the same Promise. */
export function lazyHandle<T>(loader: () => Promise<T>): LazyHandle<T> {
  let cached: T | null = null
  let loadPromise: Promise<T> | null = null

  return {
    get(): Promise<T> {
      if (cached) return Promise.resolve(cached)
      if (!loadPromise) {
        loadPromise = loader()
          .then((value) => {
            cached = value
            return value
          })
          .catch((err) => {
            // Clear so the next get() retries. Only clear if this is still
            // the current in-flight promise (concurrent get() calls all share
            // the same rejection — no hazard of partial retry).
            loadPromise = null
            // A retry can't help when the chunk no longer exists on the
            // server (tab outlived a deploy) — reload to pick up the new build.
            reloadForStaleChunk(err)
            throw err
          })
      }
      return loadPromise
    },
    peek(): T | null {
      return cached
    },
  }
}
