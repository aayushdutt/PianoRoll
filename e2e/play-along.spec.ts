import { fileURLToPath } from 'node:url'
import { expect, type Page, test } from '@playwright/test'

// Play-along HUD e2e (Tier 3 of docs/TESTING_STRATEGY_2026-06-21.md).
//
// WHY THESE LIVE HERE AND NOT IN VITEST: every assertion below is about
// LAYOUT — rendered widths, stacking, overlap. jsdom implements no layout
// engine, so getBoundingClientRect() returns zeros there and the same
// assertions would pass without measuring anything. Each case corresponds to a
// bug that shipped and was caught only by looking at a screenshot:
//   - the HUD stretching full-height when top-anchored (CSS rule ordering)
//   - the scrubber shrinking whenever the score grew (grid track sizing)
//   - the loop pill's live duration shoving the row on every pointermove
//
// FLOW: `#ts-learn-this` in the top strip launches play-along directly with the
// loaded file — there is no hub card to click.

const FIXTURE_MID = fileURLToPath(new URL('../fixtures/multi-track.mid', import.meta.url))

async function enterPlayAlong(page: Page): Promise<void> {
  await page.goto('/')
  await page.setInputFiles('#midi-input', FIXTURE_MID)
  const learn = page.locator('#ts-learn-this')
  await expect(learn).toBeVisible({ timeout: 15_000 })
  await learn.click()
  await expect(page.locator('.pa-hud')).toBeVisible({ timeout: 15_000 })
  // The HUD idle-fades while playing; hovering keeps it interactable so
  // Playwright's actionability checks never race the fade.
  await page.locator('.pa-hud').hover()
}

async function widthOf(page: Page, selector: string): Promise<number> {
  const box = await page.locator(selector).boundingBox()
  if (!box) throw new Error(`no box for ${selector}`)
  return box.width
}

test.describe('play-along HUD', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await enterPlayAlong(page)
  })

  test('anchors to the top edge without stretching', async ({ page }) => {
    const box = await page.locator('.pa-hud').boundingBox()
    expect(box).not.toBeNull()
    // Top-anchored, below the top strip.
    expect(box!.y).toBeLessThan(200)
    // Regression guard: `.float-hud--top` declared BEFORE `.float-hud` lost the
    // specificity tie, so `bottom` survived alongside `top` and an absolutely
    // positioned box stretches between two edges instead of moving.
    expect(box!.height).toBeLessThan(240)
  })

  test('the score growing widens the HUD, never the scrubber', async ({ page }) => {
    const scrubBefore = await widthOf(page, '#pa-scrubber')
    const hudBefore = await widthOf(page, '.pa-hud')

    // A streak chip appearing is the real-world trigger. Injecting rather than
    // earning one keeps this deterministic — the claim under test is about
    // layout, not about scoring.
    await page.evaluate(() => {
      const chip = document.createElement('span')
      chip.className = 'pa-hud__stat'
      chip.textContent = '🔥 99+'
      document.querySelector('#pa-stats')?.prepend(chip)
    })
    await page.waitForTimeout(150)

    // The scrubber is a drag target and holds its width exactly...
    expect(await widthOf(page, '#pa-scrubber')).toBeCloseTo(scrubBefore, 0)
    // ...because the container absorbs the growth instead.
    expect(await widthOf(page, '.pa-hud')).toBeGreaterThan(hudBefore)
    // And it must still have room: at the max-width cap there is nowhere left
    // for growth to go, and the score starts colliding with the duration
    // readout. The cap is sized against the worst case — every counter at its
    // 99+ bound — which measures ~854px.
    expect(await widthOf(page, '.pa-hud')).toBeLessThanOrEqual(880)
  })

  test('the streak warming up moves nothing', async ({ page }) => {
    // The chip used to be hidden at zero, so it popped in on the first clean
    // note and vanished on every mistake — a layout shift at exactly the moment
    // you are watching the notes rather than the HUD.
    const hudBefore = await widthOf(page, '.pa-hud')
    const scrubBefore = await widthOf(page, '#pa-scrubber')
    await expect(page.locator('.pa-hud__stat--streak')).toBeVisible()

    await page.evaluate(() => {
      const el = document.querySelector('.pa-hud__stat--streak')
      el?.classList.remove('is-cold')
      el?.classList.add('pa-hud__stat--streak-hot')
      const num = el?.querySelector('.pa-hud__stat-num')
      if (num) num.textContent = '12'
    })
    await page.waitForTimeout(150)

    expect(await widthOf(page, '.pa-hud')).toBeCloseTo(hudBefore, 0)
    expect(await widthOf(page, '#pa-scrubber')).toBeCloseTo(scrubBefore, 0)
  })

  test('loop: toggling seeds a region, and trimming it does not resize the pill', async ({
    page,
  }) => {
    const pill = page.locator('#pa-loop')
    await pill.click()

    const startHandle = page.locator('#pa-loop-start')
    const endHandle = page.locator('#pa-loop-end')
    await expect(startHandle).toBeVisible()
    await expect(endHandle).toBeVisible()

    const durationBefore = await page.locator('#pa-loop .pa-hud__pill-sub').textContent()
    const pillWidthBefore = await widthOf(page, '#pa-loop')

    // Drag the end handle left to shorten the region.
    const box = (await endHandle.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 - 120, box.y + box.height / 2, { steps: 8 })
    await page.mouse.up()

    const durationAfter = await page.locator('#pa-loop .pa-hud__pill-sub').textContent()
    expect(durationAfter).not.toBe(durationBefore)
    // The readout sits in a fixed slot; it updates on every pointermove, so an
    // auto-width box would shove the whole options row throughout the gesture.
    expect(await widthOf(page, '#pa-loop')).toBeCloseTo(pillWidthBefore, 0)
  })

  test('the loop pill clears via its attached x, not the body', async ({ page }) => {
    await page.locator('#pa-loop').click()
    await expect(page.locator('#pa-loop-start')).toBeVisible()

    // Body now restarts rather than clearing — the loop must survive it.
    await page.locator('#pa-loop').click()
    await expect(page.locator('#pa-loop-start')).toBeVisible()

    await page.locator('.pa-hud__loop-clear').click()
    await expect(page.locator('#pa-loop-start')).toHaveCount(0)
  })

  // The scrubber is PINNED on desktop so the score cannot squeeze it, but the
  // HUD is width-capped on small screens and cannot grow — so there the bar has
  // to give the space back instead. Pinned at both sizes, it simply overflowed
  // the panel and painted through the score.
  // Widths chosen from a sweep, not intuition: spot-checking 480/700/1280 all
  // passed while 780 and 900 were visibly broken. 780 sits in the band where the
  // HUD is viewport-capped but the pin was still active; 900 is the breakpoint
  // itself; 420 is where the score takes its own row.
  for (const width of [420, 480, 700, 780, 900, 940, 1280]) {
    test(`the transport row fits without overlap @ ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 })
      await page.locator('.pa-hud').hover()

      // A full score makes this the realistic worst case.
      await page.evaluate(() => {
        const stats = document.querySelector('#pa-stats')
        const chip = document.createElement('span')
        chip.className = 'pa-hud__stat'
        chip.textContent = '🔥 8'
        stats?.prepend(chip)
        const wrap = document.createElement('span')
        wrap.className = 'pa-hud__stats-breakdown'
        wrap.innerHTML =
          '<span class="pa-hud__stat">✓ 8</span><span class="pa-hud__stat">◌ 0</span><span class="pa-hud__stat">× 0</span>'
        stats?.appendChild(wrap)
      })
      await page.waitForTimeout(150)

      const hud = (await page.locator('.pa-hud').boundingBox())!
      const scrub = (await page.locator('#pa-scrubber').boundingBox())!
      const stats = (await page.locator('#pa-stats').boundingBox())!

      // Inside the panel.
      expect(scrub.x).toBeGreaterThanOrEqual(hud.x - 1)
      expect(scrub.x + scrub.width).toBeLessThanOrEqual(hud.x + hud.width + 1)

      // Not painting through the score. This must be a 2D test: below 440px the
      // score wraps to its own row, where comparing x-edges alone reports a
      // huge phantom overlap.
      const overlapX =
        Math.min(scrub.x + scrub.width, stats.x + stats.width) - Math.max(scrub.x, stats.x)
      const overlapY =
        Math.min(scrub.y + scrub.height, stats.y + stats.height) - Math.max(scrub.y, stats.y)
      expect(overlapX > 0 && overlapY > 0).toBe(false)

      // Still usable as a drag target.
      expect(scrub.width).toBeGreaterThan(40)
    })
  }
})
