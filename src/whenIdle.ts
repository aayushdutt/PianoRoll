// Run `fn` during the next browser idle window. `timeoutMs` is the
// **deadline**, not a delay — rIC fires as soon as the browser is idle and
// only waits up to `timeoutMs` if it never goes idle. On a typical first
// load, callbacks run within ~150-300 ms of boot finishing.
//
// `fn` should be cheap and side-effect-light (kicking off a fetch, a small
// constructor) — heavy synchronous work blows past rIC's per-frame budget
// and pushes long tasks back onto the main thread.
//
// Fallback path: `setTimeout(fn, 1)` for environments without rIC (jsdom,
// SSR, very old browsers). Modern browsers all support rIC since 2023, so
// this path is mostly cosmetic; firing at +1 ms is closer to rIC's
// "right after boot finishes" semantics than a multi-second wait.
export function whenIdle(fn: () => void, timeoutMs = 2000): void {
  const g = globalThis as { requestIdleCallback?: typeof requestIdleCallback }
  if (typeof g.requestIdleCallback === 'function') {
    g.requestIdleCallback(fn, { timeout: timeoutMs })
  } else {
    setTimeout(fn, 1)
  }
}
