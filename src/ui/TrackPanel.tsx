import { createSignal, For } from 'solid-js'
import { render } from 'solid-js/web'
import type { MidiFile, MidiTrack } from '../core/midi/types'
import { t, tn } from '../i18n'
import { getTrackColor, type Theme } from '../renderer/theme'
import { icons } from './icons'
import { hexToCSS, isNarrowViewport } from './utils'

// Popover dropdown anchored under the Tracks button in the top strip.
// Each track has a mute toggle; a "Load new file" footer reopens the Open
// MIDI modal for quick swap.

interface PanelProps {
  isOpen: () => boolean
  isSheet: () => boolean
  tracks: () => readonly MidiTrack[]
  theme: () => Theme
  onTrackVisibleChange: (trackId: string, visible: boolean) => void
  onTrackEnabledChange: (trackId: string, enabled: boolean) => void
  onLoadNew: () => void
  registerPanelEl: (el: HTMLElement) => void
}

function TrackPanelView(props: PanelProps) {
  return (
    <div
      id="track-panel"
      class="ts-popover"
      classList={{
        'ts-popover--open': props.isOpen(),
        'popover--sheet': props.isSheet(),
      }}
      ref={(el) => props.registerPanelEl(el)}
    >
      <div class="panel-header">
        <span class="panel-label">{t('tracks.title')}</span>
      </div>
      <div class="panel-items">
        <For each={props.tracks()}>
          {(tr) => {
            // Resolve from the active theme so the swatch matches what
            // NoteRenderer actually paints — `tr.color` is the parser's
            // hardcoded palette and only coincidentally matches in Dark.
            const color = (): string => hexToCSS(getTrackColor(tr, props.theme()))
            return (
              <label class="track-item">
                <span class="track-swatch" style={{ background: color() }} />
                <span class="track-info">
                  <span class="track-name">{tr.name}</span>
                  <span class="track-meta">
                    {tn('tracks.notes', tr.notes.length, { channel: tr.channel + 1 })}
                  </span>
                </span>
                <span class="track-toggle-wrap" style={{ '--track-color': color() }}>
                  <input
                    type="checkbox"
                    class="track-toggle"
                    data-id={tr.id}
                    checked
                    onChange={(e) => {
                      e.stopPropagation()
                      const enabled = e.currentTarget.checked
                      props.onTrackVisibleChange(tr.id, enabled)
                      props.onTrackEnabledChange(tr.id, enabled)
                    }}
                  />
                  <span class="toggle-track" />
                </span>
              </label>
            )
          }}
        </For>
      </div>
      <div class="panel-footer">
        <button class="panel-load-btn" type="button" onClick={() => props.onLoadNew()}>
          <span innerHTML={icons.upload(11)} />
          {t('tracks.loadNew')}
        </button>
      </div>
    </div>
  )
}

export class TrackPanel {
  private disposeRoot: (() => void) | null = null
  private wrapper: HTMLDivElement | null = null
  private panelEl: HTMLElement | null = null
  private trigger: HTMLElement | null = null

  private readonly setIsOpen: (v: boolean) => void
  private readonly isOpenFn: () => boolean
  private readonly setIsSheet: (v: boolean) => void
  private readonly setTracks: (v: readonly MidiTrack[]) => void
  private readonly setThemeSig: (v: Theme) => void

  private onDocPointer = (e: PointerEvent): void => {
    const target = e.target as Node
    if (this.panelEl?.contains(target)) return
    if (this.trigger?.contains(target)) return
    this.close()
  }
  private onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && this.isOpenFn()) this.close()
  }
  private onResize = (): void => {
    if (!this.isOpenFn()) return
    // Sheet mode is CSS-driven; if the breakpoint flipped while open, close
    // rather than present a half-styled popover.
    if (this.panelEl?.classList.contains('popover--sheet') || isNarrowViewport()) {
      this.close()
      return
    }
    this.positionUnder()
  }

  // Decoupled from any concrete renderer — the caller supplies a callback for
  // per-track visibility (piano-only today, but this keeps TrackPanel from
  // needing to know that) and the theme to seed with; `setTheme()` still
  // drives subsequent updates explicitly.
  constructor(
    container: HTMLElement,
    initialTheme: Theme,
    onTrackVisibleChange: (trackId: string, visible: boolean) => void,
    onTrackEnabledChange: (trackId: string, enabled: boolean) => void,
    onLoadNew: () => void,
  ) {
    const [isOpen, setIsOpen] = createSignal(false)
    const [isSheet, setIsSheet] = createSignal(false)
    const [tracks, setTracks] = createSignal<readonly MidiTrack[]>([])
    const [theme, setThemeSig] = createSignal<Theme>(initialTheme)
    this.isOpenFn = isOpen
    this.setIsOpen = setIsOpen
    this.setIsSheet = setIsSheet
    this.setTracks = setTracks
    this.setThemeSig = setThemeSig

    const wrapper = document.createElement('div')
    container.appendChild(wrapper)
    this.wrapper = wrapper
    this.disposeRoot = render(
      () => (
        <TrackPanelView
          isOpen={isOpen}
          isSheet={isSheet}
          tracks={tracks}
          theme={theme}
          onTrackVisibleChange={onTrackVisibleChange}
          onTrackEnabledChange={onTrackEnabledChange}
          onLoadNew={() => {
            this.close()
            onLoadNew()
          }}
          registerPanelEl={(el) => {
            this.panelEl = el
          }}
        />
      ),
      wrapper,
    )
  }

  render(midi: MidiFile): void {
    this.setTracks(midi.tracks)
  }

  setTheme(theme: Theme): void {
    this.setThemeSig(theme)
  }

  setTrigger(el: HTMLElement): void {
    this.trigger = el
  }

  toggle(): void {
    if (this.isOpenFn()) this.close()
    else this.open()
  }

  open(): void {
    if (this.isOpenFn()) return
    this.setIsOpen(true)
    if (isNarrowViewport()) {
      this.setIsSheet(true)
      if (this.panelEl) {
        this.panelEl.style.top = ''
        this.panelEl.style.right = ''
        this.panelEl.style.left = ''
      }
    } else {
      this.setIsSheet(false)
      this.positionUnder()
    }
    // Defer listener attach so the click that opened us doesn't immediately
    // bubble and close it.
    setTimeout(() => {
      document.addEventListener('pointerdown', this.onDocPointer)
      document.addEventListener('keydown', this.onKey)
      window.addEventListener('resize', this.onResize)
    }, 0)
  }

  close(): void {
    if (!this.isOpenFn()) return
    this.setIsOpen(false)
    this.setIsSheet(false)
    document.removeEventListener('pointerdown', this.onDocPointer)
    document.removeEventListener('keydown', this.onKey)
    window.removeEventListener('resize', this.onResize)
  }

  hide(): void {
    this.close()
  }

  dispose(): void {
    this.close()
    this.disposeRoot?.()
    this.disposeRoot = null
    this.wrapper?.remove()
    this.wrapper = null
  }

  private positionUnder(): void {
    const trigger = this.trigger
    const panel = this.panelEl
    if (!trigger || !panel) return
    const rect = trigger.getBoundingClientRect()
    const panelW = panel.offsetWidth || 320
    const right = Math.max(12, window.innerWidth - rect.right)
    const top = rect.bottom + 8
    panel.style.right = `${right}px`
    panel.style.top = `${top}px`
    panel.style.left = ''
    const desiredLeft = window.innerWidth - right - panelW
    if (desiredLeft < 12) panel.style.right = `${Math.max(12, window.innerWidth - panelW - 12)}px`
  }
}
