import { expect, type Page, test } from '@playwright/test'

// Theme selection + persistence in a real browser: customize popover click →
// App.applyTheme writes `--accent*` onto <html> → `midee.theme` id survives reload.
//
// Home-screen gotcha: `#dropzone` (z-index 100) sits above `.ts-popover`
// (z-index 60), so the home card covers the Dark/Midnight/Neon tiles. Tests
// leave the home screen via `#home-live` before clicking a tile. Drop
// `leaveHomeScreen` once the stacking is fixed.

const THEME_KEY = 'midee.theme'
const LEGACY_KEY = 'midee.themeIndex'

// Mirrors `Theme.accent` in src/renderer/theme.ts. THEMES order is
// [dark, midnight, neon, sunset, ocean].
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
  expect(await page.evaluate(() => window.isSecureContext)).toBe(true)
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
  // Hover first — the top strip dims on idle.
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

    await expect
      .poll(() => accentVar(page, '--accent'), {
        timeout: 15_000,
        message: '--accent should become the Neon accent',
      })
      .toBe(ACCENT.neon)
    expect(await accentVar(page, '--accent-soft')).toBe(`${ACCENT.neon}2e`)
    expect(await accentVar(page, '--accent-glow')).toBe(`${ACCENT.neon}66`)

    await expect(themeTile(page, 'Neon')).toHaveClass(/customize-theme-tile--on/)

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
    // Returning user with only the legacy integer index; seeded before the bundle runs.
    await page.addInitScript(
      ([themeKey, legacyKey, index]) => {
        localStorage.removeItem(themeKey as string)
        localStorage.setItem(legacyKey as string, String(index))
      },
      [THEME_KEY, LEGACY_KEY, NEON_INDEX] as const,
    )

    await gotoApp(page)

    await expect
      .poll(() => accentVar(page, '--accent'), {
        timeout: 15_000,
        message: 'legacy index 2 should resolve to the Neon theme',
      })
      .toBe(ACCENT.neon)

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
