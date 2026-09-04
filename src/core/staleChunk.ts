// Stale-deploy recovery for lazy chunks.
//
// Vercel serves only the newest deployment's hashed assets, so a tab that
// loaded an older index.html can no longer fetch its lazy chunks once a new
// build goes live: `import('./ui/ExportModal')` → "Failed to fetch dynamically
// imported module". The user's click silently does nothing and retrying hits
// the same dead URL. The only real fix is to load the new index.html, so we
// reload once — guarded so a genuine outage can't loop.

const KEY = 'midee.staleChunkReload'
const RELOAD_COOLDOWN_MS = 60_000

const CHUNK_ERROR =
  /dynamically imported module|Importing a module script failed|error loading dynamically imported module/i

export function isChunkLoadError(err: unknown): boolean {
  return err instanceof Error && CHUNK_ERROR.test(err.message)
}

/** Reloads the page if `err` looks like a stale-chunk failure and we haven't
 *  already reloaded for that reason in the last minute. Returns whether a
 *  reload was triggered, so callers can skip their own error handling. */
export function reloadForStaleChunk(err: unknown): boolean {
  if (!isChunkLoadError(err)) return false
  try {
    const last = Number(sessionStorage.getItem(KEY)) || 0
    if (Date.now() - last < RELOAD_COOLDOWN_MS) return false
    sessionStorage.setItem(KEY, String(Date.now()))
  } catch {
    // No sessionStorage → no loop guard → don't risk a reload loop.
    return false
  }
  location.reload()
  return true
}

/** True during the boot that follows a stale-chunk reload, so the app can
 *  tell the user why the page just refreshed. */
export function justReloadedForStaleChunk(): boolean {
  try {
    const last = Number(sessionStorage.getItem(KEY)) || 0
    return Date.now() - last < 10_000
  } catch {
    return false
  }
}
