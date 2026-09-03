import { createSignal, For } from 'solid-js'
import { render } from 'solid-js/web'
import { KEY_SIGNATURES } from '../core/music/chordColoring'
import { LOCALES, type LocaleCode, locale, t } from '../i18n'
import type { ParticleStyle, ParticleStyleInfo } from '../renderer/ParticleSystem'
import { accentCSS, type Theme } from '../renderer/theme'
import { trackEvent } from '../telemetry'
import { icons } from './icons'
import { FEEDBACK_URL, isNarrowViewport } from './utils'

// Aesthetics popover — collapses theme, particles, and chord overlay (three
// previously-separate topbar pills) into one trigger. Reduces topbar noise
// while keeping every option one tap away once opened.
//
// Pattern mirrors InstrumentMenu: a pill trigger anchored in the topbar +
// an absolutely-positioned popover anchored under it (or rendered as a
// bottom sheet on narrow viewports via shared CSS).

export interface CustomizeMenuCallbacks {
  onSelectTheme: (index: number) => void
  onSelectParticle: (index: number) => void
  onToggleChord: () => void
  onSelectLocale: (code: LocaleCode) => void
  onToggleChordColoring: () => void
  onSelectKey: (fifths: number) => void
}

interface TriggerProps {
  label: () => string
  accent: () => string
  isOpen: () => boolean
  onToggle: () => void
  registerEl: (el: HTMLButtonElement) => void
}

function TriggerView(props: TriggerProps) {
  return (
    <button
      ref={(el) => props.registerEl(el)}
      class="ts-pill ts-pill--customize"
      classList={{ 'ts-pill--open': props.isOpen() }}
      id="ts-customize"
      type="button"
      aria-label={t('customize.aria')}
      data-tip={t('customize.aria')}
      onClick={() => props.onToggle()}
    >
      <span
        class="ts-customize-icon"
        id="ts-customize-icon"
        aria-hidden="true"
        style={{ color: props.accent() }}
        innerHTML={icons.palette(16)}
      />
      <span class="ts-customize-label" id="ts-customize-label">
        {props.label()}
      </span>
      <svg
        class="ts-customize-chev"
        width="10"
        height="10"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2.2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <polyline points="6 9 12 15 18 9" />
      </svg>
    </button>
  )
}

interface MenuProps {
  themes: readonly Theme[]
  particles: readonly ParticleStyleInfo[]
  themeIndex: () => number
  particleIndex: () => number
  chordOn: () => boolean
  chordColorOn: () => boolean
  keyFifths: () => number
  isOpen: () => boolean
  isSheet: () => boolean
  onSelectTheme: (i: number) => void
  onSelectParticle: (i: number) => void
  onToggleChord: () => void
  onSelectLocale: (code: LocaleCode) => void
  onToggleChordColoring: () => void
  onSelectKey: (fifths: number) => void
  registerEl: (el: HTMLElement) => void
}

function MenuView(props: MenuProps) {
  return (
    <div
      ref={(el) => props.registerEl(el)}
      class="ts-popover ts-customize-menu"
      classList={{
        'ts-popover--open': props.isOpen(),
        'popover--sheet': props.isSheet(),
      }}
    >
      <div class="panel-header">
        <span class="panel-label">{t('customize.title')}</span>
      </div>

      <div class="ts-customize-body">
        <div class="customize-section">
          <div class="customize-section-head">
            <span class="customize-section-label">{t('customize.theme')}</span>
          </div>
          <div class="customize-theme-grid">
            <For each={props.themes}>
              {(theme, i) => (
                <button
                  class="customize-theme-tile"
                  classList={{ 'customize-theme-tile--on': props.themeIndex() === i() }}
                  type="button"
                  title={theme.name}
                  aria-label={`${theme.name} theme`}
                  onClick={() => props.onSelectTheme(i())}
                >
                  <span class="customize-theme-tile-dot" style={{ background: accentCSS(theme) }} />
                  <span class="customize-theme-tile-label">{theme.name}</span>
                </button>
              )}
            </For>
          </div>
        </div>

        <div class="customize-section">
          <div class="customize-section-head">
            <span class="customize-section-label">{t('customize.particles')}</span>
          </div>
          <div class="customize-particle-row">
            <For each={props.particles}>
              {(p, i) => (
                <button
                  class="customize-particle-chip"
                  classList={{ 'customize-particle-chip--on': props.particleIndex() === i() }}
                  type="button"
                  title={p.name}
                  aria-label={`${p.name} particles`}
                  onClick={() => props.onSelectParticle(i())}
                >
                  <span
                    class="customize-particle-chip-glyph"
                    data-style={p.id}
                    aria-hidden="true"
                    innerHTML={PARTICLE_GLYPHS[p.id] ?? PARTICLE_GLYPHS['sparks'] ?? ''}
                  />
                  <span class="customize-particle-chip-label">{p.name}</span>
                </button>
              )}
            </For>
          </div>
        </div>

        <div class="customize-section">
          <div class="customize-section-head">
            <span class="customize-section-label">{t('customize.language')}</span>
          </div>
          <div class="customize-locale-row">
            <For each={LOCALES}>
              {(l) => (
                <button
                  class="customize-locale-chip"
                  classList={{ 'customize-locale-chip--on': l.code === locale.value }}
                  type="button"
                  data-locale={l.code}
                  aria-label={l.nativeName}
                  onClick={() => props.onSelectLocale(l.code)}
                >
                  <span class="customize-locale-chip-label">{l.nativeName}</span>
                </button>
              )}
            </For>
          </div>
        </div>

        <div class="customize-section customize-section--toggle">
          <button
            class="customize-toggle"
            classList={{ 'customize-toggle--on': props.chordOn() }}
            type="button"
            aria-pressed={props.chordOn() ? 'true' : 'false'}
            onClick={() => props.onToggleChord()}
          >
            <span class="customize-toggle-body">
              <span class="customize-toggle-name">{t('customize.chord')}</span>
              <span class="customize-toggle-sub">{t('customize.chord.sub')}</span>
            </span>
            <span class="customize-toggle-switch" aria-hidden="true">
              <span class="customize-toggle-knob"></span>
            </span>
          </button>
        </div>

        <div class="customize-section customize-section--toggle">
          <button
            class="customize-toggle"
            classList={{ 'customize-toggle--on': props.chordColorOn() }}
            type="button"
            aria-pressed={props.chordColorOn() ? 'true' : 'false'}
            onClick={() => props.onToggleChordColoring()}
          >
            <span class="customize-toggle-body">
              <span class="customize-toggle-name">Chord colors</span>
              <span class="customize-toggle-sub">Color notes by chord degree</span>
            </span>
            <span class="customize-toggle-switch" aria-hidden="true">
              <span class="customize-toggle-knob"></span>
            </span>
          </button>
        </div>

        <div
          class="customize-section customize-section--key"
          classList={{ 'customize-section--disabled': !props.chordColorOn() }}
        >
          <div class="customize-section-head">
            <span class="customize-section-label">Key signature</span>
          </div>
          <select
            class="customize-key-select"
            aria-label="Key signature"
            disabled={!props.chordColorOn()}
            value={String(props.keyFifths())}
            onChange={(e) => props.onSelectKey(Number(e.currentTarget.value))}
          >
            <For each={KEY_SIGNATURES}>
              {(k) => <option value={String(k.fifths)}>{k.label}</option>}
            </For>
          </select>
        </div>

        <div class="customize-section customize-section--footer">
          <a
            class="customize-feedback-card"
            href={FEEDBACK_URL}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => trackEvent('feedback_clicked', { source: 'customize_menu' })}
          >
            <span class="customize-feedback-icon" aria-hidden="true">
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.9"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 9.6 9.6 0 0 1-4-.9L3 21l1.9-5.5a8.38 8.38 0 0 1-.9-4A8.5 8.5 0 0 1 12.5 3 8.38 8.38 0 0 1 21 11.5z" />
              </svg>
            </span>
            <span class="customize-feedback-label">{t('feedback.menu')}</span>
            <svg
              class="customize-feedback-arrow"
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M7 17L17 7" />
              <path d="M8 7h9v9" />
            </svg>
          </a>
        </div>
      </div>
    </div>
  )
}

export class CustomizeMenu {
  readonly trigger: HTMLButtonElement
  private menu!: HTMLElement
  private isOpen = false
  private disposeTrigger: (() => void) | null = null
  private disposeMenu: (() => void) | null = null
  private menuWrapper: HTMLDivElement | null = null

  private readonly setThemeIdx: (v: number) => void
  private readonly themeIdxFn: () => number
  private readonly setParticleIdx: (v: number) => void
  private readonly particleIdxFn: () => number
  private readonly setChordOn: (v: boolean) => void
  private readonly chordOnFn: () => boolean
  private readonly setChordColorOn: (v: boolean) => void
  private readonly chordColorOnFn: () => boolean
  private readonly setKeyFifths: (v: number) => void
  private readonly keyFifthsFn: () => number
  private readonly setIsOpen: (v: boolean) => void
  private readonly setIsSheet: (v: boolean) => void
  private readonly setLabel: (v: string) => void
  private readonly setAccent: (v: string) => void

  private onDocPointer = (e: PointerEvent): void => {
    const target = e.target as Node
    if (this.menu.contains(target)) return
    if (this.trigger.contains(target)) return
    this.close()
  }
  private onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && this.isOpen) this.close()
  }
  private onResize = (): void => {
    if (!this.isOpen) return
    if (this.menu.classList.contains('popover--sheet') || isNarrowViewport()) {
      this.close()
      return
    }
    this.positionUnder()
  }

  constructor(
    triggerHost: HTMLElement,
    popoverHost: HTMLElement,
    private themes: readonly Theme[],
    particles: readonly ParticleStyleInfo[],
    callbacks: CustomizeMenuCallbacks,
  ) {
    const [themeIdx, setThemeIdx] = createSignal(0)
    const [particleIdx, setParticleIdx] = createSignal(0)
    const [chordOn, setChordOn] = createSignal(false)
    const [chordColorOn, setChordColorOn] = createSignal(false)
    const [keyFifths, setKeyFifths] = createSignal(0)
    const [isOpen, setIsOpen] = createSignal(false)
    const [isSheet, setIsSheet] = createSignal(false)
    const [label, setLabel] = createSignal(t('customize.theme'))
    const [accent, setAccent] = createSignal('var(--accent)')

    this.themeIdxFn = themeIdx
    this.setThemeIdx = setThemeIdx
    this.particleIdxFn = particleIdx
    this.setParticleIdx = setParticleIdx
    this.chordOnFn = chordOn
    this.setChordOn = setChordOn
    this.chordColorOnFn = chordColorOn
    this.setChordColorOn = setChordColorOn
    this.keyFifthsFn = keyFifths
    this.setKeyFifths = setKeyFifths
    this.setIsOpen = setIsOpen
    this.setIsSheet = setIsSheet
    this.setLabel = setLabel
    this.setAccent = setAccent

    // Trigger: render into its own wrapper so the host gets exactly our pill
    // and nothing else. We capture the button ref so existing callers can
    // continue treating `.trigger` as a real DOM node.
    const triggerWrapper = document.createElement('div')
    triggerWrapper.style.display = 'contents'
    triggerHost.appendChild(triggerWrapper)
    let triggerEl!: HTMLButtonElement
    this.disposeTrigger = render(
      () => (
        <TriggerView
          label={label}
          accent={accent}
          isOpen={isOpen}
          onToggle={() => this.toggle()}
          registerEl={(el) => {
            triggerEl = el
          }}
        />
      ),
      triggerWrapper,
    )
    this.trigger = triggerEl

    const menuWrapper = document.createElement('div')
    popoverHost.appendChild(menuWrapper)
    this.menuWrapper = menuWrapper
    this.disposeMenu = render(
      () => (
        <MenuView
          themes={themes}
          particles={particles}
          themeIndex={themeIdx}
          particleIndex={particleIdx}
          chordOn={chordOn}
          chordColorOn={chordColorOn}
          keyFifths={keyFifths}
          isOpen={isOpen}
          isSheet={isSheet}
          onSelectTheme={(i) => callbacks.onSelectTheme(i)}
          onSelectParticle={(i) => callbacks.onSelectParticle(i)}
          onToggleChord={() => callbacks.onToggleChord()}
          onSelectLocale={(code) => callbacks.onSelectLocale(code)}
          onToggleChordColoring={() => callbacks.onToggleChordColoring()}
          onSelectKey={(fifths) => callbacks.onSelectKey(fifths)}
          registerEl={(el) => {
            this.menu = el
          }}
        />
      ),
      menuWrapper,
    )
  }

  // ── Public state setters (App pushes the active selection in) ──────────
  setTheme(index: number): void {
    this.setThemeIdx(index)
    const theme = this.themes[index]
    if (!theme) return
    // Tint the palette glyph with the active theme accent — keeps the live
    // "current theme" signal the old colour swatch carried.
    this.setAccent(accentCSS(theme))
    this.setLabel(theme.name)
  }

  setParticle(index: number): void {
    this.setParticleIdx(index)
  }

  setChord(on: boolean): void {
    this.setChordOn(on)
  }

  setChordColoring(on: boolean): void {
    this.setChordColorOn(on)
  }

  setKeySignature(fifths: number): void {
    this.setKeyFifths(fifths)
  }

  // ── Open / close ──────────────────────────────────────────────────────
  private toggle(): void {
    this.isOpen ? this.close() : this.open()
  }

  private open(): void {
    if (this.isOpen) return
    this.isOpen = true
    this.setIsOpen(true)
    if (isNarrowViewport()) {
      this.setIsSheet(true)
      this.menu.style.top = ''
      this.menu.style.right = ''
      this.menu.style.left = ''
    } else {
      this.setIsSheet(false)
      this.positionUnder()
    }
    setTimeout(() => {
      document.addEventListener('pointerdown', this.onDocPointer)
      document.addEventListener('keydown', this.onKey)
      window.addEventListener('resize', this.onResize)
    }, 0)
  }

  private close(): void {
    if (!this.isOpen) return
    this.isOpen = false
    this.setIsOpen(false)
    this.setIsSheet(false)
    document.removeEventListener('pointerdown', this.onDocPointer)
    document.removeEventListener('keydown', this.onKey)
    window.removeEventListener('resize', this.onResize)
  }

  private positionUnder(): void {
    const rect = this.trigger.getBoundingClientRect()
    const menuW = this.menu.offsetWidth || 280
    const right = Math.max(12, window.innerWidth - rect.right)
    const top = rect.bottom + 8
    this.menu.style.right = `${right}px`
    this.menu.style.top = `${top}px`
    this.menu.style.left = ''
    const desiredLeft = window.innerWidth - right - menuW
    if (desiredLeft < 12)
      this.menu.style.right = `${Math.max(12, window.innerWidth - menuW - 12)}px`
  }

  getCurrentTheme(): number {
    return this.themeIdxFn()
  }
  getCurrentParticle(): number {
    return this.particleIdxFn()
  }
  isChordOn(): boolean {
    return this.chordOnFn()
  }
  isChordColoringOn(): boolean {
    return this.chordColorOnFn()
  }
  currentKeyFifths(): number {
    return this.keyFifthsFn()
  }

  dispose(): void {
    this.close()
    this.disposeTrigger?.()
    this.disposeMenu?.()
    this.disposeTrigger = null
    this.disposeMenu = null
    this.menuWrapper?.remove()
    this.menuWrapper = null
  }
}

// Kept for call sites that still import the ParticleStyle type by name.
export type { ParticleStyle }

// Lightweight inline SVGs that hint at each particle style's behaviour.
// All use currentColor so they pick up theme accent on hover / when active.
const PARTICLE_GLYPHS: Record<string, string> = {
  sparks: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
    <path d="M12 3v4"/><path d="M12 17v4"/><path d="M3 12h4"/><path d="M17 12h4"/>
    <path d="M5.6 5.6l2.8 2.8"/><path d="M15.6 15.6l2.8 2.8"/>
    <path d="M5.6 18.4l2.8-2.8"/><path d="M15.6 8.4l2.8-2.8"/>
  </svg>`,
  embers: `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <circle cx="8" cy="17" r="1.6"/>
    <circle cx="13" cy="13" r="2" opacity="0.85"/>
    <circle cx="17" cy="8" r="1.3" opacity="0.7"/>
    <circle cx="10" cy="9" r="1" opacity="0.55"/>
    <circle cx="6" cy="11" r="0.8" opacity="0.45"/>
  </svg>`,
  bloom: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
    <circle cx="12" cy="12" r="3" fill="currentColor"/>
    <circle cx="12" cy="12" r="6" opacity="0.6"/>
    <circle cx="12" cy="12" r="9.5" opacity="0.3"/>
  </svg>`,
  sparkle: `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M12 4l1 4 4 1-4 1-1 4-1-4-4-1 4-1 1-4z"/>
    <path d="M19 14l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7.7-2z" opacity="0.7"/>
  </svg>`,
  none: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
    <circle cx="12" cy="12" r="8" opacity="0.5"/>
    <line x1="6" y1="18" x2="18" y2="6" opacity="0.7"/>
  </svg>`,
}
