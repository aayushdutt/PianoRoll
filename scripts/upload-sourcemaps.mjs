#!/usr/bin/env node
// Inject chunk IDs into built JS bundles + upload paired source maps to
// PostHog. Runs as the last step of `npm run build` (chained from
// `postbuild` in package.json) so error events reported in production land
// with symbolicated frames.
//
// Skipped silently when the required env vars aren't set — keeps local
// builds (`npm run build` on a dev machine) from failing without PostHog
// credentials. CI / production deploys MUST set:
//   POSTHOG_CLI_API_KEY      — Personal API token (scoped to "Error tracking")
//   POSTHOG_CLI_PROJECT_ID   — numeric project id from PostHog → settings
//   POSTHOG_CLI_HOST         — optional, defaults to https://us.posthog.com
//
// Source: vite.config.ts emits `sourcemap: 'hidden'` (.map files alongside
// .js, no `sourceMappingURL` comment). The maps stay on the build server
// only — they ship to PostHog, not to public CDN.

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const REQUIRED = ['POSTHOG_CLI_API_KEY', 'POSTHOG_CLI_PROJECT_ID']
const missing = REQUIRED.filter((k) => !process.env[k])
if (missing.length > 0) {
  console.log(`[posthog-sourcemaps] skipping (missing ${missing.join(', ')})`)
  process.exit(0)
}

const distDir = resolve(process.cwd(), 'dist')
if (!existsSync(distDir)) {
  console.error(`[posthog-sourcemaps] dist/ not found at ${distDir} — run \`npm run build\` first`)
  process.exit(1)
}

// `process` runs `inject` then `upload` in one pass — atomically pairs the
// injected chunk-ids with their uploaded maps. If either step fails, the
// CLI exits non-zero and our build fails.
//
// `--release-version` ties the upload to a release. We use the short git
// SHA when available (set by Vercel as VERCEL_GIT_COMMIT_SHA) so PostHog
// can show "this error happened on commit abc1234" — invaluable when
// triaging "is this fixed yet?".
const version =
  process.env.POSTHOG_RELEASE_VERSION ??
  process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ??
  process.env.GITHUB_SHA?.slice(0, 7) ??
  'local'

const args = ['posthog-cli', 'sourcemap', 'process', '--directory', distDir, '--release-name', 'midee', '--release-version', version]

console.log(`[posthog-sourcemaps] processing ${distDir} (release midee@${version})`)
const r = spawnSync('npx', args, { stdio: 'inherit' })
process.exit(r.status ?? 1)
