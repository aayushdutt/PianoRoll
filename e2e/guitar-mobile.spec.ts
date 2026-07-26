import { expect, test } from '@playwright/test'
import { loadMidi, numberData } from './helpers/guitar'

async function touch(
  client: import('@playwright/test').CDPSession,
  type: 'touchStart' | 'touchMove' | 'touchEnd',
  x?: number,
  y?: number,
): Promise<void> {
  await client.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: x === undefined || y === undefined ? [] : [{ x, y, radiusX: 3, radiusY: 3 }],
  })
}

async function tap(
  client: import('@playwright/test').CDPSession,
  locator: import('@playwright/test').Locator,
): Promise<void> {
  const box = (await locator.boundingBox())!
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await touch(client, 'touchStart', x, y)
  await touch(client, 'touchEnd')
}

async function persistGuitarMode(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem('midee.visualizationMode', 'guitar'))
}

async function expectGuitarMode(page: import('@playwright/test').Page): Promise<void> {
  await expect(page.getByRole('radio', { name: 'Show guitar visualization' })).toBeChecked()
  await expect(page.locator('body')).toHaveClass(/visualization-guitar/)
  await expect(page.locator('#guitar-surface')).toBeVisible()
}

test.describe('Guitar mobile (touch)', () => {
  test('390x844 touch pan suppresses auto-follow', async ({ page, context }) => {
    expect(page.viewportSize()).toEqual({ width: 390, height: 844 })
    expect(await page.evaluate(() => navigator.maxTouchPoints)).toBeGreaterThan(0)
    await persistGuitarMode(page)
    await loadMidi(page)
    await expectGuitarMode(page)
    const canvas = page.locator('#guitar-surface')
    await expect(canvas).toHaveCSS('touch-action', 'pan-y')
    const box = (await canvas.boundingBox())!
    const client = await context.newCDPSession(page)
    const y = box.y + box.height * 0.75

    await touch(client, 'touchStart', box.x + 330, y)
    await touch(client, 'touchMove', box.x + 210, y)
    await touch(client, 'touchMove', box.x + 80, y)
    await touch(client, 'touchEnd')
    const panned = await numberData(page, 'e2e-pan-x')
    expect(panned).toBeGreaterThan(0)

    // Immediate auto-follow suppression: starting playback right after a manual
    // pan must not snap the highway back to the playhead's fret (FretboardInteraction
    // suspends auto-follow for AUTO_FOLLOW_SUSPEND_MS after the last manual pan).
    await tap(client, page.locator('#hud-play'))
    await expect.poll(() => numberData(page, 'e2e-active-voices')).toBeGreaterThan(0)
    expect(await numberData(page, 'e2e-pan-x')).toBeCloseTo(panned, 0)
    await tap(client, page.locator('#hud-play'))
  })

  test('a fresh no-MIDI Live session: a real fret touch raises active voices and touchEnd releases them', async ({
    page,
    context,
  }) => {
    expect(page.viewportSize()).toEqual({ width: 390, height: 844 })
    expect(await page.evaluate(() => navigator.maxTouchPoints)).toBeGreaterThan(0)
    // No `loadMidi()` here — this proves the fretboard's own touch->audio path
    // independent of any loaded MIDI/highway state, starting from a clean baseline.
    await persistGuitarMode(page)
    await page.goto('/')
    const client = await context.newCDPSession(page)
    await tap(client, page.locator('#home-live'))
    await expectGuitarMode(page)
    await expect.poll(() => numberData(page, 'e2e-active-voices')).toBe(0)

    const canvas = page.locator('#guitar-surface')
    const target = page.getByRole('button', { name: 'String 1, fret 0, note E4' })
    const box = (await target.boundingBox())!
    const x = box.x + box.width / 2
    const y = box.y + box.height / 2
    expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.id, { x, y })).toBe(
      'guitar-surface',
    )
    await touch(client, 'touchStart', x, y)
    await expect.poll(() => numberData(page, 'e2e-active-voices')).toBeGreaterThan(0)
    await expect(canvas).toHaveAttribute('data-e2e-surface-hit-count', '1')
    await touch(client, 'touchEnd')
    await expect.poll(() => numberData(page, 'e2e-active-voices')).toBe(0)
    await expect(canvas).toHaveAttribute('data-e2e-surface-hit-count', '2')
    await expect(canvas).toHaveAttribute('data-e2e-last-surface-hit', 'note-off:64:5:0')
  })
})
