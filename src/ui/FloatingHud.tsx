// Shared draggable glass-pill wrapper used by every HUD in the app.
//
// Responsibilities:
//   - Glass pill visual (backdrop-filter, border, shadow) — shared CSS class `float-hud`
//   - Drag handle + pin button (always leftmost)
//   - Drag / viewport-clamp logic (pointer events, CSS var --hud-dx/dy)
//   - Idle-fade (opacity → 0.28 after idleMs of no pointer activity)
//   - localStorage persistence for pin and position (storageKey.pin / storageKey.offset)
//
// Escape hatches for the imperative Controls class:
//   wakeRef     — gives caller a handle to reset the idle timer (e.g. from mousemove or play state)
//   togglePinRef — gives caller a handle to toggle pin (e.g. from keyboard shortcut Shift+P)
//
// All children are composed freely inside the pill; layout (flex/grid) is up
// to the child content or caller-supplied CSS class.

import { createEffect, createSignal, type JSX, onCleanup, onMount } from 'solid-js'
import { t } from '../i18n'
import { icons } from './icons'

export interface FloatingHudProps {
  storageKey: string
  // Which edge the HUD hangs off before the user drags it. Saved positions are
  // deltas FROM this anchor, so it must be a real anchor rather than a big
  // default offset — otherwise the HUD would sit correctly on one viewport and
  // drift on every other. Defaults to 'bottom' (just above the keyboard).
  anchor?: 'top' | 'bottom'
  idleMs?: number
  // Extra CSS classes on the root element (layout overrides, mode modifiers, etc.)
  class?: string
  // Dynamic class list merged onto the root (for reactive mode flags)
  classList?: () => Record<string, boolean>
  // Optional id on the root element (e.g. 'hud' for CSS ID-selector targeting)
  id?: string
  // Id on the drag button (for Coachmark anchoring, e.g. 'hud-drag')
  dragBtnId?: string
  // When false, idle scheduling is skipped entirely (e.g. main HUD only idles while playing)
  idleEnabled?: () => boolean
  // When true, idle scheduling is suppressed (e.g. recording / looping active)
  locked?: () => boolean
  // Called whenever pin state changes
  onPinChange?: (pinned: boolean) => void
  // When provided, a close (✕) button is rendered at the right edge of the
  // pill that collapses the HUD (caller sets collapsed()).
  onClose?: () => void
  // Collapsed = the pill shrinks to a single small icon that stays draggable.
  // A click on it (pointer-up without a drag) calls onReopen; a drag moves it,
  // sharing the same offset as the expanded pill.
  collapsed?: () => boolean
  onReopen?: () => void
  // Optional content for the collapsed pill (e.g. a learn score chip). When
  // omitted, the collapsed state shows a generic reopen icon.
  collapsedContent?: JSX.Element
  // Called the first time the user drags the HUD (for Coachmark dismissal)
  onHasDragged?: () => void
  // Gives caller a function to reset the idle timer externally
  wakeRef?: (wake: () => void) => void
  // Gives caller a function to toggle pin externally (e.g. keyboard shortcut)
  togglePinRef?: (toggle: () => void) => void
  // Called whenever idle state changes (true = just went idle, false = woke up)
  onIdleChange?: (idle: boolean) => void
  children: JSX.Element
}

// ── localStorage helpers ─────────────────────────────────────────────────────

function loadPin(key: string): boolean {
  try {
    return JSON.parse(localStorage.getItem(`${key}.pin`) ?? 'false') === true
  } catch {
    return false
  }
}

function savePin(key: string, v: boolean): void {
  try {
    localStorage.setItem(`${key}.pin`, JSON.stringify(v))
  } catch {
    // private-mode best effort
  }
}

function loadOffset(key: string): { x: number; y: number } {
  try {
    const raw = localStorage.getItem(`${key}.offset`)
    if (!raw) return { x: 0, y: 0 }
    const p = JSON.parse(raw) as { x?: number; y?: number }
    return {
      x: typeof p.x === 'number' ? p.x : 0,
      y: typeof p.y === 'number' ? p.y : 0,
    }
  } catch {
    return { x: 0, y: 0 }
  }
}

function saveOffset(key: string, v: { x: number; y: number }): void {
  try {
    localStorage.setItem(`${key}.offset`, JSON.stringify(v))
  } catch {
    // private-mode best effort
  }
}

// ── Component ────────────────────────────────────────────────────────────────

const DEFAULT_IDLE_MS = 2600

export function FloatingHud(props: FloatingHudProps) {
  const init = loadOffset(props.storageKey)
  const [offsetX, setOffsetX] = createSignal(init.x)
  const [offsetY, setOffsetY] = createSignal(init.y)
  const [pinned, setPinned] = createSignal(loadPin(props.storageKey))
  const [dragging, setDragging] = createSignal(false)
  const [idle, setIdle] = createSignal(false)

  let rootEl!: HTMLDivElement
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  let dragStartX = 0
  let dragStartY = 0
  let dragOriginX = 0
  let dragOriginY = 0
  // Distinguishes a click (reopen) from a drag (move) on the collapsed icon.
  let pointerMoved = false
  const MOVE_THRESHOLD = 4
  // While the pointer is over the pill we never idle — so the HUD *and* the
  // ── Idle-fade ───────────────────────────────────────────────────────────

  function clearTimer(): void {
    if (idleTimer !== null) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
  }

  // Idle is purely movement-based: any pointer move (anywhere — see the
  // document listener in Controls) wakes the HUD; after idleMs of stillness it
  // fades. Both the HUD and the idle()-driven top-strip dim flip together, and
  // collapsed/expanded are governed identically (no `:hover` special-casing).
  function scheduleIdle(): void {
    clearTimer()
    if (dragging() || pinned() || props.locked?.() || props.idleEnabled?.() === false) return
    idleTimer = setTimeout(() => {
      setIdle(true)
      props.onIdleChange?.(true)
    }, props.idleMs ?? DEFAULT_IDLE_MS)
  }

  function wake(): void {
    if (idle()) props.onIdleChange?.(false)
    setIdle(false)
    scheduleIdle()
  }

  // ── Drag ────────────────────────────────────────────────────────────────

  function applyOffset(): void {
    if (!rootEl) return
    rootEl.style.setProperty('--hud-dx', `${offsetX()}px`)
    rootEl.style.setProperty('--hud-dy', `${offsetY()}px`)
  }

  // Cached CSS layout vars — updated once on mount and on resize.
  // Keep in step with .float-hud--top in main.css.
  const TOP_ANCHOR_Y = 84

  let cachedKbdH = 120
  let cachedHudGap = 14

  function readLayoutVars(): void {
    const rs = getComputedStyle(document.documentElement)
    cachedKbdH = parseFloat(rs.getPropertyValue('--keyboard-h')) || 120
    cachedHudGap = parseFloat(rs.getPropertyValue('--hud-gap')) || 14
  }

  function clampOffset(): void {
    if (!rootEl) return
    const rect = rootEl.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) {
      applyOffset()
      return
    }
    const kh = cachedKbdH
    const gap = cachedHudGap
    const defaultLeft = (window.innerWidth - rect.width) / 2
    // Mirrors the CSS anchor below; TOP_ANCHOR_Y clears the top strip, which is
    // also why the clamp floor below is 80.
    const defaultTop =
      props.anchor === 'top' ? TOP_ANCHOR_Y : window.innerHeight - kh - gap - rect.height
    const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
    const nextLeft = clamp(
      defaultLeft + offsetX(),
      12,
      Math.max(12, window.innerWidth - rect.width - 12),
    )
    const nextTop = clamp(
      defaultTop + offsetY(),
      80,
      Math.max(80, window.innerHeight - kh - rect.height - 12),
    )
    setOffsetX(nextLeft - defaultLeft)
    setOffsetY(nextTop - defaultTop)
  }

  function onPointerMove(e: PointerEvent): void {
    if (!dragging()) return
    if (Math.abs(e.clientX - dragStartX) + Math.abs(e.clientY - dragStartY) > MOVE_THRESHOLD) {
      pointerMoved = true
    }
    setOffsetX(dragOriginX + (e.clientX - dragStartX))
    setOffsetY(dragOriginY + (e.clientY - dragStartY))
    clampOffset()
  }

  function onPointerUp(): void {
    if (!dragging()) return
    setDragging(false)
    document.removeEventListener('pointermove', onPointerMove)
    document.removeEventListener('pointerup', onPointerUp)
    if (pointerMoved) {
      saveOffset(props.storageKey, { x: offsetX(), y: offsetY() })
      props.onHasDragged?.()
    } else if (props.collapsed?.()) {
      // A tap on the collapsed icon (no drag) reopens the HUD.
      props.onReopen?.()
    }
  }

  function startDrag(e: PointerEvent): void {
    e.preventDefault()
    pointerMoved = false
    dragStartX = e.clientX
    dragStartY = e.clientY
    dragOriginX = offsetX()
    dragOriginY = offsetY()
    setDragging(true)
    document.addEventListener('pointermove', onPointerMove)
    document.addEventListener('pointerup', onPointerUp)
  }

  // ── Pin ──────────────────────────────────────────────────────────────────

  function togglePin(): void {
    const next = !pinned()
    setPinned(next)
    wake()
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  function onResize(): void {
    readLayoutVars()
    clampOffset()
  }

  onMount(() => {
    readLayoutVars()
    applyOffset()
    wake()
    window.addEventListener('resize', onResize)
    props.wakeRef?.(wake)
    props.togglePinRef?.(togglePin)
  })

  onCleanup(() => {
    clearTimer()
    window.removeEventListener('resize', onResize)
    document.removeEventListener('pointermove', onPointerMove)
    document.removeEventListener('pointerup', onPointerUp)
  })

  createEffect(() => {
    offsetX()
    offsetY()
    applyOffset()
  })

  // Collapsing/expanding changes the pill's size — re-clamp on the next frame
  // (after layout) so a small icon dragged to an edge doesn't leave the
  // re-expanded pill hanging off-screen. Also wake on collapse so the icon is
  // shown at full opacity (callers lock idle while collapsed).
  createEffect(() => {
    if (props.collapsed?.()) wake()
    requestAnimationFrame(() => clampOffset())
  })

  // Persist pin and notify caller whenever it changes.
  createEffect(() => {
    const p = pinned()
    savePin(props.storageKey, p)
    props.onPinChange?.(p)
    if (!p) scheduleIdle()
  })

  // ── Render ───────────────────────────────────────────────────────────────

  const rootClass = () => {
    const base = 'float-hud'
    const extra = props.class ? ` ${props.class}` : ''
    return base + extra
  }

  const rootClassList = () => ({
    'float-hud--top': props.anchor === 'top',
    'float-hud--dragging': dragging(),
    'float-hud--pinned': pinned(),
    'float-hud--idle': idle() && !pinned() && !dragging(),
    'float-hud--collapsed': props.collapsed?.() ?? false,
    ...(props.classList?.() ?? {}),
  })

  return (
    <div
      id={props.id}
      ref={rootEl!}
      class={rootClass()}
      classList={rootClassList()}
      onPointerEnter={wake}
      onPointerMove={wake}
    >
      {/* Drag handle + pin — always leftmost */}
      <div class="float-hud__handle">
        <button
          class="hud-drag-handle float-hud__drag"
          id={props.dragBtnId}
          type="button"
          aria-label={t('hud.aria.drag')}
          data-tip={t('hud.drag')}
          onPointerDown={(e) => startDrag(e)}
          innerHTML={icons.grip(10)}
        />
        <button
          class="hud-pin-btn float-hud__pin"
          classList={{ 'hud-pin-btn--on': pinned() }}
          type="button"
          aria-label={t('hud.aria.pin')}
          aria-pressed={pinned()}
          data-tip={t('hud.pin')}
          onClick={togglePin}
          innerHTML={icons.pin(12)}
        />
      </div>

      {props.children}

      {props.onClose && (
        <button
          class="hud-close-btn float-hud__close"
          type="button"
          aria-label={t('hud.close')}
          data-tip={t('hud.close')}
          onClick={() => props.onClose?.()}
          innerHTML={icons.smallClose(10)}
        />
      )}

      {/* Collapsed icon — only visible (via CSS) when float-hud--collapsed.
          pointerdown drives the shared drag system; a tap reopens (onPointerUp). */}
      {props.onReopen && (
        <button
          class="float-hud__reopen"
          type="button"
          aria-label={t('hud.reopen')}
          data-tip={t('hud.reopen')}
          onPointerDown={(e) => startDrag(e)}
        >
          {props.collapsedContent ?? (
            <span class="float-hud__reopen-icon" innerHTML={icons.sliders(16)} />
          )}
        </button>
      )}
    </div>
  )
}
