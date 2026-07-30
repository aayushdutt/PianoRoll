// Unified "open a MIDI" surface: drop a file, pick a file from disk, or load a
// sample. One modal, one component, opened by anything that wants to acquire a
// MIDI (top-strip upload button, Play-mode entry without a loaded file,
// LearnHub's upload CTA). Callers pass their own onFile/onSample so the modal
// stays neutral about where the MIDI gets routed.

import { createSignal, onCleanup, onMount } from 'solid-js'
import { Portal, render } from 'solid-js/web'
import { t } from '../i18n'
import { icons } from './icons'
import { type GridContents, SamplesGrid } from './SamplesGrid'

interface OpenOpts {
  onFile: (file: File) => void
  onSample: (sampleId: string) => void
  onRecent: (recentId: string) => void
  onCancel?: () => void
}

interface ViewProps {
  container: HTMLElement
  isOpen: () => boolean
  onFile: (file: File) => void
  onSample: (id: string) => void
  onRecent: (id: string) => void
  onClose: () => void
  registerRefreshGrid: (fn: () => void) => void
}

function sectionLabel(contents: GridContents): string {
  if (contents === 'recents') return t('midiPicker.recentsOnlyLabel')
  if (contents === 'mixed') return t('midiPicker.recentsLabel')
  return t('midiPicker.samplesLabel')
}

function isMidiFile(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.endsWith('.mid') || lower.endsWith('.midi')
}

function MidiPickerView(props: ViewProps) {
  let inputEl!: HTMLInputElement
  let samplesHost!: HTMLDivElement
  const [dragOver, setDragOver] = createSignal(false)
  const [gridContents, setGridContents] = createSignal<GridContents>('samples')

  // Always-mounted card: keeps SamplesGrid hydration as a one-time cost rather
  // than re-running on every open, and lets the CSS open/close transition
  // animate (a `<Show>` would just mount/unmount with no animation). The flip
  // side is that recents go stale between opens — hence the refresh hook.
  let samples: SamplesGrid | null = null
  onMount(() => {
    samples = new SamplesGrid({
      onSelectSample: (id) => props.onSample(id),
      onSelectRecent: (id) => props.onRecent(id),
      onContents: setGridContents,
    })
    samplesHost.appendChild(samples.root)
    props.registerRefreshGrid(() => samples?.refresh())
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
          aria-label={t('midiPicker.aria')}
          aria-hidden={!props.isOpen()}
        >
          <header class="midi-picker-head">
            <div>
              <h2 class="midi-picker-title">{t('midiPicker.title')}</h2>
              <p class="midi-picker-sub">{t('midiPicker.sub')}</p>
            </div>
            <button
              type="button"
              class="midi-picker-close"
              aria-label={t('midiPicker.close')}
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
            <span class="midi-picker-drop-title">{t('midiPicker.dropTitle')}</span>
            <span class="midi-picker-drop-sub">{t('midiPicker.dropSub')}</span>
          </button>

          <section class="midi-picker-samples">
            <div class="midi-picker-section-label">{sectionLabel(gridContents())}</div>
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
  private refreshGrid: (() => void) | null = null

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
          onRecent={(id) => this.handleRecent(id)}
          onClose={() => this.cancel()}
          registerRefreshGrid={(fn) => {
            this.refreshGrid = fn
          }}
        />
      ),
      wrapper,
    )
    document.addEventListener('keydown', this.onKey)
  }

  open(opts: OpenOpts): void {
    this.currentOpts = opts
    this.refreshGrid?.()
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

  private handleRecent(id: string): void {
    const opts = this.currentOpts
    if (!opts) return
    this.close()
    opts.onRecent(id)
  }
}
