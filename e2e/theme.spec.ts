import { expect, type Page, test } from '@playwright/test'

// Workstream C of docs/RENDERER_THEME_CLEANUP_2026-09-02.md — theme selection +
// persistence in a real browser.
//
// WHY E2E: the theme round-trip crosses three layers that no unit test spans at
// once — the Solid customize popover (click), `App.applyTheme` (writes
// `--accent` / `--accent-soft` / `--accent-glow` onto <html>), and
// localStorage persistence (`midee.theme` = stable theme id, with a one-time
// migration from the legacy `midee.themeIndex` integer). Only a browser proves
// the CSS custom properties actually land on the document element and survive a
// reload.
//
// FLOW / SELECTORS (verified against src/ui/ControlsView.tsx + src/ui/CustomizeMenu.tsx):
//   - Trigger:  `#ts-customize` — the Appearance pill rendered into the top
//               strip's `#ts-customize-slot`. The top strip is `strip--active`
//               in every mode (including home), so no MIDI file is needed.
//   - HOME-CARD OVERLAP (real, deterministic): `#dropzone` is z-index 100 and
//               `.ts-popover` is z-index 60, so on the home screen the home card
//               (620px, centred) sits ON TOP of the left half of the customize
//               popover. The 5-across theme grid puts Dark/Midnight/Neon under
//               the card — clicking Neon on the home screen is genuinely blocked
//               ("<div class=\"home-card\"> intercepts pointer events"). Sunset /
//               Ocean happen to clear it. So before any tile CLICK we leave the
//               home screen via the `#home-live` tile (same real-user path
//               live-input.spec uses), which hides the dropzone. Boot-state
//               assertions still read `--accent` on the home screen — no
//               interaction needed there.
//   - Popover:  `.ts-customize-menu`, gains `.ts-popover--open` when open. On
//               viewports <=640px it opens as a bottom sheet (`.popover--sheet`);
//               the Desktop Chrome project is 1280px wide, so we get the anchored
//               popover. Either way the tiles are the same nodes.
//   - Tiles:    `button.customize-theme-tile`, `aria-label="<Name> theme"`
//               (untranslated — theme display names are not localized), active
//               class `customize-theme-tile--on`.
//
// DETERMINISM: no wall-clock assertions. Everything that happens after boot or
// after a click is read through `expect.poll` / auto-waiting locators.

const THEME_KEY = 'midee.theme'
const LEGACY_KEY = 'midee.themeIndex'

// Mirrors `Theme.accent` in src/renderer/theme.ts (Pixi hex -> `#rrggbb`).
// THEMES order is [dark, midnight, neon, sunset, ocean] — the legacy index
// migration below depends on `neon` being index 2.
const ACCENT = {
  dark: '#6366f1',
  midnight: '#a78bfa',
  neon: '#00d4aa',
  sunset: '#f97316',
  ocean: '#38bdf8',
} as const
const NEON_INDEX = 2
const DEFAULT_ID = 'sunset' // App's fallback theme.

/** Computed value of a CSS custom property on <html>. */
function accentVar(page: Page, name: '--accent' | '--accent-soft' | '--accent-glow') {
  return page.evaluate(
    (prop) => getComputedStyle(document.documentElement).getPropertyValue(prop).trim(),
    name,
  )
}

function storedThemeId(page: Page): Promise<string | null> {
  return page.evaluate((key) => localStorage.getItem(key), THEME_KEY)
}

/** Locate a theme tile by its accessible name (`"<Name> theme"`). */
function themeTile(page: Page, name: string) {
  return page.getByRole('button', { name: `${name} theme`, exact: true })
}

async function gotoApp(page: Page): Promise<void> {
  await page.goto('/')
  // Secure-context guard — same sanity check the playback/export specs use to
  // prove we're on the served preview origin, not about:blank.
  expect(await page.evaluate(() => window.isSecureContext)).toBe(true)
  // The Appearance pill is mounted by App.init once the top strip exists.
  await page.locator('#ts-customize').waitFor({ state: 'visible', timeout: 30_000 })
}

/**
 * Leave the home screen so the home card stops covering the customize popover.
 * `#home-live` -> App.enterLiveMode is a plain mode switch: it touches no theme
 * state, so every theme assertion stays valid across it.
 */
async function leaveHomeScreen(page: Page): Promise<void> {
  const liveTile = page.locator('#home-live')
  await liveTile.waitFor({ state: 'visible', timeout: 30_000 })
  await liveTile.click()
  await expect(page.locator('#dropzone')).toHaveClass(/dz--hidden/, { timeout: 15_000 })
}

/** Open the customize popover (idempotent-ish: no-ops if already open). */
async function openCustomize(page: Page): Promise<void> {
  const menu = page.locator('.ts-customize-menu')
  if (await menu.evaluate((el) => el.classList.contains('ts-popover--open')).catch(() => false))
    return
  const trigger = page.locator('#ts-customize')
  // Hover first — the top strip dims on idle, mirroring playback.spec's guard
  // against Playwright's actionability check racing a fade.
  await trigger.hover()
  await trigger.click()
  await expect(menu).toHaveClass(/ts-popover--open/, { timeout: 15_000 })
}

async function selectTheme(page: Page, name: string): Promise<void> {
  await openCustomize(page)
  const tile = themeTile(page, name)
  await tile.waitFor({ state: 'visible', timeout: 15_000 })
  await tile.hover()
  await tile.click()
}

test.describe('Theme selection + persistence', () => {
  test('selecting a theme applies its accent vars, marks the tile, and persists the id', async ({
    page,
  }) => {
    await gotoApp(page)
    await leaveHomeScreen(page)

    await selectTheme(page, 'Neon')

    // applyTheme() writes all three accent custom properties onto <html>.
    await expect
      .poll(() => accentVar(page, '--accent'), {
        timeout: 15_000,
        message: '--accent should become the Neon accent',
      })
      .toBe(ACCENT.neon)
    expect(await accentVar(page, '--accent-soft')).toBe(`${ACCENT.neon}2e`)
    expect(await accentVar(page, '--accent-glow')).toBe(`${ACCENT.neon}66`)

    // The tile reflects the active selection (App pushes it back into the menu).
    await expect(themeTile(page, 'Neon')).toHaveClass(/customize-theme-tile--on/)

    // Persisted by STABLE ID, not by index — the whole point of the key change.
    await expect
      .poll(() => storedThemeId(page), {
        timeout: 15_000,
        message: `localStorage['${THEME_KEY}'] should hold the theme id`,
      })
      .toBe('neon')
  })

  test('reload restores the chosen theme', async ({ page }) => {
    await gotoApp(page)
    await leaveHomeScreen(page)
    await selectTheme(page, 'Ocean')
    await expect
      .poll(() => accentVar(page, '--accent'), { timeout: 15_000 })
      .toBe(ACCENT.ocean)
    expect(await storedThemeId(page)).toBe('ocean')

    await page.reload()
    await page.locator('#ts-customize').waitFor({ state: 'visible', timeout: 30_000 })

    // Boot-time load path: stored id -> theme -> applyTheme.
    await expect
      .poll(() => accentVar(page, '--accent'), {
        timeout: 15_000,
        message: 'Ocean should still be active after a reload',
      })
      .toBe(ACCENT.ocean)

    await leaveHomeScreen(page)
    await openCustomize(page)
    await expect(themeTile(page, 'Ocean')).toHaveClass(/customize-theme-tile--on/)
  })

  test('legacy midee.themeIndex is migrated to a theme id on first load', async ({ page }) => {
    // Simulate a returning user from before the key change: only the legacy
    // integer index exists. Seeded via addInitScript so it lands BEFORE the app
    // bundle reads localStorage.
    await page.addInitScript(
      ([themeKey, legacyKey, index]) => {
        localStorage.removeItem(themeKey as string)
        localStorage.setItem(legacyKey as string, String(index))
      },
      [THEME_KEY, LEGACY_KEY, NEON_INDEX] as const,
    )

    await gotoApp(page)

    // Index 2 in THEMES === neon.
    await expect
      .poll(() => accentVar(page, '--accent'), {
        timeout: 15_000,
        message: 'legacy index 2 should resolve to the Neon theme',
      })
      .toBe(ACCENT.neon)

    // The migration writes the id forward so the legacy key is never read again.
    await expect
      .poll(() => storedThemeId(page), {
        timeout: 15_000,
        message: `migration should write '${THEME_KEY}' = 'neon'`,
      })
      .toBe('neon')

    await leaveHomeScreen(page)
    await openCustomize(page)
    await expect(themeTile(page, 'Neon')).toHaveClass(/customize-theme-tile--on/)
  })

  test('an invalid stored theme id falls back to the default theme', async ({ page }) => {
    await page.addInitScript(
      ([themeKey, legacyKey]) => {
        localStorage.setItem(themeKey as string, 'nope')
        localStorage.removeItem(legacyKey as string)
      },
      [THEME_KEY, LEGACY_KEY] as const,
    )

    await gotoApp(page)

    await expect
      .poll(() => accentVar(page, '--accent'), {
        timeout: 15_000,
        message: 'an unknown theme id must fall back to the default (Sunset)',
      })
      .toBe(ACCENT[DEFAULT_ID])

    await leaveHomeScreen(page)
    await openCustomize(page)
    await expect(themeTile(page, 'Sunset')).toHaveClass(/customize-theme-tile--on/)
  })
})
