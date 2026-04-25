import './styles/main.css'
// Self-hosted fonts via @fontsource. Each CSS import emits a `@font-face`
// rule into the main stylesheet bundle and ships its woff2 file to
// `dist/assets/` as a long-cacheable hashed asset. Compared to
// fonts.googleapis.com + fonts.gstatic.com, this saves the cross-origin
// DNS+TLS chain Lighthouse measures as ~360 ms render-blocking on first
// load. `latin-` subsets cover en/es/fr/pt-BR — our shipped locales.
import '@fontsource/inter/latin-400.css'
import '@fontsource/inter/latin-500.css'
import '@fontsource/inter/latin-600.css'
import '@fontsource/inter/latin-700.css'
import '@fontsource/instrument-serif/latin-400.css'
import '@fontsource/instrument-serif/latin-400-italic.css'
import '@fontsource/jetbrains-mono/latin-400.css'
import '@fontsource/jetbrains-mono/latin-500.css'
import '@fontsource/jetbrains-mono/latin-600.css'
import { render } from 'solid-js/web'
import { AppRoot } from './AppRoot'
import { createApp } from './createApp'
import { env } from './env'
import { currentLocaleNativeName, initI18n, shouldShowLocaleHint, t } from './i18n'
import { AppCtx } from './store/AppCtx'
import { loadPostHog, registerAnalyticsContext } from './telemetry'
import { whenIdle } from './whenIdle'

// Both analytics SDKs are loaded on idle so they don't sit in the initial
// bundle. PostHog alone is ~70 KB gz with autocapture / session_recording /
// feature_flags; @vercel/analytics is small but still a deferrable import.
// Buffered events fire once the SDK lands — see telemetry.ts → `loadPostHog`.
const posthogKey = env.VITE_POSTHOG_KEY
if (posthogKey) {
  // Snapshot context props at boot time even though the SDK isn't loaded
  // yet — they get queued and replayed in order on first init.
  registerAnalyticsContext()
}
whenIdle(() => {
  if (posthogKey) {
    void loadPostHog(posthogKey, {
      api_host: env.VITE_POSTHOG_HOST ?? 'https://us.i.posthog.com',
      defaults: '2026-01-30',
      person_profiles: 'always',
    })
  }
  void import('@vercel/analytics').then(({ inject }) => inject())
})

// Load the right locale before constructing UI so the first paint is already
// translated — avoids an English-then-French flash. Adds ~5–15ms for the
// dynamic import on non-English; English is bundled and resolves instantly.
async function boot(): Promise<void> {
  await initI18n()
  const { ctx } = await createApp()
  // Solid owns a dedicated child of #ui-overlay so its render() call doesn't
  // wipe the legacy UI (Controls, DropZone, TrackPanel, modals) that the
  // wrapped App class has already mounted into #ui-overlay directly.
  // Ported tasks (T4+) progressively move those surfaces into the Solid tree.
  const overlay = document.querySelector<HTMLElement>('#ui-overlay')!
  const solidRoot = document.createElement('div')
  solidRoot.id = 'solid-root'
  overlay.appendChild(solidRoot)
  render(
    () => (
      <AppCtx.Provider value={ctx}>
        <AppRoot />
      </AppCtx.Provider>
    ),
    solidRoot,
  )
  // Subtle one-time onboarding for users whose browser language was
  // auto-detected to a non-English locale.
  if (shouldShowLocaleHint()) showLocaleHint()

  // Bench runner is a build-time opt-in. `npm run bench` sets
  // VITE_ENABLE_BENCH=1; public prod builds don't, so Vite constant-folds the
  // condition to `false` and tree-shakes both the dynamic import and the
  // branch — `bench/runner.ts` never reaches the public bundle, and
  // `?bench=...` URLs are inert in prod. Read `import.meta.env` directly (not
  // through env.ts) so the value is statically inlined for the dead-code pass.
  if (import.meta.env.VITE_ENABLE_BENCH) {
    const { benchFixtureFromUrl, runBench } = await import('./bench/runner')
    const fixture = benchFixtureFromUrl()
    if (fixture) {
      try {
        window.__BENCH_RESULT = await runBench(fixture, ctx)
      } catch (err) {
        window.__BENCH_ERROR = err instanceof Error ? err.message : String(err)
        console.error('[bench]', err)
      }
    }
  }
}

function showLocaleHint(): void {
  const el = document.createElement('div')
  el.className = 'locale-hint'
  el.innerHTML = `
    <span>${t('onboarding.localeDetected', { language: currentLocaleNativeName() })}</span>
    <button class="locale-hint-close" type="button" aria-label="Dismiss">×</button>
  `
  document.body.appendChild(el)
  requestAnimationFrame(() => el.classList.add('locale-hint--shown'))
  const dismiss = (): void => {
    el.classList.remove('locale-hint--shown')
    setTimeout(() => el.remove(), 400)
  }
  el.querySelector<HTMLButtonElement>('.locale-hint-close')?.addEventListener('click', dismiss)
  setTimeout(dismiss, 8000)
}

void boot().catch((err) => {
  console.error('App failed to initialize:', err)
})
