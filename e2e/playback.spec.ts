import { fileURLToPath } from 'node:url'
import { expect, type Locator, type Page, test } from '@playwright/test'

// Task J — Golden-path playback e2e (Tier 3 of docs/TESTING_STRATEGY_2026-06-21.md).
//
// This is the integration safety net that unblocks the DI refactor: it proves the
// real playback wiring (MasterClock ↔ SynthEngine ↔ AudioContext ↔ renderer ↔ HUD)
// is connected in a real browser. MasterClock's unit test (Task A) covers the clock
// arithmetic in isolation; only an e2e can prove pressing PLAY actually advances the
// playhead and that SEEK repositions it coherently.
//
// FLOW / SELECTORS (verified against src/ui/ControlsView.tsx + src/ui/Controls.tsx):
//   - Load MIDI:   hidden `#midi-input` file input → setInputFiles(<fixture .mid>).
//                  Loading transitions the app into PLAY mode and shows the HUD.
//   - Play/Pause:  single toggle button `#hud-play` (onClick → app onPlay). Icon
//                  flips play↔pause; we don't depend on the icon, we observe the
//                  playhead instead.
//   - Playhead:    `#hud-scrubber` (an <input type=range>) — its `.value` is written
//                  every clock tick (~60Hz) by Controls.tsx's `clock.subscribe`
//                  callback with the raw `clock.currentTime` in SECONDS. This is the
//                  highest-resolution, always-present readout (it updates even if the
//                  HUD visually idle-fades, since it's a direct DOM mutation). The
//                  `#hud-time` span is the human-readable m:ss mirror (per-second).
//   - Seek:        set `#hud-scrubber.value` and dispatch a `change` event → the view's
//                  onScrubberChange handler calls `clock.seek(t)` (Controls.tsx ~277).
//
// DETERMINISM: we never assert wall-clock equality or exact frame values. Advancing
// time is asserted with `expect.poll` + tolerance; seek is asserted within a window.
//
// HUD idle-fade gotcha: the main HUD fades to opacity:0 / pointer-events:none after
// 2600ms of no pointer activity *while playing* (FloatingHud DEFAULT_IDLE_MS). The
// `:not(:hover)` in the CSS means hovering keeps it interactable. Before any click on
// `#hud-play` we hover it first so Playwright's actionability check never races the fade.

const FIXTURE_MID = fileURLToPath(new URL('../fixtures/multi-track.mid', import.meta.url))
const FIXTURE_DURATION_S = 1.95 // `@tonejs/midi` parse of fixtures/multi-track.mid

/** Read the live playhead (seconds) straight from the scrubber's numeric value. */
async function playhead(scrubber: Locator): Promise<number> {
  const v = await scrubber.inputValue()
  const n = Number.parseFloat(v)
  return Number.isFinite(n) ? n : 0
}

async function loadFixture(page: Page): Promise<void> {
  await page.goto('/')

  // Secure-context guard — same origin requirement the export specs rely on; also a
  // sanity check that we're on the served preview, not about:blank.
  expect(await page.evaluate(() => window.isSecureContext)).toBe(true)

  const input = page.locator('#midi-input')
  await input.waitFor({ state: 'attached' })
  await input.setInputFiles(FIXTURE_MID)

  // Once loaded, the app enters play mode and the export button un-hides. We reuse
  // that as the "file is ready, HUD is live" signal (same as export.spec.ts).
  await expect(page.locator('#ts-record')).toBeVisible({ timeout: 30_000 })

  // The play HUD is now active; the play button is visible & interactable.
  await expect(page.locator('#hud-play')).toBeVisible({ timeout: 15_000 })
}

/** Hover the play button (defeats idle-fade) then click it. */
async function clickPlay(page: Page): Promise<void> {
  const btn = page.locator('#hud-play')
  await btn.hover()
  await btn.click()
}

/** `data-playing` mirrors the store's playing state (ControlsView.tsx). */
async function isPlaying(page: Page): Promise<boolean> {
  return (await page.locator('#hud-play').getAttribute('data-playing')) === 'true'
}

/** Drive the scrubber exactly as a drag-release does (Controls.tsx → clock.seek). */
async function seekTo(scrubber: Locator, target: number): Promise<void> {
  await scrubber.evaluate((el, t) => {
    const input = el as HTMLInputElement
    input.value = String(t)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }, target)
}

/**
 * The app auto-plays 250 ms after a file loads when audio is allowed
 * (App.autoplayAfterLoad). This spec drives play/pause itself, so it must
 * start from a known PAUSED state at t≈0: wait past the autoplay window,
 * pause if it kicked in, and rewind. Without this the first "play" click
 * toggled an already-playing piece to pause (playhead froze at ~0.3 s).
 */
async function settlePausedAtStart(page: Page, scrubber: Locator): Promise<void> {
  await page.waitForTimeout(400)
  if (await isPlaying(page)) {
    await clickPlay(page)
    await expect.poll(() => isPlaying(page), { timeout: 3_000 }).toBe(false)
  }
  await seekTo(scrubber, 0)
  await expect.poll(() => playhead(scrubber), { timeout: 3_000 }).toBeLessThan(0.2)
}

test.describe('Golden-path playback', () => {
  test('play advances the playhead, pause stops it, seek repositions and resumes', async ({
    page,
  }) => {
    await loadFixture(page)

    const scrubber = page.locator('#hud-scrubber')

    // Sanity: scrubber max reflects the loaded duration (store.duration → scrubber.max).
    await expect
      .poll(async () => Number.parseFloat((await scrubber.getAttribute('max')) ?? '0'), {
        timeout: 15_000,
      })
      .toBeGreaterThan(FIXTURE_DURATION_S * 0.5)

    // Known state: paused at (approximately) zero before we press play.
    await settlePausedAtStart(page, scrubber)

    // ── 1. PLAY → playhead advances at ~real-time ──────────────────────────────
    await clickPlay(page)

    // Poll until the playhead has clearly advanced. We require a small but
    // unambiguous delta (>0.15s) so a single stray tick at t≈0 can't pass it.
    // Generous timeout because audio/instrument warm-up can delay the first tick.
    await expect
      .poll(async () => playhead(scrubber), {
        timeout: 20_000,
        message: 'playhead should advance after pressing play',
      })
      .toBeGreaterThan(0.15)

    // PROPORTIONAL advance check: over a fixed real-time window the playhead must
    // advance by a large fraction of that window. This has teeth where a bare
    // ">a+0.1" check does not — a stalled or 2%-rate clock would pass the loose
    // check but fails here. Window kept short so we stay clear of the 1.95s clip
    // end (where playback would pause/stop and make the delta meaningless).
    const a = await playhead(scrubber)
    const t0 = Date.now()
    await page.waitForTimeout(600)
    const b = await playhead(scrubber)
    const realElapsed = (Date.now() - t0) / 1000
    expect(
      b - a,
      `playhead advanced ${(b - a).toFixed(3)}s over ${realElapsed.toFixed(3)}s real time (expected ≈real-time)`,
    ).toBeGreaterThan(realElapsed * 0.6)

    // ── 2. PAUSE → playhead stops advancing ────────────────────────────────────
    await clickPlay(page) // toggles to pause
    // Let any in-flight tick settle, then sample.
    await expect
      .poll(async () => playhead(scrubber), { timeout: 3_000 })
      .toBeGreaterThan(0) // still has a position (didn't reset)
    const paused1 = await playhead(scrubber)

    // Over 1.2s a playing clock would advance ~1.2s; a paused one must barely
    // move. Tolerance is tight (<0.05) — only a single trailing tick is allowed,
    // and it can't overlap the proportional play threshold above.
    await page.waitForTimeout(1_200)
    const paused2 = await playhead(scrubber)
    expect(
      Math.abs(paused2 - paused1),
      `paused playhead drifted: ${paused1} → ${paused2}`,
    ).toBeLessThan(0.05)

    // ── 3. SEEK → playhead reflects the sought position ────────────────────────
    // Seek to a known position well inside the clip. Driving the scrubber's
    // `change` event is exactly what a user drag-release does (Controls.tsx → clock.seek).
    const SEEK_TARGET = 1.0
    await seekTo(scrubber, SEEK_TARGET)

    // While paused, the clock subscription won't overwrite the scrubber, so its value
    // should equal the sought target (the seek path also calls clock.seek(target)).
    await expect
      .poll(async () => playhead(scrubber), { timeout: 5_000, message: 'seek should reposition' })
      .toBeGreaterThan(SEEK_TARGET - 0.25)
    expect(await playhead(scrubber)).toBeLessThan(SEEK_TARGET + 0.25)

    // ── 4. RESUME → time continues FROM the sought position (audio/visual coherent) ──
    // Capture the FIRST advancing sample after resume. This is the assertion that
    // actually proves coherence: a clock that re-anchored to 0 on resume would
    // produce a first-moving value near 0, not near the 1.0s seek target. A loose
    // "eventually exceeds 1.05s" check is tautological — after running a while a
    // reset-to-0 clock would also pass it — so we must catch the value EARLY.
    const pausedAtSeek = await playhead(scrubber)
    await clickPlay(page) // play again
    let firstMoving = -1
    await expect
      .poll(
        async () => {
          const v = await playhead(scrubber)
          if (v > pausedAtSeek + 0.02 && firstMoving < 0) firstMoving = v
          return firstMoving
        },
        {
          timeout: 20_000,
          message: 'after seek+resume, playhead should start moving again',
        },
      )
      .toBeGreaterThan(0)
    expect(
      firstMoving,
      `first post-resume playhead was ${firstMoving.toFixed(3)}s — must be near the 1.0s seek target, not reset toward 0`,
    ).toBeGreaterThan(SEEK_TARGET - 0.15)

    // The human-readable mirror should also be non-zero & consistent (sanity).
    const timeText = (await page.locator('#hud-time').textContent())?.trim() ?? ''
    expect(timeText, `hud-time: "${timeText}"`).toMatch(/^\d+:\d{2}$/)
    expect(timeText).not.toBe('0:00')

    // Clean stop so the AudioContext/encoder state doesn't linger between tests.
    await clickPlay(page)
  })
})
