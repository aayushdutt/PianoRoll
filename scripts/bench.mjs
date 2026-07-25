#!/usr/bin/env node
// Perf-harness driver — the orchestration half. The in-page measurement half
// is src/bench/runner.ts; see docs/BENCH_HARNESS_V2_2026-07-02.md.
//
// Usage (all through `npm run bench -- <flags>` or `npm run bench:run -- <flags>`):
//   --suite frame,attribution,live,idle   suites to run (default shown)
//   --fixture id,id                       fixtures (default: all, from the page)
//   --cpu N                               CDP CPU throttling (4 ≈ mid-tier phone)
//   --no-gpu                              software raster — GPU cost becomes CPU-visible
//   --dpr N / --viewport WxH              raster-load emulation
//   --device phone|slow                   presets (phone: 390x844@3 + cpu4; slow: cpu6)
//   --headed                              required for the `pacing` suite
//   --runs N                              repeats per suite, best median wins (default 2)
//   --update                              merge results into baseline FOR THIS ENV
//   --json                                machine-readable output
//
// Baseline entries are keyed `envKey :: suite :: fixture`, so numbers from
// different device profiles never get compared against each other — the
// failure mode that made the v1 harness report a +5078% phantom regression.

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

const DEFAULT_SUITES = ['frame', 'attribution', 'live', 'idle']
// Suites where the fixture doesn't matter — run once on the densest fixture.
const FIXTURE_INDEPENDENT = new Set(['idle'])
// Regression gates. `pct` metrics fail at >+10% vs baseline; `pctInverse`
// metrics fail at <-10% (higher-is-better, e.g. encode throughput); `abs`
// metrics fail above the absolute limit with no baseline needed.
const GATES = {
  pct: ['medianFrameMs', 'p95FrameMs', 'medianRenderMs', 'p95RenderMs', 'medianCaptureMs'],
  pctInverse: ['encodeFps'],
  pctThreshold: 10,
  abs: [
    ['homeRendersPerSec', 1],
    ['pausedRendersPerSec', 1],
  ],
}

// ── args ──────────────────────────────────────────────────────────────────

const HELP = `midee perf harness - see docs/BENCH_HARNESS_V2_2026-07-02.md

usage: npm run bench [-- <flags>]        build + run
       npm run bench:run [-- <flags>]    run against existing dist/

  --suite a,b,c     suites: frame, attribution, live, idle, pacing, export
                    (default: frame,attribution,live,idle)
                    export = the real seek→render→VideoFrame→encode loop
  --fixture x,y     fixture ids (default: all - sparse → dense)
  --quick           smoke mode: frame+idle, sparsest+densest fixture, 1 run
  --runs N          repeats per suite, best median wins (default 2)

  --cpu N           CDP CPU throttle (4 ≈ mid-tier phone)
  --no-gpu          software raster - GPU cost becomes CPU-visible
  --dpr N           deviceScaleFactor emulation
  --viewport WxH    viewport emulation
  --device phone    preset: 390x844 @ dpr3, cpu 4×
  --device slow     preset: cpu 6×
  --headed          headed browser (required for the pacing suite)

  --update          merge results into bench/baseline.json for THIS env
  --json            machine-readable output (always also bench/latest.json)

Baselines are keyed by environment - numbers from different device profiles
are never compared. Gates: median/p95 frame ms +10% vs baseline; idle
renders/sec ≤ 1 (absolute).`

function parseArgs(argv) {
  const args = {
    suites: DEFAULT_SUITES,
    suitesExplicit: false,
    fixtures: null, // null = all from page
    cpu: 1,
    noGpu: false,
    dpr: null,
    viewport: null,
    headed: false,
    runs: 2,
    runsExplicit: false,
    quick: false,
    update: false,
    json: false,
  }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    if (a === '--help' || a === '-h') {
      console.log(HELP)
      process.exit(0)
    } else if (a === '--suite') {
      args.suites = next().split(',')
      args.suitesExplicit = true
    } else if (a === '--fixture') args.fixtures = next().split(',')
    else if (a === '--cpu') args.cpu = Number(next())
    else if (a === '--no-gpu') args.noGpu = true
    else if (a === '--dpr') args.dpr = Number(next())
    else if (a === '--viewport') args.viewport = next()
    else if (a === '--headed') args.headed = true
    else if (a === '--runs') {
      args.runs = Math.max(1, Number(next()))
      args.runsExplicit = true
    } else if (a === '--quick') args.quick = true
    else if (a === '--update') args.update = true
    else if (a === '--json') args.json = true
    else if (a === '--device') {
      const preset = next()
      if (preset === 'phone') {
        args.viewport = '390x844'
        args.dpr = 3
        args.cpu = 4
      } else if (preset === 'slow') {
        args.cpu = 6
      } else {
        die(`unknown --device preset: ${preset} (phone|slow)`)
      }
    } else die(`unknown flag: ${a} (--help for usage)`)
  }
  if (args.quick) {
    // Smoke mode: the cheap early-warning loop. Explicit flags still win.
    if (!args.suitesExplicit) args.suites = ['frame', 'idle']
    if (!args.runsExplicit) args.runs = 1
  }
  if (args.suites.includes('pacing') && !args.headed) {
    die('the pacing suite measures real rAF cadence - run it with --headed')
  }
  return args
}

function envKey(args) {
  const parts = [
    `cpu${args.cpu}x`,
    args.noGpu ? 'gpu-off' : 'gpu-on',
    `dpr${args.dpr ?? 'native'}`,
    args.viewport ?? 'default-vp',
    args.headed ? 'headed' : 'headless',
  ]
  return parts.join('|')
}

function die(msg) {
  console.error(msg)
  process.exit(1)
}

// ── browser plumbing ──────────────────────────────────────────────────────

async function launch(args) {
  const launchArgs = [
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--autoplay-policy=no-user-gesture-required',
    '--enable-precise-memory-info',
  ]
  if (args.noGpu) launchArgs.push('--disable-gpu')
  return chromium.launch({ headless: !args.headed, args: launchArgs })
}

async function newPage(browser, args) {
  const ctxOpts = {}
  if (args.viewport) {
    const [w, h] = args.viewport.split('x').map(Number)
    ctxOpts.viewport = { width: w, height: h }
  }
  if (args.dpr) ctxOpts.deviceScaleFactor = args.dpr
  const context = await browser.newContext(ctxOpts)
  const page = await context.newPage()
  page.on('pageerror', (err) => console.error(`  [page error] ${err.message}`))
  page.on('crash', () => console.error('  [page CRASHED]'))
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) console.error(`  [navigated] ${frame.url()}`)
  })
  page.on('console', (msg) => {
    const text = msg.text()
    // Surface render-backend degradation (context loss, software fallback).
    if (/webgl|gpu|context lost|swiftshader/i.test(text)) console.error(`  [page ${msg.type()}] ${text}`)
  })
  if (args.cpu > 1) {
    const session = await context.newCDPSession(page)
    await session.send('Emulation.setCPUThrottlingRate', { rate: args.cpu })
  }
  return { context, page }
}

async function runInPage(browser, args, query) {
  const { context, page } = await newPage(browser, args)
  try {
    await page.goto(`http://localhost:${PORT}/?${query}`, { waitUntil: 'load' })
    let handle
    try {
      handle = await page.waitForFunction(
        () =>
          window.__BENCH_RESULT ||
          window.__BENCH_FIXTURES ||
          (window.__BENCH_ERROR && { __err: window.__BENCH_ERROR }),
        null,
        { timeout: 180_000 },
      )
    } catch (err) {
      // Timeout — surface where the in-page runner got stuck, plus a live
      // delivery probe: do timers / rAF / MessageChannel still fire?
      const state = await page
        .evaluate(
          () =>
            new Promise((res) => {
              const out = {
                progress: window.__BENCH_PROGRESS,
                error: window.__BENCH_ERROR,
                vis: document.visibilityState,
                timer: false,
                raf: false,
                msg: false,
              }
              setTimeout(() => {
                out.timer = true
              }, 50)
              requestAnimationFrame(() => {
                out.raf = true
              })
              const mc = new MessageChannel()
              mc.port1.onmessage = () => {
                out.msg = true
              }
              mc.port2.postMessage(1)
              setTimeout(() => res(out), 400)
            }),
        )
        .catch(() => null)
      throw new Error(
        `bench timed out on ?${query} - last progress: ${state?.progress ?? 'none'}${state?.error ? `, page error: ${state.error}` : ''}; delivery probe: ${state ? `vis=${state.vis} timer=${state.timer} raf=${state.raf} msg=${state.msg}` : 'unresponsive'}`,
        { cause: err },
      )
    }
    const value = await handle.jsonValue()
    if (value?.__err) throw new Error(`bench failed: ${value.__err}`)
    return value
  } finally {
    await context.close()
  }
}

async function discoverFixtures(browser, args) {
  return runInPage(browser, args, 'bench=list')
}

// Repeat a suite `runs` times; keep the run with the best (lowest) median -
// the standard noise-floor convention. Non-frame metrics come from that same
// winning run so the result stays internally consistent.
async function runSuite(browser, args, suite, fixture) {
  let best = null
  for (let i = 0; i < args.runs; i++) {
    const result = await runInPage(browser, args, `bench=${suite}&fixture=${fixture}`)
    const score = result.metrics.medianFrameMs ?? 0
    if (!best || score < (best.metrics.medianFrameMs ?? 0)) best = result
  }
  return best
}

// ── baseline ──────────────────────────────────────────────────────────────

function loadBaseline() {
  if (!existsSync(BASELINE_PATH)) return { schema: 2, entries: {} }
  const parsed = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
  if (parsed.schema !== 2) {
    console.log('  (v1 baseline detected - ignored; run --update to write a v2 baseline)')
    return { schema: 2, entries: {} }
  }
  return parsed
}

function baselineKey(env, suite, fixture) {
  return `${env} :: ${suite} :: ${fixture}`
}

// ── compare + report ──────────────────────────────────────────────────────

function compare(metrics, baseMetrics) {
  const notes = []
  let regression = false
  for (const key of GATES.pct) {
    if (metrics[key] === undefined) continue
    const base = baseMetrics?.[key]
    if (base === undefined || base === 0) continue
    const delta = ((metrics[key] - base) / base) * 100
    const flag = delta >= GATES.pctThreshold ? '↑ REGRESSION' : delta <= -GATES.pctThreshold ? '↓ improved' : ''
    if (flag) notes.push(`${key} ${delta >= 0 ? '+' : ''}${delta.toFixed(1)}% ${flag}`)
    if (delta >= GATES.pctThreshold) regression = true
  }
  for (const key of GATES.pctInverse) {
    if (metrics[key] === undefined) continue
    const base = baseMetrics?.[key]
    if (base === undefined || base === 0) continue
    const delta = ((metrics[key] - base) / base) * 100
    const flag = delta <= -GATES.pctThreshold ? '↓ REGRESSION' : delta >= GATES.pctThreshold ? '↑ improved' : ''
    if (flag) notes.push(`${key} ${delta >= 0 ? '+' : ''}${delta.toFixed(1)}% ${flag}`)
    if (delta <= -GATES.pctThreshold) regression = true
  }
  for (const [key, limit] of GATES.abs) {
    if (metrics[key] !== undefined && metrics[key] > limit) {
      notes.push(`${key}=${metrics[key]} exceeds ${limit} - VIOLATION`)
      regression = true
    }
  }
  return { regression, notes }
}

// Per-suite table layout: which metrics become columns, in what order.
// Metrics not listed still land in bench/latest.json and --json output.
const SUITE_COLUMNS = {
  frame: [
    'medianFrameMs',
    'p95FrameMs',
    'p99FrameMs',
    'medianPresentMs',
    'heapGrowthMB',
    'noteCount',
  ],
  live: ['medianFrameMs', 'p95FrameMs', 'p99FrameMs', 'medianPresentMs'],
  attribution: [
    'medianFrameMs',
    'notesMsPerFrame',
    'keyboardMsPerFrame',
    'particlesMsPerFrame',
    'beatGridMsPerFrame',
    'liveNotesMsPerFrame',
    'otherMsPerFrame',
  ],
  idle: ['homeRendersPerSec', 'pausedRendersPerSec', 'playingRendersPerSec'],
  pacing: ['fps', 'droppedFramePct', 'p95IntervalMs', 'worstIntervalMs', 'longTasks'],
  export: [
    'medianRenderMs',
    'p95RenderMs',
    'medianCaptureMs',
    'p95CaptureMs',
    'encodeFps',
    'stallMs',
    'hwAccel',
  ],
}

const COLUMN_LABELS = {
  medianFrameMs: 'median ms',
  p95FrameMs: 'p95',
  p99FrameMs: 'p99',
  medianPresentMs: 'present',
  heapGrowthMB: 'heapΔMB',
  noteCount: 'notes',
  notesMsPerFrame: 'notes',
  keyboardMsPerFrame: 'keyboard',
  particlesMsPerFrame: 'particles',
  beatGridMsPerFrame: 'beatGrid',
  liveNotesMsPerFrame: 'liveNotes',
  otherMsPerFrame: 'other',
  homeRendersPerSec: 'home r/s',
  pausedRendersPerSec: 'paused r/s',
  playingRendersPerSec: 'playing r/s',
  fps: 'fps',
  droppedFramePct: 'dropped %',
  p95IntervalMs: 'p95 int',
  worstIntervalMs: 'worst int',
  longTasks: 'longtasks',
  medianRenderMs: 'render ms',
  p95RenderMs: 'p95 rnd',
  medianCaptureMs: 'capture ms',
  p95CaptureMs: 'p95 cap',
  encodeFps: 'encode fps',
  stallMs: 'stall ms',
  hwAccel: 'hw',
}

function formatCell(key, value, baseMetrics) {
  if (value === undefined) return '-'
  let s = String(value)
  const base = baseMetrics?.[key]
  if ((GATES.pct.includes(key) || GATES.pctInverse.includes(key)) && base) {
    const d = ((value - base) / base) * 100
    const mark = d >= GATES.pctThreshold ? '↑' : d <= -GATES.pctThreshold ? '↓' : ''
    s += ` (${d >= 0 ? '+' : ''}${d.toFixed(0)}%)${mark}`
  }
  for (const [k, limit] of GATES.abs) {
    if (k === key && value > limit) s += ' ✗'
  }
  return s
}

function printReport(results, baseline, env, args) {
  const bySuite = new Map()
  for (const r of results) {
    if (!bySuite.has(r.suite)) bySuite.set(r.suite, [])
    bySuite.get(r.suite).push(r)
  }

  let anyUnbaselined = false
  for (const [suite, rows] of bySuite) {
    const cols = SUITE_COLUMNS[suite] ?? Object.keys(rows[0].result.metrics)
    const header = ['fixture', ...cols.map((c) => COLUMN_LABELS[c] ?? c)]
    const table = [header]
    for (const r of rows) {
      const base = baseline.entries[r.key]
      if (!base) anyUnbaselined = true
      table.push([
        r.fixture + (base ? '' : ' *'),
        ...cols.map((c) => formatCell(c, r.result.metrics[c], base?.metrics)),
      ])
    }
    const widths = header.map((_, i) => Math.max(...table.map((row) => row[i].length)))
    console.log(`\n■ ${suite}`)
    for (let ri = 0; ri < table.length; ri++) {
      const line = table[ri]
        .map((cell, i) => (i === 0 ? cell.padEnd(widths[i]) : cell.padStart(widths[i])))
        .join('   ')
      console.log(`  ${ri === 0 ? dim(line) : line}`)
    }
  }

  if (anyUnbaselined && !args.update) {
    const flags = process.argv
      .slice(2)
      .filter((a) => a !== '--update')
      .join(' ')
    console.log(
      `\n* no baseline for env "${env}" - establish one:\n    npm run bench:run -- ${flags}${flags ? ' ' : ''}--update`,
    )
  }
}

function dim(s) {
  return process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s
}

// ── main ──────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv)
  if (!existsSync(BENCH_DIR)) mkdirSync(BENCH_DIR, { recursive: true })
  if (!existsSync(resolve(ROOT, 'dist/index.html'))) {
    die('no dist/ - run `npm run bench` (builds first) or build manually')
  }

  const server = await startPreview()
  let browser
  const results = []
  let anyRegression = false

  try {
    browser = await launch(args)
    const allFixtures = await discoverFixtures(browser, args)
    let fixtures = args.fixtures ?? allFixtures
    if (args.quick && !args.fixtures) {
      // Smoke mode: cheapest early warning — the sparse floor + dense ceiling.
      fixtures = [allFixtures[0], allFixtures[allFixtures.length - 1]]
    }
    for (const f of fixtures) {
      if (!allFixtures.includes(f)) die(`unknown fixture ${f} - page offers: ${allFixtures.join(', ')}`)
    }
    const env = envKey(args)
    const baseline = loadBaseline()

    if (!args.json) {
      console.log(`env: ${env}  (runs=${args.runs}${args.quick ? ', quick' : ''})`)
    }

    for (const suite of args.suites) {
      const suiteFixtures = FIXTURE_INDEPENDENT.has(suite)
        ? [fixtures[fixtures.length - 1]]
        : fixtures
      for (const fixture of suiteFixtures) {
        const t0 = Date.now()
        const result = await runSuite(browser, args, suite, fixture)
        const key = baselineKey(env, suite, fixture)
        const base = baseline.entries[key]
        const { regression, notes } = compare(result.metrics, base?.metrics)
        anyRegression ||= regression
        results.push({ key, suite, fixture, env, result, notes, regression })
        if (!args.json) {
          const secs = ((Date.now() - t0) / 1000).toFixed(0)
          console.log(`  ${regression ? '⚠' : '✓'} ${suite}/${fixture}  ${secs}s`)
        }
      }
    }
    if (!args.json) printReport(results, baseline, env, args)

    const payload = {
      schema: 2,
      at: new Date().toISOString(),
      env: envKey(args),
      results: results.map((r) => ({ key: r.key, ...r.result })),
    }
    writeFileSync(LATEST_PATH, JSON.stringify(payload, null, 2))

    if (args.update) {
      for (const r of results) {
        baseline.entries[r.key] = {
          at: payload.at,
          ua: r.result.env.ua,
          metrics: r.result.metrics,
        }
      }
      writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2))
      if (!args.json) console.log(`\nbaseline updated for env "${envKey(args)}" → bench/baseline.json`)
    }

    if (args.json) console.log(JSON.stringify(payload, null, 2))
    else if (!args.update) {
      if (anyRegression) {
        console.log('\n⚠  regressions:')
        for (const r of results) {
          for (const n of r.notes) console.log(`   ${r.suite}/${r.fixture}: ${n}`)
        }
        console.log('   accept intentionally: npm run bench:update')
      } else if (results.some((r) => baseline.entries[r.key])) {
        console.log('\n✓  no regressions vs baseline for this env')
      }
    }
    if (anyRegression && !args.update) process.exitCode = 1
  } finally {
    await browser?.close()
    server.kill('SIGTERM')
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
      if (!settled && buf.toString().includes(`localhost:${PORT}`)) {
        settled = true
        resolvePromise(proc)
      }
    })
    proc.on('exit', (code) => {
      if (!settled) rejectPromise(new Error(`vite preview exited with ${code}`))
    })
  })
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
