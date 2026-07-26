import { readFile } from 'node:fs/promises'
import { expect, type Locator, type Page, test } from '@playwright/test'
import toneMidi from '@tonejs/midi'
import { installFakeMidi, loadMidi, numberData, selectGuitar, sendMidi } from './helpers/guitar'
import { parseTopLevelBoxes, readMovieDurationSeconds, readTrackHandlers } from './helpers/mp4'

const { Midi } = toneMidi

// Fixture used via `loadMidi()` (fixtures/multi-track.mid); same clip the AV/audio
// export specs pin their duration tolerance to (see e2e/export.spec.ts).
const FIXTURE_DURATION_S = 1.95

// `#pianoroll` never sets its own `pointer-events` (PianoRollRenderer only toggles
// CSS `visibility` — see src/renderer/PianoRollRenderer.ts). Proving exclusive
// ownership therefore can't rely on a `pointer-events` CSS assertion on the piano
// canvas without changing production code out of scope for guitar mode. Instead we
// prove it the way a real click would: `visibility` (is it paint-and-hit-testable
// at all) plus `document.elementFromPoint` (which element actually receives a hit
// at a shared coordinate) — a `visibility: hidden` element is skipped by hit-testing
// even though its computed `pointer-events` stays 'auto'.
async function elementIdAtCenter(page: Page, locator: Locator): Promise<string | null> {
  const box = await locator.boundingBox()
  if (!box) return null
  return page.evaluate(
    ({ x, y }) => document.elementFromPoint(x, y)?.id ?? null,
    { x: box.x + box.width / 2, y: box.y + box.height / 2 },
  )
}

// Samples the Play-Along scrubber's value once per animation frame, tying the
// "is it actually paused" proof to real render frames instead of a wall-clock
// `waitForTimeout` guess.
async function scrubberValuesAcrossFrames(page: Page, frameCount: number): Promise<number[]> {
  return page.evaluate((count) => {
    const el = document.querySelector('.pa-hud__scrubber') as HTMLInputElement
    const values: number[] = []
    let framesLeft = count
    return new Promise<number[]>((resolve) => {
      const sample = () => {
        values.push(Number(el.value))
        framesLeft -= 1
        if (framesLeft > 0) requestAnimationFrame(sample)
        else resolve(values)
      }
      requestAnimationFrame(sample)
    })
  }, frameCount)
}

test.describe('Guitar visualization', () => {
  test('keyboard fretboard grid activates notes, owns navigation, and remains pointer-transparent', async ({
    page,
  }) => {
    await page.goto('/')
    await page.locator('#home-live').click()
    await selectGuitar(page)
    const grid = page.getByRole('grid', { name: 'Interactive guitar fretboard' })
    await expect(grid).toHaveAttribute('aria-rowcount', '6')
    await expect(grid.getByRole('row')).toHaveCount(6)
    const buttons = grid.getByRole('button')
    await expect(buttons).toHaveCount(150)
    const openHighE = page.getByRole('button', { name: 'String 1, fret 0, note E4' })
    await openHighE.focus()
    await expect(openHighE).toBeFocused()
    await page.keyboard.press('End')
    const highE24 = page.getByRole('button', { name: 'String 1, fret 24, note E6' })
    await expect(highE24).toBeFocused()
    await expect.poll(() => numberData(page, 'e2e-pan-x')).toBeGreaterThan(0)
    await expect(grid.locator('button[tabindex="0"]')).toHaveCount(1)
    const canvas = page.locator('#guitar-surface')
    const centerHit = async () => {
      const box = (await highE24.boundingBox())!
      return page.evaluate(
        ({ x, y }) => document.elementFromPoint(x, y)?.id,
        { x: box.x + box.width / 2, y: box.y + box.height / 2 },
      )
    }
    await expect.poll(centerHit).toBe('guitar-surface')
    await page.keyboard.press('Enter')
    await expect(canvas).toHaveAttribute('data-e2e-surface-hit-count', '2')
    await page.keyboard.press('Space')
    await expect(canvas).toHaveAttribute('data-e2e-surface-hit-count', '4')
    await expect(canvas).toHaveAttribute('data-e2e-last-surface-hit', 'note-off:88:5:24')
    await page.keyboard.press('Tab')
    await expect(highE24).not.toBeFocused()
    await page.getByRole('radio', { name: 'Show guitar visualization' }).check()
    await openHighE.focus()
    await page.getByRole('radio', { name: 'Show piano visualization' }).check()
    const hiddenGrid = page.locator('.guitar-accessibility-grid')
    await expect(hiddenGrid).toBeHidden()
    await expect(hiddenGrid).toHaveAttribute('inert', '')
    expect(
      await hiddenGrid.evaluate((element) => element.contains(document.activeElement)),
    ).toBe(false)
  })

  test('loads MIDI, switches surfaces, renders the highway/fretboard, and persists', async ({
    page,
  }) => {
    const midi = new Midi()
    midi.header.setTempo(120)
    const track = midi.addTrack()
    for (const [index, pitch] of [40, 45, 50, 55, 59, 64, 67, 69].entries()) {
      track.addNote({ midi: pitch, time: index, duration: 0.8, velocity: 0.8 })
    }
    await page.goto('/')
    await page.locator('#midi-input').setInputFiles({
      name: 'guitar-highway-long.mid',
      mimeType: 'audio/midi',
      buffer: Buffer.from(midi.toArray()),
    })
    const playButton = page.locator('#hud-play')
    await expect(playButton).toBeVisible({ timeout: 30_000 })
    await selectGuitar(page)
    const pianoroll = page.locator('#pianoroll')
    const guitarSurface = page.locator('#guitar-surface')

    await expect(pianoroll).toHaveCSS('visibility', 'hidden')
    await expect(guitarSurface).toHaveCSS('visibility', 'visible')
    await expect(guitarSurface).toHaveCSS('pointer-events', 'auto')
    // Exclusive ownership: a click at the guitar canvas's own coordinates must
    // hit the guitar canvas, not a hidden piano canvas occupying the same rect.
    await expect.poll(() => elementIdAtCenter(page, guitarSurface)).toBe('guitar-surface')

    await expect.poll(() => numberData(page, 'e2e-upcoming-voices')).toBeGreaterThan(0)

    const highwayBefore = await guitarSurface.getAttribute('data-e2e-highway-frame')
    // Canonical synth readiness contract: #ts-instrument aria-busy=false is set
    // by instrumentMenu.setLoading before controls.setInstrumentLoading, both
    // driven by the same loadingInstrument subscription. The class check below
    // is kept as redundant UI evidence of the same transition.
    await expect(page.locator('#ts-instrument')).toHaveAttribute('aria-busy', 'false', {
      timeout: 30_000,
    })
    await expect(playButton).not.toHaveClass(/btn-play--loading/, { timeout: 30_000 })
    await playButton.click()
    await expect.poll(() => numberData(page, 'e2e-active-voices')).toBeGreaterThan(0)
    await expect
      .poll(() => guitarSurface.getAttribute('data-e2e-highway-frame'))
      .not.toBe(highwayBefore)
    await playButton.click()

    await page.reload()
    await expect(page.getByRole('radio', { name: 'Show guitar visualization' })).toBeChecked()
    await expect(page.locator('body')).toHaveClass(/visualization-guitar/)

    // A reload with no MIDI loaded lands back on the HOME dropzone, which
    // covers the visualization radios (intercepting clicks on them) even
    // though the guitar preference persisted correctly above. Enter Live to
    // dismiss the overlay before interacting with the radios again.
    await page.locator('#home-live').click()
    await expect(guitarSurface).toBeVisible()

    await page.getByRole('radio', { name: 'Show piano visualization' }).check()
    await expect(guitarSurface).toHaveCSS('visibility', 'hidden')
    await expect(guitarSurface).toHaveCSS('pointer-events', 'none')
    await expect(pianoroll).toHaveCSS('visibility', 'visible')
    // Ownership flips back: the same coordinate now hits the (now-visible)
    // piano canvas instead.
    await expect.poll(() => elementIdAtCenter(page, pianoroll)).toBe('pianoroll')
  })

  test('keeps visualization and timbre independent', async ({ page }) => {
    await loadMidi(page)
    await selectGuitar(page)
    await page.locator('#ts-instrument').click()
    await page.locator('.instrument-item[data-id="digital"]').click()
    await expect(page.locator('#ts-instrument-label')).toHaveText('Digital')
    await expect(page.getByRole('radio', { name: 'Show guitar visualization' })).toBeChecked()
    await expect(page.locator('#guitar-surface')).toBeVisible()
  })

  test('routes equal pitches on separate MIDI channels through the real MIDI stack', async ({
    page,
  }) => {
    await installFakeMidi(page)
    await page.goto('/')
    await page.locator('#home-live').click()
    await selectGuitar(page)
    await expect(page.locator('#ts-midi')).toContainText(/Playwright MIDI|MIDI/i)

    await sendMidi(page, [0x90, 60, 100])
    await sendMidi(page, [0x91, 60, 100])
    await expect.poll(() => numberData(page, 'e2e-active-voices')).toBe(2)
    await expect(page.locator('#guitar-surface')).toHaveAttribute('data-e2e-active-pitches', '60,60')

    await sendMidi(page, [0x80, 60, 0])
    await expect.poll(() => numberData(page, 'e2e-active-voices')).toBe(1)
    await sendMidi(page, [0x81, 60, 0])
    await expect.poll(() => numberData(page, 'e2e-active-voices')).toBe(0)
  })

  test('forces piano for piano-only Learn exercises and restores guitar', async ({ page }) => {
    await loadMidi(page)
    await selectGuitar(page)
    const pianoroll = page.locator('#pianoroll')
    const guitarSurface = page.locator('#guitar-surface')

    await page.locator('#ts-mode-learn').click()
    // Learn opens straight into the exercise hub, where `LearnController
    // .showHubView()` unconditionally hides the active renderer
    // (`renderer.setVisible(false)`) regardless of the piano/guitar
    // preference — so wait for the catalog card itself, not a loaded-piece
    // Play-Along view, and don't assert canvas visibility until inside an
    // exercise (checked below, once it's forced to piano).
    const earTrainingCard = page.locator('.ex-card[data-category="ear-training"]')
    await earTrainingCard.waitFor({ state: 'visible', timeout: 30_000 })
    await earTrainingCard.click()
    await expect(page.getByRole('radio', { name: 'Show piano visualization' })).toBeChecked()
    await expect(page.getByRole('radio', { name: 'Show guitar visualization' })).toBeDisabled()
    // The force is a real surface switch, not just a disabled radio: body drops
    // the guitar-mode class and the guitar canvas gives up pointer ownership
    // while the piano-only exercise is active.
    await expect(page.locator('body')).not.toHaveClass(/visualization-guitar/)
    await expect(pianoroll).toHaveCSS('visibility', 'visible')
    await expect(guitarSurface).toHaveCSS('visibility', 'hidden')
    await expect(guitarSurface).toHaveCSS('pointer-events', 'none')

    await page.locator('.iv-card__close').click()
    // Closing an exercise returns to the Learn hub, where showHubView hides
    // the renderer again — assert the guitar preference/radio is restored,
    // but don't require a visible canvas while still in the hub.
    await expect(page.getByRole('radio', { name: 'Show guitar visualization' })).toBeEnabled()
    await expect(page.getByRole('radio', { name: 'Show guitar visualization' })).toBeChecked()

    // Leave Learn for Live to prove the restore is real, not just the radio's
    // checked state: guitar-mode class + canvas visibility/pointer ownership.
    await page.locator('#ts-mode-live').click()
    await expect(page.locator('body')).toHaveClass(/visualization-guitar/)
    await expect(guitarSurface).toHaveCSS('visibility', 'visible')
    await expect(guitarSurface).toHaveCSS('pointer-events', 'auto')
    await expect(pianoroll).toHaveCSS('visibility', 'hidden')
  })

  test('keeps unsupported notes visible, skips the time-zero unsupported step, and waits for the playable E4', async ({
    page,
  }) => {
    const midi = new Midi()
    midi.header.setTempo(120)
    // Entirely-unsupported chord at t=0 (outside standard tuning's fretboard
    // range) — guitarPitchFilter excludes it from wait-mode, so Play-Along must
    // advance past it automatically instead of blocking on it.
    // Unsupported pitch 20 lasts the full 4 s so it stays renderer-visible
    // throughout the E4 wait — proving the guitar surface keeps showing it
    // even while wait-mode holds the transport at the E4 gate.
    midi.addTrack().addNote({ midi: 20, time: 0, duration: 4.0, velocity: 0.8 })
    // Playable E4 (pitch 64) at t=2.0 — the sole wait-mode gate.
    // Placed at 2.0s so the transport has time to auto-progress past the
    // unsupported opening and fully stabilize before the held-scrubber assertion
    // samples it. Duration 2.0s yields a ~4-second total clip with ~2 seconds
    // of end headroom after the t=2 gate.
    midi.addTrack().addNote({ midi: 64, time: 2.0, duration: 2.0, velocity: 0.8 })
    await page.goto('/')
    await page.locator('#midi-input').setInputFiles({
      name: 'unsupported-and-playable.mid',
      mimeType: 'audio/midi',
      buffer: Buffer.from(midi.toArray()),
    })
    await selectGuitar(page)
    await expect.poll(() => numberData(page, 'e2e-unsupported-voices')).toBeGreaterThan(0)
    await page.getByRole('button', { name: 'Learn this piece' }).click()
    await expect(page.locator('.pa-hud')).toBeVisible({ timeout: 30_000 })
    // The playable E4 remains the only practice target; the out-of-range pitch
    // stays renderer-visible but never blocks the Play-Along transport.
    await expect(page.locator('.pa-hud__play')).toBeVisible()
    await expect.poll(() => numberData(page, 'e2e-unsupported-voices')).toBeGreaterThan(0)

    // PlayAlongExercise auto-starts playback on mount (`engine.play()` in
    // index.ts) — no click needed, and clicking here would toggle it back to
    // paused, racing whatever time it happened to land on. Just wait for the
    // transport to actually be playing before reading the scrubber.
    const scrubber = page.locator('.pa-hud__scrubber')
    await expect(page.locator('.pa-hud__play')).toHaveClass(/is-playing/)

    // Skip proof: the transport must auto-progress away from time zero without
    // any user input, proving the unsupported opening step is ignored by
    // wait-mode. Poll until scrubber is clearly past 0.05s.
    await expect.poll(async () => Number(await scrubber.inputValue())).toBeGreaterThan(0.05)

    // Wait proof: sample the scrubber once per animation frame with no input —
    // wait-mode pauses the clock at E4 (~2.0s), so every sampled frame must
    // read the identical value. A broad upper bound of 2.5s covers both the
    // 2.0s gate and the animation-frame dispatch latency, without tightening
    // bounds enough to produce spurious failures. The set-size == 1 check is
    // the real stability assertion; the bounds just guard against sampling
    // too early or too late.
    await expect
      .poll(async () => new Set(await scrubberValuesAcrossFrames(page, 3)).size)
      .toBe(1)
    const heldFrames = await scrubberValuesAcrossFrames(page, 10)
    expect(new Set(heldFrames).size, `scrubber drifted across frames: ${heldFrames.join(',')}`).toBe(
      1,
    )
    const heldValue = heldFrames[0]!
    // Lower bound 1.5 confirms the clock is frozen at the E4 gate (t≈2.0),
    // not an early transient — the independent >0.05 poll above already
    // proved auto-skip; this proves wait-mode is holding at the right place.
    expect(heldValue).toBeGreaterThanOrEqual(1.5)
    expect(heldValue).toBeLessThanOrEqual(2.5)

    // Press and release the mapped computer key for E4 ('c' -> KeyC -> pitch 64,
    // per e2e/live-input.spec.ts's NOTE_MAP). The correct note clears the gate
    // and the transport advances past both: the held scrubber value + 0.05 and
    // the 2.1s hard floor (well past the 2.0s gate). No waitForTimeout — the
    // poll drives the assertion with real animation-frame timing.
    await page.keyboard.down('c')
    await page.keyboard.up('c')
    await expect
      .poll(async () => Number(await scrubber.inputValue()))
      .toBeGreaterThan(Math.max(2.1, heldValue + 0.05))
  })

  test('heavy export captures the active guitar surface into a valid 720p 24fps video-only MP4', async ({
    page,
  }) => {
    test.skip(!process.env.E2E_HEAVY, 'heavy guitar video encode — run with E2E_HEAVY=1')
    await loadMidi(page)
    await selectGuitar(page)
    await page.locator('#ts-record').click()
    await expect(page.locator('#export-modal')).toHaveClass(/open/)
    await page.locator('#export-modal .fps-btn', { hasText: 'Video only' }).click()
    await page.locator('#export-modal .res-card', { hasText: '720p' }).click()
    await page.locator('#export-modal .fps-btn', { hasText: '24' }).click()
    const downloadPromise = page.waitForEvent('download', { timeout: 90_000 })
    await page.locator('#export-modal .modal-btn--accent').click()
    await expect(page.locator('#guitar-surface')).toHaveAttribute('data-e2e-capture-source', 'guitar')
    const download = await downloadPromise
    const bytes = new Uint8Array(await readFile(await download.path()))
    expect(download.suggestedFilename()).toMatch(/\.mp4$/)
    expect(bytes.byteLength).toBeGreaterThan(2_000)

    const boxes = parseTopLevelBoxes(bytes)
    expect(boxes.map((box) => box.type)).toEqual(expect.arrayContaining(['ftyp', 'moov', 'mdat']))
    const mdat = boxes.find((box) => box.type === 'mdat')
    expect(mdat?.payloadSize ?? 0, 'mdat payload must hold encoded samples').toBeGreaterThan(2_000)

    // Video-only: exactly a video track, no audio track.
    const handlers = readTrackHandlers(bytes)
    expect(handlers).toContain('vide')
    expect(handlers).not.toContain('soun')

    // Duration ≈ clip length, same tolerance as the piano AV export spec.
    const dur = readMovieDurationSeconds(bytes)
    expect(dur, 'mvhd duration present').not.toBeNull()
    expect(dur!, `mvhd duration ${dur}s should be ≈${FIXTURE_DURATION_S}s`).toBeGreaterThan(1.6)
    expect(dur!, `mvhd duration ${dur}s should be ≈${FIXTURE_DURATION_S}s`).toBeLessThan(2.5)
  })
})
