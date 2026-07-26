import { fileURLToPath } from 'node:url'
import { expect, type Page } from '@playwright/test'

export const MULTI_TRACK_MIDI = fileURLToPath(
  new URL('../../fixtures/multi-track.mid', import.meta.url),
)

export async function installFakeMidi(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const input = {
      id: 'playwright-midi',
      name: 'Playwright MIDI',
      state: 'connected',
      onmidimessage: null as ((event: Event) => void) | null,
    }
    Object.defineProperty(navigator, 'requestMIDIAccess', {
      configurable: true,
      value: async () => ({ inputs: new Map([[input.id, input]]), onstatechange: null }),
    })
  })
}

export async function loadMidi(page: Page, path = MULTI_TRACK_MIDI): Promise<void> {
  await page.goto('/')
  await page.locator('#midi-input').setInputFiles(path)
  await expect(page.locator('#hud-play')).toBeVisible({ timeout: 30_000 })
}

export async function selectGuitar(page: Page): Promise<void> {
  const radio = page.getByRole('radio', { name: 'Show guitar visualization' })
  await radio.check()
  await expect(radio).toBeChecked()
  await expect(page.locator('body')).toHaveClass(/visualization-guitar/)
  await expect(page.locator('#guitar-surface')).toBeVisible()
}

export async function sendMidi(page: Page, bytes: number[]): Promise<void> {
  // No test-only global hook: re-request the (fake) MIDI access the app itself
  // used to obtain `input` — same object reference, courtesy of the closure in
  // `installFakeMidi` — and fire its `onmidimessage` exactly as a real
  // browser would deliver an incoming MIDI message.
  await page.evaluate(async (message) => {
    type FakeMidiInput = { onmidimessage: ((event: unknown) => void) | null }
    type FakeMidiAccess = { inputs: Map<string, FakeMidiInput> }
    const access = await (
      navigator as unknown as { requestMIDIAccess: () => Promise<FakeMidiAccess> }
    ).requestMIDIAccess()
    const input = access.inputs.values().next().value
    input?.onmidimessage?.({ data: new Uint8Array(message), timeStamp: performance.now() })
  }, bytes)
}

export async function numberData(page: Page, name: string): Promise<number> {
  return Number(await page.locator('#guitar-surface').getAttribute(`data-${name}`))
}
