import './styles/main.css'
import { inject } from '@vercel/analytics'
import posthog from 'posthog-js'
import { App } from './app'
import { currentLocaleNativeName, initI18n, shouldShowLocaleHint, t } from './i18n'
import { registerAnalyticsContext } from './telemetry'

// Privacy-friendly page-view + custom event tracking. Only active once the
// script has been served with a real Vercel project id — in dev or on forks
// it's a no-op that logs to the console. `mode: 'auto'` defers to the Vercel
// environment (production vs. preview).
inject()

const posthogKey = import.meta.env.VITE_POSTHOG_KEY
if (posthogKey) {
  posthog.init(posthogKey, {
    api_host: import.meta.env.VITE_POSTHOG_HOST ?? 'https://us.i.posthog.com',
    defaults: '2026-01-30',
    person_profiles: 'always',
  })
  registerAnalyticsContext()
}

// Load the right locale before constructing UI so the first paint is already
// translated — avoids an English-then-French flash. Adds ~5–15ms for the
// dynamic import on non-English; English is bundled and resolves instantly.
async function boot(): Promise<void> {
  await initI18n()
  const app = new App()
  await app.init()
  // Subtle one-time onboarding for users whose browser language was
  // auto-detected to a non-English locale. Tells them we noticed and
  // points to where they can change it. Marks itself shown immediately
  // (inside shouldShowLocaleHint) so it never returns.
  if (shouldShowLocaleHint()) showLocaleHint()
}

function showLocaleHint(): void {
  const el = document.createElement('div')
  el.className = 'locale-hint'
  el.innerHTML = `
    <span>${t('onboarding.localeDetected', { language: currentLocaleNativeName() })}</span>
    <button class="locale-hint-close" type="button" aria-label="Dismiss">×</button>
  `
  document.body.appendChild(el)
  // Slide in on next frame so the CSS transition fires.
  requestAnimationFrame(() => el.classList.add('locale-hint--shown'))
  const dismiss = (): void => {
    el.classList.remove('locale-hint--shown')
    setTimeout(() => el.remove(), 400)
  }
  el.querySelector<HTMLButtonElement>('.locale-hint-close')?.addEventListener('click', dismiss)
  // Auto-dismiss after 8s — long enough to read, short enough not to nag.
  setTimeout(dismiss, 8000)
}

void boot().catch((err) => {
  console.error('App failed to initialize:', err)
})
