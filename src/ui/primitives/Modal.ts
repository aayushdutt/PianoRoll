// Shared modal primitive. Handles the bits every modal in the app duplicates:
// mount, show/hide via `.open` class, Escape-to-dismiss, backdrop click, and
// cleanup of document-level listeners via dispose().
//
// Intentionally simple: you pass the inner HTML, wire up your own buttons
// against `el.querySelector(...)`, and call `open()` / `close()`. The primitive
// does NOT try to manage your modal's internal state.
//
// Usage:
//   class MyModal {
//     private modal: Modal
//     constructor(container: HTMLElement) {
//       this.modal = new Modal(container, 'my-modal-id', `<div class="card">...</div>`, {
//         onDismiss: () => this.handleDismiss(),
//       })
//       this.modal.el.querySelector('#my-button')!.addEventListener('click', ...)
//     }
//     open() { this.modal.open() }
//     close() { this.modal.close() }
//     dispose() { this.modal.dispose() }
//   }

export interface ModalOptions {
  /** Called when the user presses Escape or clicks the backdrop. */
  onDismiss?: () => void
  /** Dismiss on Escape key. Default true. */
  dismissOnEscape?: boolean
  /** Dismiss on backdrop click (the modal root itself, not children). Default true. */
  dismissOnBackdrop?: boolean
}

export class Modal {
  readonly el: HTMLElement
  private isOpen = false
  private opts: ModalOptions

  private onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return
    if (!this.isOpen) return
    if (this.opts.dismissOnEscape === false) return
    this.opts.onDismiss?.()
  }

  constructor(container: HTMLElement, id: string, innerHTML: string, opts: ModalOptions = {}) {
    this.opts = opts
    this.el = document.createElement('div')
    this.el.id = id
    this.el.innerHTML = innerHTML
    container.appendChild(this.el)

    // Backdrop click = clicks on the modal root, not its card/children.
    this.el.addEventListener('click', (e) => {
      if (!this.isOpen) return
      if (e.target !== this.el) return
      if (this.opts.dismissOnBackdrop === false) return
      this.opts.onDismiss?.()
    })

    // Attach Escape listener at construction, gate with `isOpen` so it's inert
    // while closed. No accumulation risk — we add it once per instance.
    document.addEventListener('keydown', this.onKey)
  }

  open(): void {
    this.isOpen = true
    this.el.classList.add('open')
  }

  close(): void {
    this.isOpen = false
    this.el.classList.remove('open')
  }

  get opened(): boolean {
    return this.isOpen
  }

  dispose(): void {
    this.close()
    document.removeEventListener('keydown', this.onKey)
    this.el.remove()
  }
}
