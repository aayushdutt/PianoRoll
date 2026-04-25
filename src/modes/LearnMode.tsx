import { onCleanup, onMount } from 'solid-js'
import { useApp } from '../store/AppCtx'
import type { LearnController } from './LearnController'

// Learn mode shell. LearnController is dynamic-imported on first entry —
// onMount awaits the chunk, then calls enter(). If the user navigates away
// before the chunk lands, the `cancelled` flag stops us from calling enter()
// against a controller no one's watching, and onCleanup is a no-op since
// `controller` is still null.
export function LearnMode() {
  const { ensureLearnController } = useApp()
  let controller: LearnController | null = null
  let cancelled = false
  onMount(() => {
    void ensureLearnController().then((c) => {
      if (cancelled) return
      controller = c
      controller.enter()
    })
  })
  onCleanup(() => {
    cancelled = true
    controller?.exit()
  })
  return null
}
