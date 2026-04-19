import './styles/main.css'
import { inject } from '@vercel/analytics'
import posthog from 'posthog-js'
import { registerAnalyticsContext } from './analytics'
import { App } from './app'

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

const app = new App()

void app.init().catch((err) => {
  console.error('App failed to initialize:', err)
})
