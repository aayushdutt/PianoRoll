import { defineConfig, devices } from '@playwright/test'

// E2E config for midee (Tier 3 of docs/TESTING_STRATEGY_2026-06-21.md).
//
// midee is a static Vite SPA whose flagship feature — MP4 export — runs entirely
// in the browser via WebCodecs (`VideoEncoder`/`AudioEncoder`) + Mediabunny. jsdom
// cannot exercise that, so these tests drive a real headless Chromium.
//
// webServer: `vite build && vite preview` — NOT `npm run build`. We deliberately
//   skip `tsc` (a separate CI step) and the whole postbuild chain (build-content,
//   build-og, stamp-sitemap, check-links, upload-sourcemaps) — none of it is needed
//   to serve `/`, and check-links/upload-sourcemaps do network I/O + need secrets.
//   A bare `vite build` is ~1.4s and produces a fully functional bundle.
//
// Speed: the default suite runs in ~28s serial (lean build + 6 light specs). We run
//   workers: 1 ON PURPOSE — playback.spec asserts the real-time clock advances at
//   ~real-time, which gets starved (and flaky) if a sibling spec saturates the CPU.
//   The two heavy video export tests (software H.264 encode) are gated behind
//   E2E_HEAVY and isolated in a dependency-ordered project that runs after the
//   ordinary desktop/mobile projects. This keeps the default run fast and keeps
//   post-encode SwiftShader load away from real-time tests. Run the full set with
//   `npm run test:e2e:heavy`.

const PORT = Number(process.env.E2E_PORT ?? 4173)
const BASE_URL = `http://localhost:${PORT}`
const IS_HEAVY = process.env.E2E_HEAVY === '1'
const HEAVY_EXPORT_TITLES =
  /AV export produces a valid MP4 with video \+ audio tracks|heavy export captures the active guitar surface into a valid 720p 24fps video-only MP4/
// Without --disable-audio-output headless Chromium's AudioContext.currentTime
// freezes at ~0.005 s even though the context state is 'running' — the audio
// clock stalls because there is no real output device to drive it. A null
// audio sink (--disable-audio-output) lets the clock advance at wall-clock
// rate, which unblocks MasterClock / Tone.js, the play scrubber, and
// Play-Along auto-progress. Applied to all three profiles.
const DISABLE_AUDIO_ARG = '--disable-audio-output'

const desktopChromium = {
  ...devices['Desktop Chrome'],
  launchOptions: {
    // The four H.264 flags are needed only for VideoExporter.pickCodec which
    // probes H.264 with `hardwareAcceleration: 'prefer-hardware'` — plain
    // headless Chromium rejects that without ANGLE+SwiftShader. This is a
    // TEST-SIDE WORKAROUND FOR BUG-1; remove once BUG-1 is fixed.
    args: [
      DISABLE_AUDIO_ARG,
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--ignore-gpu-blocklist',
      '--enable-unsafe-swiftshader',
    ],
  },
}

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: BASE_URL,
    headless: true,
    // Animated canvas snapshots captured by tracing can multiply SwiftShader's
    // load enough to push heavy WebCodecs exports past their explicit timeout.
    trace: IS_HEAVY ? 'off' : 'retain-on-failure',
    video: 'off',
  },
  projects: [
    {
      name: 'chromium',
      testIgnore: /guitar-mobile\.spec\.ts/,
      ...(IS_HEAVY ? { grepInvert: HEAVY_EXPORT_TITLES } : {}),
      use: {
        // Plain Desktop Chrome — only the audio-clock fix, no ANGLE/SwiftShader.
        // Those SW GL args push Chrome's GPU process to ~780 % CPU and freeze
        // real-time clocks; they live only in chromium-heavy (desktopChromium).
        ...devices['Desktop Chrome'],
        launchOptions: { args: [DISABLE_AUDIO_ARG] },
        ...(IS_HEAVY ? { trace: 'retain-on-failure' as const } : {}),
      },
    },
    {
      name: 'mobile-chromium',
      testMatch: /guitar-mobile\.spec\.ts/,
      ...(IS_HEAVY ? { grepInvert: HEAVY_EXPORT_TITLES } : {}),
      ...(IS_HEAVY ? { dependencies: ['chromium'] } : {}),
      use: {
        ...devices['iPhone 13'],
        // `devices['iPhone 13']` defaults to WebKit, which has no CDP session —
        // this spec drives touch via `context.newCDPSession` + `Input.dispatchTouchEvent`
        // (CDP is Chromium-only), so force Chromium while keeping the device's
        // touch/mobile emulation (isMobile, hasTouch, deviceScaleFactor, UA).
        // No SW GL — only the audio-clock fix to unblock MasterClock.
        defaultBrowserType: 'chromium',
        viewport: { width: 390, height: 844 },
        launchOptions: { args: [DISABLE_AUDIO_ARG] },
        ...(IS_HEAVY ? { trace: 'retain-on-failure' as const } : {}),
      },
    },
    ...(IS_HEAVY
      ? [
          {
            // SwiftShader/WebCodecs can starve real-time clocks after encoding.
            // Dependencies keep all ordinary desktop/mobile behavior ahead of
            // these two isolated exports instead of weakening their assertions.
            name: 'chromium-heavy',
            dependencies: ['chromium', 'mobile-chromium'],
            grep: HEAVY_EXPORT_TITLES,
            use: desktopChromium,
          },
        ]
      : []),
  ],
  webServer: {
    command: `VITE_ENABLE_E2E=1 npx vite build && npx vite preview --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 180_000,
  },
})
