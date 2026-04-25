// Unified "open a MIDI" surface: drop a file, pick a file from disk, or load a
// sample. One modal, one component, opened by anything that wants to acquire a
// MIDI (top-strip upload button, Play-mode entry without a loaded file,
// LearnHub's upload CTA). Callers pass their own onFile/onSample so the modal
// stays neutral about where the MIDI gets routed.

import { createSignal, onCleanup, onMount } from 'solid-js'
import { Portal, render } from 'solid-js/web'
import { icons } from './icons'
import { SamplesGrid } from './SamplesGrid'

interface OpenOpts {
  onFile: (file: File) => void
  onSample: (sampleId: string) => void
  onCancel?: () => void
}

interface ViewProps {
  container: HTMLElement
  isOpen: () => boolean
  onFile: (file: File) => void
  onSample: (id: string) => void
  onClose: () => void
}

function isMidiFile(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.endsWith('.mid') || lower.endsWith('.midi')
}

function MidiPickerView(props: ViewProps) {
  let inputEl!: HTMLInputElement
  let samplesHost!: HTMLDivElement
  const [dragOver, setDragOver] = createSignal(false)

  // Always-mounted card: keeps SamplesGrid hydration as a one-time cost rather
  // than re-running on every open, and lets the CSS open/close transition
  // animate (a `<Show>` would just mount/unmount with no animation).
  let samples: SamplesGrid | null = null
  onMount(() => {
    samples = new SamplesGrid()
    samples.onSelect = (id) => props.onSample(id)
    samplesHost.appendChild(samples.root)
  })
  onCleanup(() => {
    samples?.dispose()
    samples = null
  })

  // Drop region listeners. stopPropagation keeps the document-level DropZone
  // listener from firing a second `onDrop` for the same file when the modal
  // catches the drop on its own card.
  const onDrop = (e: DragEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
    const file = e.dataTransfer?.files[0]
    if (file && isMidiFile(file.name)) props.onFile(file)
  }
  const onDragEnter = (e: DragEvent): void => {
    if (!Array.from(e.dataTransfer?.types ?? []).includes('Files')) return
    setDragOver(true)
  }
  const onDragLeave = (e: DragEvent): void => {
    if (e.currentTarget === e.target) setDragOver(false)
  }
  const onDragOver = (e: DragEvent): void => {
    e.preventDefault()
  }

  return (
    <Portal mount={props.container}>
      {/* biome-ignore-start lint/a11y/useKeyWithClickEvents: backdrop click — Escape handled at document level */}
      {/* biome-ignore-start lint/a11y/noStaticElementInteractions: backdrop dismiss */}
      <div
        id="midi-picker-modal"
        classList={{ open: props.isOpen() }}
        onClick={(e) => {
          if (e.target === e.currentTarget && props.isOpen()) props.onClose()
        }}
      >
        {/* biome-ignore-end lint/a11y/useKeyWithClickEvents: — */}
        {/* biome-ignore-end lint/a11y/noStaticElementInteractions: — */}
        <div
          class="midi-picker-card"
          role="dialog"
          aria-label="Open a MIDI"
          aria-hidden={!props.isOpen()}
        >
          <header class="midi-picker-head">
            <div>
              <h2 class="midi-picker-title">Open a MIDI</h2>
              <p class="midi-picker-sub">
                Drop a file, choose one from disk, or jump in with a sample.
              </p>
            </div>
            <button
              type="button"
              class="midi-picker-close"
              aria-label="Close"
              onClick={() => props.onClose()}
              innerHTML={icons.close(14)}
            />
          </header>

          <button
            type="button"
            class="midi-picker-drop"
            classList={{ 'drag-over': dragOver() }}
            onClick={() => inputEl.click()}
            onDragEnter={onDragEnter}
            onDragLeave={onDragLeave}
            onDragOver={onDragOver}
            onDrop={onDrop}
          >
            <span class="midi-picker-drop-icon" innerHTML={icons.upload(20)} />
            <span class="midi-picker-drop-title">Drop a MIDI file here</span>
            <span class="midi-picker-drop-sub">or click to choose from your computer</span>
          </button>

          <section class="midi-picker-samples">
            <div class="midi-picker-section-label">Or explore a sample</div>
            <div class="midi-picker-samples-mount" ref={samplesHost} />
          </section>

          <input
            type="file"
            ref={inputEl}
            accept=".mid,.midi"
            style={{ display: 'none' }}
            onChange={() => {
              const file = inputEl.files?.[0]
              if (file && isMidiFile(file.name)) props.onFile(file)
              inputEl.value = ''
            }}
          />
        </div>
      </div>
    </Portal>
  )
}

export class MidiPickerModal {
  private disposeRoot: (() => void) | null = null
  private wrapper: HTMLDivElement | null = null
  private readonly setIsOpen: (v: boolean) => void
  private readonly readIsOpen: () => boolean
  private currentOpts: OpenOpts | null = null

  private onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return
    if (!this.readIsOpen()) return
    e.stopPropagation()
    this.cancel()
  }

  constructor(container: HTMLElement) {
    const [isOpen, setIsOpen] = createSignal(false)
    this.setIsOpen = setIsOpen
    this.readIsOpen = isOpen

    const wrapper = document.createElement('div')
    wrapper.style.display = 'contents'
    container.appendChild(wrapper)
    this.wrapper = wrapper

    this.disposeRoot = render(
      () => (
        <MidiPickerView
          container={container}
          isOpen={isOpen}
          onFile={(f) => this.handleFile(f)}
          onSample={(id) => this.handleSample(id)}
          onClose={() => this.cancel()}
        />
      ),
      wrapper,
    )
    document.addEventListener('keydown', this.onKey)
  }

  open(opts: OpenOpts): void {
    this.currentOpts = opts
    this.setIsOpen(true)
  }

  close(): void {
    this.setIsOpen(false)
    this.currentOpts = null
  }

  dispose(): void {
    document.removeEventListener('keydown', this.onKey)
    this.disposeRoot?.()
    this.disposeRoot = null
    this.wrapper?.remove()
    this.wrapper = null
  }

  private cancel(): void {
    const cb = this.currentOpts?.onCancel
    this.close()
    cb?.()
  }

  private handleFile(file: File): void {
    const opts = this.currentOpts
    if (!opts) return
    this.close()
    opts.onFile(file)
  }

  private handleSample(id: string): void {
    const opts = this.currentOpts
    if (!opts) return
    this.close()
    opts.onSample(id)
  }
}
