import { icons } from '../../../ui/icons'
import type { PlayAlongEngine } from './engine'

function fmtTime(t: number): string {
  const s = Math.max(0, Math.floor(t))
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${m}:${r < 10 ? '0' : ''}${r}`
}

const STORAGE_KEY_PIN = 'midee.learn.pa.pinned'
const STORAGE_KEY_OFFSET = 'midee.learn.pa.offset'

// Control panel for the Play-Along exercise. Sits above the keyboard as a
// floating, moveable, pinnable card — matches the Live/Play HUD pattern so
// the user sees the same chrome vocabulary across modes.
//
// Layout (single card, two rows when wide; wraps gracefully):
//   row 1: [≡] [📌] [◀] [▶︎/⏸] [▶] [00:00] [━━━━━◉━━━━━] [02:34] [score] [×]
//   row 2: [Speed 60·80·100] | [Hands L·R·Both] | [Loop·Clear] | [Wait] [Ramp]
//
// Non-goals: feature parity with the main Play HUD. This exists purely to
// drive a single exercise. Keep it flat — the HUD is its only consumer.
export interface PlayAlongHudOptions {
  engine: PlayAlongEngine
  onCloseExercise: () => void
  onCycleLoop: () => void
  onClearLoop: () => void
}

export class PlayAlongHud {
  private root: HTMLDivElement | null = null
  private unsubs: Array<() => void> = []
  private scrubbing = false

  // Drag state. `offsetX/Y` are deltas off the default centered-above-keyboard
  // origin. Persisted to localStorage so the user's layout preference survives
  // reloads and re-entries into Learn mode.
  private offsetX = 0
  private offsetY = 0
  private dragging = false
  private dragStartX = 0
  private dragStartY = 0
  private dragOriginX = 0
  private dragOriginY = 0
  private pinned = false
  // Idle-fade timer. When unpinned and the user is playing, the HUD fades
  // after a short idle window so the roll stays uncluttered; any interaction
  // (pointer move over the HUD or a transport event) wakes it back up.
  private idleTimer: ReturnType<typeof setTimeout> | null = null

  private onWindowResize = (): void => this.clampOffset()
  private onPointerMoveDoc = (e: PointerEvent): void => this.handleDragMove(e)
  private onPointerUpDoc = (): void => this.endDrag()
  private onHoverWake = (): void => this.wake()

  constructor(private opts: PlayAlongHudOptions) {}

  mount(host: HTMLElement): void {
    if (this.root) return

    const el = document.createElement('div')
    // Don't share the `.hud-bar` class — it locks height to 56px for the
    // single-row Play/Live HUD. This HUD is two rows by design; it styles
    // its own chrome to match (same backdrop, border, shadow) without the
    // height constraint.
    el.className = 'pa-hud'
    // Icon vocabulary:
    //  · Wait: an hourglass-like pair of chevrons facing a dot — reads as "hold
    //    here until cleared", not "paused". The old pause-bars made the button
    //    look like a second play/pause control.
    //  · Ramp: a rising slope + step marker that looks like a speed-up curve.
    //  · Loop: standard cycle glyph.
    // SVGs kept inline so the HUD renders without a round-trip to icons.ts —
    // it's the only surface that needs these sizes.
    el.innerHTML = `
      <div class="pa-hud__handle">
        <button class="hud-drag-handle pa-hud__drag" type="button"
                aria-label="Drag to move" data-tip="Drag to move">
          ${icons.grip(10)}
        </button>
        <button class="hud-pin-btn pa-hud__pin" type="button"
                aria-label="Pin in place" data-tip="Pin · keep from auto-hiding">
          ${icons.pin(12)}
        </button>
      </div>

      <div class="pa-hud__transport">
        <button class="pa-hud__play" data-play type="button"
                aria-label="Play" data-tip="Play / pause (Space)">
          <svg class="pa-hud__play-icon pa-hud__play-icon--play" viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M4 3 L13 8 L4 13 Z"/></svg>
          <svg class="pa-hud__play-icon pa-hud__play-icon--pause" viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><rect x="4" y="3" width="3" height="10" rx="0.5"/><rect x="9" y="3" width="3" height="10" rx="0.5"/></svg>
        </button>
        <div class="pa-hud__scrub">
          <span class="pa-hud__time" data-time-current>0:00</span>
          <input class="pa-hud__scrubber" data-scrubber type="range"
                 min="0" max="1" step="0.01" value="0"
                 aria-label="Scrubber"
                 data-tip="Drag to seek" />
          <span class="pa-hud__time pa-hud__time--muted" data-time-total>0:00</span>
        </div>
      </div>

      <div class="pa-hud__meta">
        <div class="pa-hud__score" data-score
             data-tip="Notes hit · total attempts this session"
             aria-label="Score">
          <span class="pa-hud__score-hits" data-hits>0</span>
          <span class="pa-hud__score-sep">/</span>
          <span class="pa-hud__score-total" data-total>0</span>
        </div>
        <button class="pa-hud__icon-btn pa-hud__close" data-close type="button"
                aria-label="Back to learn hub"
                data-tip="Back to hub (Esc)">
          ${icons.close(14)}
        </button>
      </div>

      <div class="pa-hud__options">
        <div class="pa-hud__segmented" role="group" aria-label="Speed">
          <span class="pa-hud__seg-label">Speed</span>
          <div class="pa-hud__seg-track">
            <button class="pa-hud__seg" data-speed="60" type="button"
                    data-tip="Slow · 60% ([)" aria-label="60% speed">60</button>
            <button class="pa-hud__seg" data-speed="80" type="button"
                    data-tip="Medium · 80%" aria-label="80% speed">80</button>
            <button class="pa-hud__seg" data-speed="100" type="button"
                    data-tip="Full · 100% (])" aria-label="100% speed">100</button>
          </div>
        </div>

        <div class="pa-hud__segmented" role="group" aria-label="Hands">
          <span class="pa-hud__seg-label">Hands</span>
          <div class="pa-hud__seg-track">
            <button class="pa-hud__seg" data-hand="left" type="button"
                    data-tip="Left hand only" aria-label="Left hand">L</button>
            <button class="pa-hud__seg" data-hand="right" type="button"
                    data-tip="Right hand only" aria-label="Right hand">R</button>
            <button class="pa-hud__seg" data-hand="both" type="button"
                    data-tip="Both hands" aria-label="Both hands">Both</button>
          </div>
        </div>

        <div class="pa-hud__loop" data-loop-wrap>
          <button class="pa-hud__pill pa-hud__pill--loop" data-loop-cycle type="button"
                  data-tip="Cycle loop presets (L)"
                  aria-label="Cycle loop presets">
            <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8a5 5 0 0 1 8-4M13 8a5 5 0 0 1-8 4"/><path d="M11 2v3h-3M5 14v-3h3"/></svg>
            <span>Loop</span>
            <span class="pa-hud__pill-sub" data-loop-sub></span>
          </button>
          <button class="pa-hud__loop-clear" data-loop-clear type="button"
                  data-tip="Clear loop" aria-label="Clear loop">
            <svg viewBox="0 0 10 10" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M2 2l6 6M8 2l-6 6"/></svg>
          </button>
        </div>

        <button class="pa-hud__pill" data-wait type="button"
                aria-pressed="true"
                data-tip="Wait mode · pauses at each chord"
                aria-label="Toggle wait mode">
          <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 3h8M4 13h8M6 3c0 2 4 3 4 5s-4 3-4 5"/></svg>
          <span>Wait</span>
        </button>
        <button class="pa-hud__pill" data-ramp type="button"
                aria-pressed="false"
                data-tip="Auto-speed · ramps up on clean passes"
                aria-label="Toggle tempo ramp">
          <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 13 L14 3"/><path d="M9 3 L14 3 L14 8"/></svg>
          <span>Ramp</span>
        </button>
      </div>
    `
    host.appendChild(el)
    this.root = el

    this.restoreLayoutState()
    this.applyOffset()
    this.applyPinVisual()

    this.bindEvents()
    this.bindState()
    window.addEventListener('resize', this.onWindowResize)
    el.addEventListener('pointerenter', this.onHoverWake)
    el.addEventListener('pointermove', this.onHoverWake)
    this.scheduleIdleFade()
  }

  unmount(): void {
    for (const off of this.unsubs) off()
    this.unsubs = []
    window.removeEventListener('resize', this.onWindowResize)
    document.removeEventListener('pointermove', this.onPointerMoveDoc)
    document.removeEventListener('pointerup', this.onPointerUpDoc)
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
    this.root?.remove()
    this.root = null
  }

  // ── Event wiring ───────────────────────────────────────────────────────

  private bindEvents(): void {
    const el = this.root!
    const { engine } = this.opts

    el.querySelector('[data-close]')?.addEventListener('click', () => this.opts.onCloseExercise())
    el.querySelector('[data-play]')?.addEventListener('click', () => engine.togglePlay())
    for (const btn of el.querySelectorAll<HTMLButtonElement>('[data-speed]')) {
      btn.addEventListener('click', () => engine.setSpeedPreset(Number(btn.dataset['speed'])))
    }
    for (const btn of el.querySelectorAll<HTMLButtonElement>('[data-hand]')) {
      btn.addEventListener('click', () => engine.setHand(btn.dataset['hand'] as never))
    }
    el.querySelector('[data-loop-cycle]')?.addEventListener('click', () => this.opts.onCycleLoop())
    el.querySelector('[data-loop-clear]')?.addEventListener('click', () => this.opts.onClearLoop())

    const scrubber = el.querySelector<HTMLInputElement>('[data-scrubber]')
    if (scrubber) {
      scrubber.addEventListener('pointerdown', () => {
        this.scrubbing = true
      })
      scrubber.addEventListener('input', () => {
        const pct = (Number(scrubber.value) / (Number(scrubber.max) || 1)) * 100
        scrubber.style.setProperty('--pct', `${pct.toFixed(1)}%`)
        engine.seek(Number(scrubber.value))
      })
      const endScrub = (): void => {
        this.scrubbing = false
      }
      scrubber.addEventListener('pointerup', endScrub)
      scrubber.addEventListener('pointercancel', endScrub)
      scrubber.addEventListener('change', endScrub)
    }

    const waitBtn = el.querySelector<HTMLButtonElement>('[data-wait]')!
    waitBtn.addEventListener('click', () => {
      const next = waitBtn.getAttribute('aria-pressed') !== 'true'
      waitBtn.setAttribute('aria-pressed', String(next))
      engine.setWaitEnabled(next)
    })
    const rampBtn = el.querySelector<HTMLButtonElement>('[data-ramp]')!
    rampBtn.addEventListener('click', () => {
      const next = rampBtn.getAttribute('aria-pressed') !== 'true'
      rampBtn.setAttribute('aria-pressed', String(next))
      engine.setTempoRamp(next)
    })

    el.querySelector<HTMLButtonElement>('.pa-hud__drag')!.addEventListener('pointerdown', (e) =>
      this.startDrag(e),
    )
    el.querySelector<HTMLButtonElement>('.pa-hud__pin')!.addEventListener('click', () =>
      this.togglePin(),
    )
  }

  private bindState(): void {
    const { engine } = this.opts
    const el = this.root!
    this.unsubs.push(
      engine.speedPct.subscribe((pct) => {
        for (const btn of el.querySelectorAll<HTMLButtonElement>('[data-speed]')) {
          btn.classList.toggle('is-active', Number(btn.dataset['speed']) === pct)
        }
      }),
      engine.hand.subscribe((hand) => {
        for (const btn of el.querySelectorAll<HTMLButtonElement>('[data-hand]')) {
          btn.classList.toggle('is-active', btn.dataset['hand'] === hand)
        }
      }),
      engine.hits.subscribe((n) => {
        const hitsEl = el.querySelector<HTMLElement>('[data-hits]')
        if (hitsEl) hitsEl.textContent = String(n)
        this.updateTotal()
      }),
      engine.misses.subscribe(() => this.updateTotal()),
      // The button reads `userWantsToPlay` not `isPlaying` — wait-mode
      // pauses flip the latter dozens of times a piece; we don't want the
      // icon strobing between play/pause on every chord.
      engine.userWantsToPlay.subscribe((wants) => {
        const playBtn = el.querySelector<HTMLButtonElement>('[data-play]')
        if (!playBtn) return
        playBtn.classList.toggle('is-playing', wants)
        playBtn.setAttribute('aria-label', wants ? 'Pause' : 'Play')
        // Any transport state change wakes the HUD so the user sees the
        // updated icon before any idle fade kicks back in.
        this.wake()
      }),
      engine.currentTime.subscribe((t) => this.renderTime(t)),
      engine.duration.subscribe((d) => this.renderDuration(d)),
      // Loop region state drives two things: the pill's `aria-pressed` /
      // active styling and whether the inline × clear button is visible.
      // Without this, the × hangs in the HUD even when no loop is set and
      // begs the user to click it for no reason.
      engine.loopRegion.subscribe((region) => {
        const wrap = el.querySelector<HTMLElement>('[data-loop-wrap]')
        const pill = el.querySelector<HTMLButtonElement>('[data-loop-cycle]')
        const sub = el.querySelector<HTMLElement>('[data-loop-sub]')
        if (!wrap || !pill || !sub) return
        const on = region !== null
        wrap.classList.toggle('pa-hud__loop--on', on)
        pill.setAttribute('aria-pressed', String(on))
        sub.textContent = region ? `· ${(region.end - region.start).toFixed(1)}s` : ''
      }),
    )
    el.querySelector<HTMLButtonElement>('[data-speed="100"]')?.classList.add('is-active')
    el.querySelector<HTMLButtonElement>('[data-hand="both"]')?.classList.add('is-active')
    this.renderTime(engine.currentTime.value)
    this.renderDuration(engine.duration.value)
  }

  private renderTime(t: number): void {
    const el = this.root
    if (!el) return
    const timeEl = el.querySelector<HTMLElement>('[data-time-current]')
    if (timeEl) timeEl.textContent = fmtTime(t)
    const scrubber = el.querySelector<HTMLInputElement>('[data-scrubber]')
    if (scrubber && !this.scrubbing) {
      scrubber.value = String(t)
      const pct = (t / (Number(scrubber.max) || 1)) * 100
      scrubber.style.setProperty('--pct', `${Math.max(0, Math.min(100, pct)).toFixed(1)}%`)
    }
  }

  private renderDuration(d: number): void {
    const el = this.root
    if (!el) return
    const totalEl = el.querySelector<HTMLElement>('[data-time-total]')
    if (totalEl) totalEl.textContent = fmtTime(d)
    const scrubber = el.querySelector<HTMLInputElement>('[data-scrubber]')
    if (scrubber) scrubber.max = String(d || 1)
  }

  private updateTotal(): void {
    const el = this.root
    if (!el) return
    const totalEl = el.querySelector<HTMLElement>('[data-total]')
    if (!totalEl) return
    const { engine } = this.opts
    totalEl.textContent = String(engine.hits.value + engine.misses.value)
  }

  // ── Drag + pin ─────────────────────────────────────────────────────────

  private startDrag(e: PointerEvent): void {
    e.preventDefault()
    this.dragging = true
    this.dragStartX = e.clientX
    this.dragStartY = e.clientY
    this.dragOriginX = this.offsetX
    this.dragOriginY = this.offsetY
    this.root?.classList.add('pa-hud--dragging')
    document.addEventListener('pointermove', this.onPointerMoveDoc)
    document.addEventListener('pointerup', this.onPointerUpDoc)
  }

  private handleDragMove(e: PointerEvent): void {
    if (!this.dragging) return
    this.offsetX = this.dragOriginX + (e.clientX - this.dragStartX)
    this.offsetY = this.dragOriginY + (e.clientY - this.dragStartY)
    this.clampOffset()
  }

  private endDrag(): void {
    if (!this.dragging) return
    this.dragging = false
    this.root?.classList.remove('pa-hud--dragging')
    document.removeEventListener('pointermove', this.onPointerMoveDoc)
    document.removeEventListener('pointerup', this.onPointerUpDoc)
    this.persistOffset()
  }

  // Clamp inside the viewport so the user can't fling the HUD off-screen. The
  // origin is "centered, above the keyboard" — `--hud-dx/dy` are deltas off
  // that, matching the main HUD's convention.
  private clampOffset(): void {
    const el = this.root
    if (!el) return
    const rect = el.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) {
      this.applyOffset()
      return
    }
    const rootStyles = getComputedStyle(document.documentElement)
    const keyboardHeight = parseFloat(rootStyles.getPropertyValue('--keyboard-h')) || 120
    const hudGap = parseFloat(rootStyles.getPropertyValue('--hud-gap')) || 14
    const defaultLeft = (window.innerWidth - rect.width) / 2
    const defaultTop = window.innerHeight - keyboardHeight - hudGap - rect.height
    const minLeft = 12
    const maxLeft = Math.max(minLeft, window.innerWidth - rect.width - 12)
    // Don't let the HUD overlap the top-strip. 80px is a conservative floor
    // that accounts for the strip height + safe-area inset.
    const minTop = 80
    const maxTop = Math.max(minTop, window.innerHeight - keyboardHeight - rect.height - 12)
    const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))
    const nextLeft = clamp(defaultLeft + this.offsetX, minLeft, maxLeft)
    const nextTop = clamp(defaultTop + this.offsetY, minTop, maxTop)
    this.offsetX = nextLeft - defaultLeft
    this.offsetY = nextTop - defaultTop
    this.applyOffset()
  }

  private applyOffset(): void {
    const el = this.root
    if (!el) return
    el.style.setProperty('--hud-dx', `${this.offsetX}px`)
    el.style.setProperty('--hud-dy', `${this.offsetY}px`)
  }

  private togglePin(): void {
    this.pinned = !this.pinned
    this.applyPinVisual()
    try {
      localStorage.setItem(STORAGE_KEY_PIN, JSON.stringify(this.pinned))
    } catch {
      // Private mode — best effort.
    }
    // Pinning wakes the HUD and cancels any pending fade — that's the whole
    // point of the affordance.
    this.wake()
  }

  // ── Idle fade ──────────────────────────────────────────────────────────

  private wake(): void {
    this.root?.classList.remove('pa-hud--idle')
    this.scheduleIdleFade()
  }

  private scheduleIdleFade(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
    if (this.pinned) return
    this.idleTimer = setTimeout(() => {
      // Only fade while actually playing — a paused HUD should stay fully
      // visible (the user is probably reading it).
      if (!this.pinned && this.opts.engine.userWantsToPlay.value) {
        this.root?.classList.add('pa-hud--idle')
      }
    }, 2600)
  }

  private applyPinVisual(): void {
    const el = this.root
    if (!el) return
    el.classList.toggle('pa-hud--pinned', this.pinned)
    el.querySelector<HTMLButtonElement>('.pa-hud__pin')?.classList.toggle(
      'hud-pin-btn--on',
      this.pinned,
    )
  }

  private persistOffset(): void {
    try {
      localStorage.setItem(STORAGE_KEY_OFFSET, JSON.stringify({ x: this.offsetX, y: this.offsetY }))
    } catch {
      // Private mode — best effort.
    }
  }

  private restoreLayoutState(): void {
    try {
      const rawPin = localStorage.getItem(STORAGE_KEY_PIN)
      if (rawPin) this.pinned = JSON.parse(rawPin) === true
      const rawOffset = localStorage.getItem(STORAGE_KEY_OFFSET)
      if (rawOffset) {
        const parsed = JSON.parse(rawOffset) as { x?: number; y?: number }
        if (typeof parsed.x === 'number') this.offsetX = parsed.x
        if (typeof parsed.y === 'number') this.offsetY = parsed.y
      }
    } catch {
      // ignore malformed persisted state
    }
  }
}
