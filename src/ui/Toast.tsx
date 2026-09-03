import { createSignal, For } from 'solid-js'
import { Portal, render } from 'solid-js/web'

// Simple one-shot toast queue. Each entry auto-removes after its duration;
// multiple toasts stack in DOM order (latest below, matching the old
// app.showToast() behaviour where each toast was appended to body.body).
//
// We render via Portal so the toast DOM lives under <body> regardless of
// where the mount is wired up, preserving the fixed-position CSS layout.

interface ToastEntry {
  id: number
  message: string
  className: string
}

let nextId = 1
const [toasts, setToasts] = createSignal<readonly ToastEntry[]>([])
let mounted = false

function ensureMounted(): void {
  if (mounted) return
  mounted = true
  render(
    () => (
      <Portal mount={document.body}>
        <For each={toasts()}>{(toast) => <div class={toast.className}>{toast.message}</div>}</For>
      </Portal>
    ),
    document.createElement('div'),
  )
}

export function showToast(message: string, className: string, duration: number): void {
  ensureMounted()
  const id = nextId++
  setToasts((prev) => [...prev, { id, message, className }])
  setTimeout(() => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, duration)
}

export function showError(message: string): void {
  showToast(message, 'toast', 4000)
}

export function showSuccess(message: string): void {
  showToast(message, 'toast toast--success', 3500)
}
