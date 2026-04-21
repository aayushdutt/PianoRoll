// Renders a standalone HTML preview of midee's Google SERP card and its
// social unfurl (Slack / Twitter / Discord / LinkedIn). Reads the live
// index.html for title / description / canonical / OG tags, inlines the
// 96×96 favicon and og:image (if it can find one on disk), and writes a
// self-contained file that opens straight from the filesystem — no dev
// server, no network, no dependencies beyond Node's stdlib.
//
// Usage:
//   npm run preview:serp      # writes dist/serp-preview.html and opens it
//   node scripts/preview-serp.mjs --no-open   # skip auto-open

import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import { platform } from 'node:process'

const root = process.cwd()
const outPath = resolve(root, 'dist/serp-preview.html')
const html = readFileSync(resolve(root, 'index.html'), 'utf8')

// ── Tiny regex-based tag extractor ─────────────────────────────────
// The index.html is hand-written and well-formed — no need for a full
// HTML parser. These helpers grab the attribute we want and bail if the
// tag is missing.
const attr = (source, attrName) => (source.match(new RegExp(`${attrName}="([^"]*)"`, 'i')) ?? [])[1]

const metaByName = (name) => {
  const tag = html.match(new RegExp(`<meta[^>]*name="${name}"[^>]*>`, 'i'))?.[0]
  return tag ? attr(tag, 'content') : undefined
}
const metaByProp = (prop) => {
  const tag = html.match(new RegExp(`<meta[^>]*property="${prop}"[^>]*>`, 'i'))?.[0]
  return tag ? attr(tag, 'content') : undefined
}

const title = html.match(/<title>([^<]+)<\/title>/)?.[1]?.trim() ?? ''
const description = metaByName('description') ?? ''
const canonical =
  (html.match(/<link[^>]*rel="canonical"[^>]*>/i)?.[0] &&
    attr(html.match(/<link[^>]*rel="canonical"[^>]*>/i)?.[0] ?? '', 'href')) ||
  'https://midee.app'
const ogTitle = metaByProp('og:title') ?? title
const ogDescription = metaByProp('og:description') ?? description
const ogSiteName = metaByProp('og:site_name') ?? new URL(canonical).hostname
const ogImageUrl = metaByProp('og:image') ?? ''

// ── Inline referenced assets as data URIs ──────────────────────────
// So the output HTML works when double-clicked, with no server and no
// network. Try a few sensible paths before giving up.
const toDataUrl = (filePath) => {
  if (!existsSync(filePath)) return null
  const buf = readFileSync(filePath)
  const ext = extname(filePath).slice(1).toLowerCase()
  const mime = ext === 'svg' ? 'image/svg+xml' : `image/${ext === 'jpg' ? 'jpeg' : ext}`
  return `data:${mime};base64,${buf.toString('base64')}`
}

const faviconData =
  toDataUrl(resolve(root, 'public/icons/favicon-96.png')) ??
  toDataUrl(resolve(root, 'public/icons/favicon.svg'))

// og:image → local disk: try /dist/og.png first (postbuild output),
// then /public/<path>, then anything matching the basename.
const ogPathFromUrl = (() => {
  try {
    return new URL(ogImageUrl).pathname.replace(/^\//, '')
  } catch {
    return ogImageUrl.replace(/^\//, '')
  }
})()
const ogImageData =
  (ogPathFromUrl && toDataUrl(resolve(root, 'dist', ogPathFromUrl))) ??
  (ogPathFromUrl && toDataUrl(resolve(root, 'public', ogPathFromUrl))) ??
  null

// ── Lightweight lint against Google's soft limits ──────────────────
// Google truncates by pixel, not character count, so these are
// approximations — but they match what SERP snippet tools flag.
const checks = []
const check = (cond, severity, msg) => checks.push({ ok: cond, severity: cond ? 'ok' : severity, msg })

check(title.length > 0, 'err', `<title> present (${title.length} chars)`)
check(title.length <= 60, 'warn', `<title> ≤ 60 chars (actual: ${title.length}) — longer titles get truncated on desktop`)
check(description.length > 0, 'err', `<meta description> present (${description.length} chars)`)
check(description.length >= 70, 'warn', `description ≥ 70 chars (actual: ${description.length}) — too short can reduce CTR`)
check(description.length <= 160, 'warn', `description ≤ 160 chars (actual: ${description.length}) — longer gets truncated`)
check(!!canonical, 'err', `canonical URL set (${canonical})`)
check(!!faviconData, 'err', `favicon located on disk (public/icons/favicon-96.png)`)
check(!!ogImageData, 'err', `og:image located on disk (${ogImageUrl || '—'})`)
check(!!ogTitle, 'warn', `og:title present`)
check(!!ogDescription, 'warn', `og:description present`)

// ── Render ─────────────────────────────────────────────────────────
const escape = (s) =>
  String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')

const hostname = (() => {
  try {
    return new URL(canonical).hostname
  } catch {
    return canonical
  }
})()

const faviconImg = faviconData
  ? `<img class="serp-favicon" src="${faviconData}" alt="">`
  : `<div class="serp-favicon serp-favicon--missing" aria-hidden="true">?</div>`

const renderSerp = (mode) => `
  <div class="serp serp--${mode}">
    <div class="serp-head">
      ${faviconImg}
      <div class="serp-meta">
        <div class="serp-sitename">${escape(ogSiteName)}</div>
        <div class="serp-url">${escape(canonical)}</div>
      </div>
    </div>
    <a class="serp-title" href="${escape(canonical)}">${escape(title)}</a>
    <div class="serp-desc">${escape(description)}</div>
  </div>
`

const socialImgBlock = ogImageData
  ? `<img class="social-img" src="${ogImageData}" alt="OG image">`
  : `<div class="social-missing">
       <div class="social-missing-title">og:image not found on disk</div>
       <div class="social-missing-sub">${escape(ogImageUrl || '(no og:image meta tag)')}</div>
     </div>`

const preview = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>SERP preview · ${escape(hostname)}</title>
<style>
  :root {
    --ink: #202124;
    --ink-dim: #4d5156;
    --ink-faint: #5f6368;
    --link: #1a0dab;
    --link-dark: #8ab4f8;
    --border: #dadce0;
    --card-bg: #fff;
    --dark-bg: #202124;
    --dark-ink: #e8eaed;
    --dark-dim: #bdc1c6;
    --ok: #188038;
    --warn: #bf6900;
    --err: #c5221f;
  }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: arial, sans-serif; background: #f6f7f9; color: var(--ink); }
  .page { max-width: 840px; margin: 0 auto; padding: 32px 16px 80px; }
  .hero { margin-bottom: 24px; }
  .hero h1 { font-size: 18px; margin: 0 0 4px; font-weight: 600; }
  .hero p { font-size: 13px; color: var(--ink-faint); margin: 0; }
  .section-title {
    font-size: 11px; text-transform: uppercase; letter-spacing: 0.12em;
    color: var(--ink-faint); margin: 32px 0 10px; font-weight: 600;
  }
  .card {
    background: var(--card-bg); padding: 20px 24px; border-radius: 12px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.06), 0 0 0 1px rgba(0,0,0,0.04);
  }
  .card.dark { background: var(--dark-bg); }

  /* Google SERP */
  .serp { max-width: 652px; }
  .serp-head { display: flex; align-items: center; gap: 12px; margin-bottom: 2px; }
  .serp-favicon {
    width: 26px; height: 26px; border-radius: 50%; background: #fff;
    padding: 4px; object-fit: contain; border: 1px solid var(--border);
  }
  .serp-favicon--missing {
    display: flex; align-items: center; justify-content: center;
    color: #c5221f; font-weight: 700; border-color: #c5221f;
  }
  .serp--dark .serp-favicon { background: #303134; border-color: #3c4043; }
  .serp-meta { line-height: 1.35; }
  .serp-sitename { font-size: 14px; color: var(--ink); font-weight: 400; }
  .serp-url { font-size: 12px; color: var(--ink-dim); }
  .serp--dark .serp-sitename { color: var(--dark-ink); }
  .serp--dark .serp-url { color: var(--dark-dim); }
  .serp-title {
    display: block; font-size: 20px; line-height: 1.3;
    color: var(--link); text-decoration: none; margin: 4px 0 4px;
    font-weight: 400;
  }
  .serp--dark .serp-title { color: var(--link-dark); }
  .serp-title:hover { text-decoration: underline; }
  .serp-desc {
    font-size: 14px; line-height: 1.58; color: var(--ink-dim);
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .serp--dark .serp-desc { color: var(--dark-dim); }

  /* Mobile frame */
  .mobile-wrap {
    max-width: 390px; margin: 0; border-radius: 28px;
    border: 10px solid #222; overflow: hidden; background: #fff;
  }
  .mobile-wrap .card { border-radius: 0; box-shadow: none; padding: 20px 18px; }
  .mobile-wrap .serp-title { font-size: 18px; }

  /* Social (Slack/Twitter/Discord style) */
  .social {
    max-width: 520px; border: 1px solid #e3e5e8; border-radius: 10px;
    overflow: hidden; background: #fff;
  }
  .social-img { display: block; width: 100%; aspect-ratio: 1.91 / 1; object-fit: cover; background: #f1f3f4; }
  .social-missing {
    aspect-ratio: 1.91 / 1; background:
      repeating-linear-gradient(45deg, #fff3f3, #fff3f3 14px, #ffe5e5 14px, #ffe5e5 28px);
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    color: #721c24; padding: 16px; text-align: center;
  }
  .social-missing-title { font-weight: 700; font-size: 14px; }
  .social-missing-sub { font-size: 12px; margin-top: 4px; word-break: break-all; opacity: 0.7; }
  .social-body { padding: 12px 16px 14px; }
  .social-site {
    font-size: 12px; color: #6a737d; text-transform: none; letter-spacing: 0;
  }
  .social-title { font-size: 15px; color: #1d1d1f; margin: 2px 0 4px; font-weight: 600; line-height: 1.35; }
  .social-desc {
    font-size: 13px; color: #606770; line-height: 1.4;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  }

  /* Lint */
  .lint ul { margin: 0; padding-left: 20px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; line-height: 1.8; }
  .lint li::marker { color: var(--ink-faint); }
  .lint .ok { color: var(--ok); }
  .lint .warn { color: var(--warn); }
  .lint .err { color: var(--err); }

  /* Extracted tags raw view */
  .raw { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; line-height: 1.65; color: var(--ink-dim); }
  .raw b { color: var(--ink); font-weight: 600; }

  /* Two-col layout for desktop variants */
  .row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  @media (max-width: 720px) { .row { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<div class="page">
  <div class="hero">
    <h1>SERP preview · ${escape(hostname)}</h1>
    <p>Rendered from <code>index.html</code> + <code>public/icons/</code>. Offline — safe to double-click.</p>
  </div>

  <div class="section-title">Desktop (light / dark)</div>
  <div class="row">
    <div class="card">${renderSerp('light')}</div>
    <div class="card dark">${renderSerp('dark')}</div>
  </div>

  <div class="section-title">Mobile</div>
  <div class="mobile-wrap"><div class="card">${renderSerp('light')}</div></div>

  <div class="section-title">Social card · Slack, Twitter, Discord, LinkedIn</div>
  <div class="social">
    ${socialImgBlock}
    <div class="social-body">
      <div class="social-site">${escape(hostname)}</div>
      <div class="social-title">${escape(ogTitle)}</div>
      <div class="social-desc">${escape(ogDescription)}</div>
    </div>
  </div>

  <div class="section-title">Checks</div>
  <div class="card lint">
    <ul>
      ${checks
        .map(
          (c) =>
            `<li class="${c.severity}">${c.severity === 'ok' ? '✓' : c.severity === 'warn' ? '⚠' : '✗'} ${escape(c.msg)}</li>`,
        )
        .join('\n      ')}
    </ul>
  </div>

  <div class="section-title">Extracted tags</div>
  <div class="card raw">
    <div><b>&lt;title&gt;</b>: ${escape(title)}</div>
    <div><b>meta description</b>: ${escape(description)}</div>
    <div><b>canonical</b>: ${escape(canonical)}</div>
    <div><b>og:site_name</b>: ${escape(ogSiteName)}</div>
    <div><b>og:title</b>: ${escape(ogTitle)}</div>
    <div><b>og:description</b>: ${escape(ogDescription)}</div>
    <div><b>og:image</b>: ${escape(ogImageUrl)} ${ogImageData ? '<span class="ok">(found on disk)</span>' : '<span class="err">(NOT on disk)</span>'}</div>
  </div>
</div>
</body>
</html>
`

mkdirSync(resolve(root, 'dist'), { recursive: true })
writeFileSync(outPath, preview)

const kb = (Buffer.byteLength(preview) / 1024).toFixed(1)
console.log(`[preview-serp] wrote ${outPath} (${kb} KB)`)

// ── Auto-open in default browser (skippable via --no-open) ─────────
const skipOpen = process.argv.includes('--no-open')
if (!skipOpen) {
  const opener = platform === 'darwin' ? 'open' : platform === 'win32' ? 'start ""' : 'xdg-open'
  try {
    execSync(`${opener} "${outPath}"`, { stdio: 'ignore' })
  } catch {
    console.log(`[preview-serp] open it manually: file://${outPath}`)
  }
}
