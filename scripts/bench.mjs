#!/usr/bin/env node
// Minimal local perf loop: spawn `vite preview`, open each fixture in a
// headless chromium page, read window.__BENCH_RESULT, diff vs baseline.
//
// Usage:
//   npm run bench             — run once, print diff table vs bench/baseline.json
//   npm run bench -- --update — run once, overwrite baseline with the results

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BENCH_DIR = resolve(ROOT, 'bench')
const LATEST_PATH = resolve(BENCH_DIR, 'latest.json')
const BASELINE_PATH = resolve(BENCH_DIR, 'baseline.json')
const PORT = 4477

const FIXTURES = ['chopin-nocturne-op9-2', 'bach-prelude-c', 'satie-gnossienne-1']
const UPDATE_BASELINE = process.argv.includes('--update')

async function main() {
  if (!existsSync(BENCH_DIR)) mkdirSync(BENCH_DIR, { recursive: true })
  if (!existsSync(resolve(ROOT, 'dist/index.html'))) {
    console.error('no dist/ — run `npm run build` first (or use `npm run bench`, which does it)')
    process.exit(1)
  }

  const server = await startPreview()
  let browser
  try {
    browser = await chromium.launch({
      args: [
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--autoplay-policy=no-user-gesture-required',
      ],
    })
    const results = []
    for (const fixture of FIXTURES) {
      process.stdout.write(`  ${fixture.padEnd(28)} `)
      const result = await runFixture(browser, fixture)
      results.push(result)
      console.log(
        `${result.medianFrameMs.toFixed(2)}ms median · p95 ${result.p95FrameMs.toFixed(2)}ms · load ${result.loadMs.toFixed(0)}ms`,
      )
    }

    const payload = { at: new Date().toISOString(), results }
    writeFileSync(LATEST_PATH, JSON.stringify(payload, null, 2))

    if (UPDATE_BASELINE) {
      writeFileSync(BASELINE_PATH, JSON.stringify(payload, null, 2))
      console.log(`\nbaseline updated → ${relpath(BASELINE_PATH)}`)
      return
    }

    printDiff(payload)
  } finally {
    await browser?.close()
    server.kill('SIGTERM')
  }
}

async function runFixture(browser, fixture) {
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  page.on('pageerror', (err) => console.error(`\n  [page error] ${err.message}`))
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.error(`\n  [page error] ${msg.text()}`)
  })
  try {
    await page.goto(`http://localhost:${PORT}/?bench=${fixture}`, { waitUntil: 'load' })
    const result = await page.waitForFunction(
      () => window.__BENCH_RESULT || (window.__BENCH_ERROR && { __err: window.__BENCH_ERROR }),
      null,
      { timeout: 120_000 },
    )
    const value = await result.jsonValue()
    if (value.__err) throw new Error(`bench failed: ${value.__err}`)
    return value
  } finally {
    await ctx.close()
  }
}

function startPreview() {
  return new Promise((resolvePromise, rejectPromise) => {
    const proc = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    let settled = false
    proc.stdout.on('data', (buf) => {
      const s = buf.toString()
      if (!settled && s.includes(`localhost:${PORT}`)) {
        settled = true
        resolvePromise(proc)
      }
    })
    proc.on('exit', (code) => {
      if (!settled) rejectPromise(new Error(`vite preview exited with ${code}`))
    })
  })
}

function printDiff(payload) {
  if (!existsSync(BASELINE_PATH)) {
    console.log(`\nno baseline yet — run \`npm run bench -- --update\` to create one`)
    return
  }
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
  const byFixture = new Map(baseline.results.map((r) => [r.fixture, r]))
  console.log('\nfixture                         median Δ           p95 Δ             load Δ')
  console.log('─'.repeat(82))
  let biggestRegression = 0
  let biggestImprovement = 0
  for (const r of payload.results) {
    const b = byFixture.get(r.fixture)
    if (!b) {
      console.log(`  ${r.fixture.padEnd(28)} (new)`)
      continue
    }
    const dMed = pct(r.medianFrameMs, b.medianFrameMs)
    const dP95 = pct(r.p95FrameMs, b.p95FrameMs)
    const dLoad = pct(r.loadMs, b.loadMs)
    biggestRegression = Math.max(biggestRegression, dMed, dP95)
    biggestImprovement = Math.min(biggestImprovement, dMed, dP95)
    console.log(
      `  ${r.fixture.padEnd(28)} ${fmt(r.medianFrameMs, dMed)}  ${fmt(r.p95FrameMs, dP95)}  ${fmt(r.loadMs, dLoad)}`,
    )
  }
  console.log()
  if (biggestRegression >= 10) {
    console.log(`⚠  regression: ${biggestRegression.toFixed(1)}% slower on worst metric`)
  } else if (biggestImprovement <= -10) {
    console.log(`✓  faster: ${(-biggestImprovement).toFixed(1)}% better on best metric`)
  } else {
    console.log(`≈  within noise (reg ${biggestRegression.toFixed(1)}% / imp ${biggestImprovement.toFixed(1)}%)`)
  }
  console.log('run `npm run bench:update` to accept current numbers as the new baseline')
}

function pct(now, base) {
  if (!base) return 0
  return ((now - base) / base) * 100
}

function fmt(value, delta) {
  const sign = delta >= 0 ? '+' : ''
  const tag = delta >= 10 ? '↑' : delta <= -5 ? '↓' : ' '
  return `${value.toFixed(2).padStart(6)} (${sign}${delta.toFixed(1)}%)${tag}`.padEnd(18)
}

function relpath(p) {
  return p.replace(`${ROOT}/`, '')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
