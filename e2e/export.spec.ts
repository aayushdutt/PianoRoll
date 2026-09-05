import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { parseTopLevelBoxes, readMovieDurationSeconds, readTrackHandlers } from './helpers/mp4'

// Task I (FULL export e2e — Step 3a of docs/TESTING_STRATEGY_2026-06-21.md).
//
// The spike (e2e/spike.codec.spec.ts) confirmed WebCodecs H.264 + AAC encode works in
// headless Chromium with NO special flags (secure context only). So we drive the REAL
// flagship export end-to-end and assert the produced file is a valid MP4.
//
// Flow (mapped from src/app.ts + src/ui/*):
//   1. Load a short MIDI via the hidden file input (#midi-input) — we use
//      fixtures/multi-track.mid (1.95s, 2 tracks) so the export is fast.
//   2. The app enters PLAY mode and the export button (#ts-record) un-hides.
//   3. Click #ts-record -> the export modal (#export-modal) opens.
//   4. Pick output, click the Export action -> encoder runs.
//   5. The app finishes by triggering an <a download> click; Playwright's download
//      API captures the bytes. We then validate the MP4 container in-process.
//
// Determinism: we never assert wall-clock timing. Duration is checked against the
// known fixture length with tolerance.

const FIXTURE_MID = fileURLToPath(new URL('../fixtures/multi-track.mid', import.meta.url))
const FIXTURE_DURATION_S = 1.95 // from `@tonejs/midi` parse of fixtures/multi-track.mid

async function loadFixtureAndOpenExport(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/')

  // Secure-context guard — WebCodecs encoders require it (spike finding).
  expect(await page.evaluate(() => window.isSecureContext)).toBe(true)

  // The file input is hidden (display:none) but present; setInputFiles works on it.
  const input = page.locator('#midi-input')
  await input.waitFor({ state: 'attached' })
  await input.setInputFiles(FIXTURE_MID)

  // Loading a file transitions to play mode; the export button un-hides once a file
  // is loaded and not still loading. Wait for it to be visible (not just attached).
  const exportBtn = page.locator('#ts-record')
  await expect(exportBtn).toBeVisible({ timeout: 30_000 })
  await exportBtn.click()

  // Modal opens by gaining the `open` class.
  await expect(page.locator('#export-modal')).toHaveClass(/open/, { timeout: 15_000 })
}

async function runExportAndCapture(
  page: import('@playwright/test').Page,
): Promise<{ bytes: Uint8Array; suggestedFilename: string }> {
  // The export completes by triggering an anchor download; capture it.
  const downloadPromise = page.waitForEvent('download', { timeout: 90_000 })

  // The Export action button is the accent button in the modal.
  await page.locator('#export-modal .modal-btn--accent').click()

  const download = await downloadPromise
  const path = await download.path()
  const bytes = new Uint8Array(await readFile(path))
  return { bytes, suggestedFilename: download.suggestedFilename() }
}

test.describe('MP4 export (flagship, full WebCodecs path)', () => {
  test('AV export produces a valid MP4 with video + audio tracks', async ({ page }) => {
    // The AV path runs a real software H.264 encode (slow + timing-flaky, and may
    // lack a usable encoder on some CI hosts — see BUG-1). It's quarantined from the
    // default run so local/CI stay fast & deterministic. Run with E2E_HEAVY=1
    // (`npm run test:e2e:heavy`). The codec spike + audio-only export already cover
    // the WebCodecs/mux path in the default suite.
    test.skip(!process.env.E2E_HEAVY, 'heavy AV encode — run with E2E_HEAVY=1')
    await loadFixtureAndOpenExport(page)

    // Default output is 'av' (video+audio). Use the smallest preset for speed: 720p.
    await page.locator('#export-modal .res-card', { hasText: '720p' }).click()
    await page.locator('#export-modal .fps-btn', { hasText: '24' }).click()

    const { bytes, suggestedFilename } = await runExportAndCapture(page)

    expect(suggestedFilename).toMatch(/\.mp4$/)
    expect(bytes.byteLength).toBeGreaterThan(1000)

    // Structural smoke test (NOT a full decode): the file must have ftyp + moov +
    // mdat at top level. This proves a well-formed container with declared tracks,
    // not that every sample decodes — a real player would be needed for that.
    const boxes = parseTopLevelBoxes(bytes)
    const types = boxes.map((b) => b.type)
    expect(types, `top-level boxes: ${types.join(',')}`).toContain('ftyp')
    expect(types).toContain('moov')
    expect(types).toContain('mdat')

    // The mdat must carry real sample payload — an empty/garbage mdat would still
    // pass the box-presence checks above, so guard against a header-only file.
    const mdat = boxes.find((b) => b.type === 'mdat')
    expect(mdat!.payloadSize, 'mdat payload must hold encoded samples').toBeGreaterThan(2_000)

    // Track presence: one video ('vide') and one audio ('soun') handler.
    const handlers = readTrackHandlers(bytes)
    expect(handlers, `handlers: ${handlers.join(',')}`).toContain('vide')
    expect(handlers).toContain('soun')

    // Duration ≈ clip length (1.95s). AV trims audio to midi.duration; video frames
    // cover ceil(duration*fps) ≈ 1.96s. Band is tight enough to catch a real trim
    // regression: a half-length export (~0.98s) fails the lower bound, and an
    // untrimmed-tail leak (~3.45s, the audio-only bug reaching AV) fails the upper.
    const dur = readMovieDurationSeconds(bytes)
    expect(dur, 'mvhd duration present').not.toBeNull()
    expect(dur!, `mvhd duration ${dur}s should be ≈${FIXTURE_DURATION_S}s`).toBeGreaterThan(1.6)
    expect(dur!, `mvhd duration ${dur}s should be ≈${FIXTURE_DURATION_S}s`).toBeLessThan(2.5)
  })

  // NOT gated behind E2E_HEAVY: audio-only ships WAV/MP3 (both pure-JS, no codec),
  // so they run on GitHub's Linux Chromium too — unlike the AAC/.m4a path replaced.
  // Both are macOS-Gatekeeper-safe (see src/export/wav.ts, src/export/mp3.ts).
  test('audio-only WAV export is a valid RIFF file trimmed to the clip length', async ({
    page,
  }) => {
    await loadFixtureAndOpenExport(page)

    // "Audio" destination tab, then the WAV format choice (default is MP3).
    // Selectors verified against src/ui/ExportModal.tsx: tabs are
    // `.export-tab` (role=tab, label from i18n `export.tab.audio` = "Audio"),
    // formats are `.export-choice` with an upper-cased title span.
    await page.locator('#export-modal .export-tab', { hasText: 'Audio' }).click()
    await page.locator('#export-modal .export-choice', { hasText: 'WAV' }).click()

    const { bytes, suggestedFilename } = await runExportAndCapture(page)

    expect(suggestedFilename).toMatch(/\.wav$/)
    expect(bytes.byteLength).toBeGreaterThan(1000)

    // RIFF/WAVE container with fmt + data chunks.
    const ascii = (off: number, len: number) =>
      String.fromCharCode(...bytes.subarray(off, off + len))
    expect(ascii(0, 4)).toBe('RIFF')
    expect(ascii(8, 4)).toBe('WAVE')
    expect(ascii(12, 4)).toBe('fmt ')
    expect(ascii(36, 4)).toBe('data')

    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    expect(dv.getUint16(20, true), 'PCM format').toBe(1)
    const channels = dv.getUint16(22, true)
    const sampleRate = dv.getUint32(24, true)
    const blockAlign = dv.getUint16(32, true)
    const dataSize = dv.getUint32(40, true)
    expect(channels).toBeGreaterThan(0)
    expect(sampleRate).toBeGreaterThan(0)
    expect(dataSize).toBeGreaterThan(0)

    // Duration from the PCM data must be ≈ clip length (1.95s) — NOT ~3.45s.
    // This guards BUG-3: the offline render bakes a 1.5s tail that must be trimmed.
    const durationSec = dataSize / (sampleRate * blockAlign)
    expect(durationSec, `wav duration ${durationSec}s should be ≈${FIXTURE_DURATION_S}s`).toBeGreaterThan(1.6)
    expect(durationSec, `wav duration ${durationSec}s should be ≈${FIXTURE_DURATION_S}s`).toBeLessThan(2.5)
  })

  test('audio-only MP3 export is a valid MP3 (frame sync header)', async ({ page }) => {
    await loadFixtureAndOpenExport(page)

    // "Audio" destination tab; MP3 is the default format, but click it to be explicit.
    await page.locator('#export-modal .export-tab', { hasText: 'Audio' }).click()
    await page.locator('#export-modal .export-choice', { hasText: 'MP3' }).click()

    const { bytes, suggestedFilename } = await runExportAndCapture(page)

    expect(suggestedFilename).toMatch(/\.mp3$/)
    expect(bytes.byteLength).toBeGreaterThan(1000)
    // MP3 frame sync: byte0 === 0xFF and the top 3 bits of byte1 set (0xE0).
    expect(bytes[0]).toBe(0xff)
    expect(bytes[1]! & 0xe0).toBe(0xe0)
    // Compressed: should be far smaller than the equivalent WAV (~344 KB for ~2s).
    expect(bytes.byteLength).toBeLessThan(150_000)
  })
})
