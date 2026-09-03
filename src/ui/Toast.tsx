import { createSignal, For } from 'solid-js'
import { Portal, render } from 'solid-js/web'

// Simple one-shot toast queue. Each entry auto-removes after its duration;
// multiple toasts stack in DOM order (latest below, matching the old
// app.showToast() behaviour where each toast was appended to body.body).
//
// We render via Portal so the toast DOM lives under <body> regardless of
// where the mount is wired up, preserving the fixed-position CSS layout.

export interface ToastAction {
  label: string
  onClick: () => void
}

interface ToastEntry {
  id: number
  message: string
  className: string
  action?: ToastAction
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
        <For each={toasts()}>
          {(toast) => (
            <div class={toast.className} classList={{ 'toast--actionable': !!toast.action }}>
              <span>{toast.message}</span>
              {toast.action && (
                <button
                  type="button"
                  class="toast-action"
                  onClick={() => {
                    toast.action?.onClick()
                    dismiss(toast.id)
                  }}
                >
                  {toast.action.label}
                </button>
              )}
            </div>
          )}
        </For>
      </Portal>
    ),
    document.createElement('div'),
  )
}

function dismiss(id: number): void {
  setToasts((prev) => prev.filter((t) => t.id !== id))
}

// `action` renders a button inside the toast (e.g. "Open" for a file the
// browser saved silently); such toasts accept pointer events.
export function showToast(
  message: string,
  className: string,
  duration: number,
  action?: ToastAction,
): void {
  ensureMounted()
  const id = nextId++
  setToasts((prev) => [...prev, { id, message, className, ...(action ? { action } : {}) }])
  setTimeout(() => dismiss(id), duration)
}

export function showError(message: string): void {
  showToast(message, 'toast', 4000)
}

export function showSuccess(message: string): void {
  showToast(message, 'toast toast--success', 3500)
}
