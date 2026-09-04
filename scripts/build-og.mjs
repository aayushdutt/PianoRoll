// Renders the Open Graph banners (1200×630 PNG) with @resvg/resvg-js and the
// app's real fonts (Instrument Serif, Inter, JetBrains Mono from @fontsource).
//
//   dist/og.png            default site banner (wordmark + tagline)
//   dist/og/<slug>.png     one per content page, with that page's title;
//                          build-content.mjs writes dist/og-pages.json and
//                          points each page's og:image at its banner.
//
// The banner is composed here in JS rather than kept as a static SVG so the
// piano-roll scene (keys, lit keys, falling notes) is generated from one
// geometry and stays aligned, and so per-page titles can be wrapped.
// Runs during postbuild after build-content.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, resolve } from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import { woffToTtf } from './woff-to-ttf.mjs'

const root = process.cwd()
const distDir = resolve(root, 'dist')

// ── Fonts ───────────────────────────────────────────────────────────────
// resvg only loads sfnt (ttf/otf) fonts and @fontsource only ships woff/woff2,
// so unpack the woff files to a scratch dir first. Without this every <text>
// silently rendered as nothing (loadSystemFonts is off).
const FS = resolve(root, 'node_modules/@fontsource')
const woffFiles = [
  `${FS}/instrument-serif/files/instrument-serif-latin-400-normal.woff`,
  `${FS}/instrument-serif/files/instrument-serif-latin-400-italic.woff`,
  `${FS}/inter/files/inter-latin-400-normal.woff`,
  `${FS}/inter/files/inter-latin-500-normal.woff`,
  `${FS}/inter/files/inter-latin-600-normal.woff`,
  `${FS}/inter/files/inter-latin-700-normal.woff`,
  `${FS}/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff`,
  `${FS}/jetbrains-mono/files/jetbrains-mono-latin-500-normal.woff`,
]
const fontDir = resolve(tmpdir(), 'midee-og-fonts')
mkdirSync(fontDir, { recursive: true })
const fontFiles = woffFiles.map((woff) => {
  const ttf = resolve(fontDir, basename(woff).replace(/\.woff$/, '.ttf'))
  writeFileSync(ttf, woffToTtf(readFileSync(woff)))
  return ttf
})

// ── Palette ─────────────────────────────────────────────────────────────
const ACCENT = '#f97316'
const INK = '#f5f3ef'
const INK_SOFT = '#b9b6c2'
const INK_DIM = '#6f6d7c'

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// ── Text wrapping ───────────────────────────────────────────────────────
// resvg can't measure text, so estimate advance widths per glyph class.
// Tuned by eye against renders; a few px of error is invisible at this size.
function textWidth(str, size, font) {
  let w = 0
  for (const ch of str) {
    let u
    if (font === 'serif') {
      u = /[ilj.,'’:;!|]/.test(ch) ? 0.2 : /[tfr-]/.test(ch) ? 0.28 : /[mwMW]/.test(ch) ? 0.6 : /[A-Z]/.test(ch) ? 0.45 : ch === ' ' ? 0.22 : 0.4
    } else {
      u = /[iljtf.,'’:;!|]/.test(ch) ? 0.3 : /[mwMW]/.test(ch) ? 0.85 : /[A-Z]/.test(ch) ? 0.66 : ch === ' ' ? 0.28 : 0.55
    }
    w += u * size
  }
  return w
}

function wrap(str, size, font, maxWidth, maxLines) {
  const words = str.split(/\s+/)
  const lines = []
  let line = ''
  for (const word of words) {
    const next = line ? `${line} ${word}` : word
    if (textWidth(next, size, font) <= maxWidth || !line) line = next
    else {
      lines.push(line)
      line = word
    }
  }
  if (line) lines.push(line)
  if (lines.length > maxLines) return null
  return lines
}

// Wrap, and if the text needs more than `maxLines`, keep the first lines and
// end the last one with an ellipsis at a word boundary.
function clamp(str, size, font, maxWidth, maxLines) {
  const all = wrap(str, size, font, maxWidth, 99)
  if (all.length <= maxLines) return all
  const kept = all.slice(0, maxLines)
  let last = kept[maxLines - 1]
  while (last && textWidth(`${last}…`, size, font) > maxWidth) last = last.replace(/\s*\S+$/, '')
  kept[maxLines - 1] = `${last.replace(/[.,;:]$/, '')}…`
  return kept
}

// Try progressively smaller sizes until the title fits in `maxLines`.
function fitTitle(str, sizes, font, maxWidth, maxLines) {
  for (const size of sizes) {
    const lines = wrap(str, size, font, maxWidth, maxLines)
    if (lines) return { size, lines }
  }
  const size = sizes[sizes.length - 1]
  return { size, lines: wrap(str, size, font, maxWidth, 99).slice(0, maxLines) }
}

// ── Piano-roll scene (right side) ───────────────────────────────────────
// Two octaves from C. Coordinates are absolute on the 1200×630 canvas.
const SCENE = { x: 668, y: 60, w: 470, keyTop: 436, keyH: 120 }
const WHITE_KEYS = 14
const WHITE_W = SCENE.w / WHITE_KEYS
const BLACK_AFTER = [0, 1, 3, 4, 5] // white-key indices (within an octave) that have a black key to their right

// Notes: [lane, yTop, height, weight]. lane = white-key index 0–13 or 'b<n>' for the
// black key after white key n. weight 1 = front/hot, 0 = back/dim.
const NOTES = [
  [1, 300, 110, 0.35],
  [2, 96, 150, 0.55],
  ['b3', 240, 86, 0.4],
  [4, 40, 210, 0.85],
  [5, 322, 114, 1],
  [6, 150, 200, 0.7],
  ['b6', 60, 74, 0.4],
  [7, 268, 168, 1],
  [8, 20, 140, 0.55],
  [9, 200, 236, 1],
  ['b10', 330, 106, 0.6],
  [11, 118, 128, 0.5],
  [12, 260, 176, 0.8],
  [13, 40, 96, 0.3],
]

function laneRect(lane) {
  if (typeof lane === 'number') {
    return { x: SCENE.x + lane * WHITE_W + 3, w: WHITE_W - 6 }
  }
  const after = Number(lane.slice(1))
  const bw = WHITE_W * 0.58
  return { x: SCENE.x + (after + 1) * WHITE_W - bw / 2 + 2, w: bw - 4 }
}

function scene() {
  const out = []
  const { x, y, w, keyTop, keyH } = SCENE
  const rollH = keyTop - y

  // Lane guides: faint vertical lines on every white-key boundary.
  out.push(`<g stroke="#ffffff" stroke-opacity="0.035" stroke-width="1">`)
  for (let i = 0; i <= WHITE_KEYS; i++) {
    const lx = (x + i * WHITE_W).toFixed(1)
    out.push(`<line x1="${lx}" y1="${y}" x2="${lx}" y2="${keyTop}"/>`)
  }
  out.push(`</g>`)
  // Faint beat rows.
  out.push(`<g stroke="#ffffff" stroke-opacity="0.03" stroke-width="1">`)
  for (let r = 1; r < 6; r++) {
    const ry = (y + (rollH / 6) * r).toFixed(1)
    out.push(`<line x1="${x}" y1="${ry}" x2="${x + w}" y2="${ry}"/>`)
  }
  out.push(`</g>`)

  // Bloom behind the hot notes.
  out.push(`<ellipse cx="${x + w * 0.55}" cy="${keyTop - 70}" rx="300" ry="150" fill="url(#bloom)" filter="url(#blur28)"/>`)

  // Notes (back to front).
  const sorted = [...NOTES].sort((a, b) => a[3] - b[3])
  const lit = new Set()
  for (const [lane, top, h, weight] of sorted) {
    const { x: nx, w: nw } = laneRect(lane)
    const bottom = top + h
    const isHot = weight >= 0.8
    const touching = bottom >= keyTop - 12
    if (touching) lit.add(lane)
    const fill = isHot ? 'url(#noteHot)' : 'url(#noteDim)'
    out.push(
      `<rect x="${nx.toFixed(1)}" y="${top}" width="${nw.toFixed(1)}" height="${Math.min(h, keyTop - top - 2)}" rx="6" fill="${fill}" opacity="${weight.toFixed(2)}"/>`,
    )
    if (isHot) {
      out.push(`<rect x="${(nx + 2).toFixed(1)}" y="${top + 1}" width="${(nw - 4).toFixed(1)}" height="1.5" rx="1" fill="#fff" opacity="0.35"/>`)
    }
    if (touching) {
      out.push(`<ellipse cx="${(nx + nw / 2).toFixed(1)}" cy="${keyTop}" rx="${nw * 1.6}" ry="14" fill="url(#hit)" filter="url(#blur8)"/>`)
    }
  }

  // Playhead.
  out.push(`<rect x="${x}" y="${keyTop - 1}" width="${w}" height="2" fill="${ACCENT}" opacity="0.7"/>`)
  out.push(`<rect x="${x}" y="${keyTop - 1}" width="${w}" height="2" fill="${ACCENT}" opacity="0.5" filter="url(#blur8)"/>`)

  // Keybed shadow + body.
  out.push(`<rect x="${x - 6}" y="${keyTop}" width="${w + 12}" height="${keyH + 14}" rx="10" fill="#000" opacity="0.5" filter="url(#blur8)"/>`)
  out.push(`<rect x="${x}" y="${keyTop}" width="${w}" height="${keyH}" rx="6" fill="#0d0d16"/>`)

  // White keys.
  for (let i = 0; i < WHITE_KEYS; i++) {
    const kx = x + i * WHITE_W
    const isLit = lit.has(i)
    out.push(
      `<rect x="${(kx + 1).toFixed(1)}" y="${keyTop + 2}" width="${(WHITE_W - 2).toFixed(1)}" height="${keyH - 4}" rx="4" fill="${isLit ? 'url(#keyLit)' : 'url(#keyWhite)'}"/>`,
    )
    if (isLit) {
      out.push(`<rect x="${(kx + 1).toFixed(1)}" y="${keyTop + 2}" width="${(WHITE_W - 2).toFixed(1)}" height="${keyH - 4}" rx="4" fill="${ACCENT}" opacity="0.35" filter="url(#blur8)"/>`)
    }
  }
  // Black keys.
  for (let oct = 0; oct < 2; oct++) {
    for (const idx of BLACK_AFTER) {
      const after = oct * 7 + idx
      const lane = `b${after}`
      const { x: bx, w: bw } = laneRect(lane)
      const isLit = lit.has(lane)
      out.push(
        `<rect x="${(bx - 2).toFixed(1)}" y="${keyTop}" width="${(bw + 4).toFixed(1)}" height="${keyH * 0.62}" rx="3" fill="${isLit ? 'url(#blackLit)' : 'url(#keyBlack)'}"/>`,
      )
    }
  }
  // Keybed top edge.
  out.push(`<rect x="${x}" y="${keyTop}" width="${w}" height="1" fill="#fff" opacity="0.12"/>`)
  return out.join('\n')
}

// ── Defs shared by every banner ─────────────────────────────────────────
const DEFS = `
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="#0b0b14"/>
    <stop offset="100%" stop-color="#050509"/>
  </linearGradient>
  <radialGradient id="warm" cx="80%" cy="30%" r="70%">
    <stop offset="0%" stop-color="${ACCENT}" stop-opacity="0.20"/>
    <stop offset="45%" stop-color="${ACCENT}" stop-opacity="0.05"/>
    <stop offset="100%" stop-color="${ACCENT}" stop-opacity="0"/>
  </radialGradient>
  <radialGradient id="vignette" cx="50%" cy="50%" r="72%">
    <stop offset="55%" stop-color="#000" stop-opacity="0"/>
    <stop offset="100%" stop-color="#000" stop-opacity="0.6"/>
  </radialGradient>
  <radialGradient id="bloom" cx="50%" cy="50%" r="50%">
    <stop offset="0%" stop-color="#ffb37a" stop-opacity="0.35"/>
    <stop offset="60%" stop-color="${ACCENT}" stop-opacity="0.10"/>
    <stop offset="100%" stop-color="${ACCENT}" stop-opacity="0"/>
  </radialGradient>
  <radialGradient id="hit" cx="50%" cy="50%" r="50%">
    <stop offset="0%" stop-color="#ffd9b8" stop-opacity="0.8"/>
    <stop offset="100%" stop-color="${ACCENT}" stop-opacity="0"/>
  </radialGradient>
  <linearGradient id="noteHot" x1="0" y1="1" x2="0" y2="0">
    <stop offset="0%" stop-color="#ffc79a"/>
    <stop offset="35%" stop-color="${ACCENT}"/>
    <stop offset="100%" stop-color="#c2501a"/>
  </linearGradient>
  <linearGradient id="noteDim" x1="0" y1="1" x2="0" y2="0">
    <stop offset="0%" stop-color="${ACCENT}"/>
    <stop offset="100%" stop-color="#7a3512"/>
  </linearGradient>
  <linearGradient id="keyWhite" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="#1c1c27"/>
    <stop offset="100%" stop-color="#15151f"/>
  </linearGradient>
  <linearGradient id="keyLit" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="#ff9a4a"/>
    <stop offset="100%" stop-color="#e0621a"/>
  </linearGradient>
  <linearGradient id="keyBlack" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="#07070c"/>
    <stop offset="100%" stop-color="#020204"/>
  </linearGradient>
  <linearGradient id="blackLit" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="#c2501a"/>
    <stop offset="100%" stop-color="#7a3512"/>
  </linearGradient>
  <filter id="blur28" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="28"/></filter>
  <filter id="blur8" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="8"/></filter>
</defs>`

const FRAME = (body) => `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
${DEFS}
<rect width="1200" height="630" fill="url(#bg)"/>
<rect width="1200" height="630" fill="url(#warm)"/>
${scene()}
<rect width="1200" height="630" fill="url(#vignette)"/>
${body}
<rect x="80" y="562" width="1040" height="1" fill="#fff" opacity="0.07"/>
<text x="80" y="596" font-family="JetBrains Mono" font-size="15" font-weight="500" fill="${INK_DIM}" letter-spacing="0.5">midee.app</text>
<text x="1120" y="596" font-family="Inter" font-size="14" font-weight="500" fill="${INK_DIM}" text-anchor="end">Free · Open source · No upload</text>
</svg>`

const eyebrow = (label, y) =>
  `<text x="80" y="${y}" font-family="Inter" font-size="13" font-weight="600" fill="${ACCENT}" letter-spacing="3.2">${esc(label.toUpperCase())}</text>
<rect x="80" y="${y + 12}" width="26" height="1.5" fill="${ACCENT}" opacity="0.8"/>`

// Default banner: the wordmark.
function defaultBanner() {
  return FRAME(`
${eyebrow('MIDI visualizer', 150)}
<text x="74" y="290" font-family="Instrument Serif" font-style="italic" font-size="176" fill="${INK}" letter-spacing="-5">midee</text>
<text x="80" y="352" font-family="Inter" font-size="30" font-weight="500" fill="${INK}" letter-spacing="-0.3">Drop a MIDI. Watch it sing.</text>
<text x="80" y="394" font-family="Inter" font-size="18" font-weight="400" fill="${INK_SOFT}">Free, runs entirely in your browser, nothing uploaded.</text>
<text x="80" y="420" font-family="Inter" font-size="18" font-weight="400" fill="${INK_SOFT}">Play live, practise, export MP4 up to 4K.</text>
<g font-family="Inter" font-size="15" font-weight="500" fill="${INK_SOFT}">
  <text x="80" y="474">Visualize</text><circle cx="168" cy="469" r="2" fill="#4a4a5c"/>
  <text x="182" y="474">Learn</text><circle cx="238" cy="469" r="2" fill="#4a4a5c"/>
  <text x="252" y="474">Live</text><circle cx="294" cy="469" r="2" fill="#4a4a5c"/>
  <text x="308" y="474" fill="#fbb37a">Export MP4</text>
</g>`)
}

// Per-page banner: brand row, big italic title, one-line description.
function pageBanner({ label, title, description }) {
  const { size, lines } = fitTitle(title, [88, 76, 66, 58], 'serif', 540, 3)
  const lineH = size * 1.02
  const descLines = clamp(description, 19, 'sans', 550, 2)

  // Lay the block out from y=0, then shift it so its middle sits at the
  // canvas's optical centre. Baselines: brand → eyebrow → title → description.
  const brandY = 0
  const eyebrowY = brandY + 44
  const titleY = eyebrowY + 24 + size * 0.78
  const titleLast = titleY + (lines.length - 1) * lineH
  const descY = titleLast + 50
  const descLast = descY + (descLines.length - 1) * 28
  const top = brandY - 32
  const bottom = descLast + 6
  const shift = 318 - (top + bottom) / 2

  const titleSvg = lines
    .map((l, i) => `<text x="76" y="${(shift + titleY + i * lineH).toFixed(0)}" font-family="Instrument Serif" font-style="italic" font-size="${size}" fill="${INK}" letter-spacing="-1.5">${esc(l)}</text>`)
    .join('\n')
  const descSvg = descLines
    .map((l, i) => `<text x="80" y="${(shift + descY + i * 28).toFixed(0)}" font-family="Inter" font-size="19" font-weight="400" fill="${INK_SOFT}">${esc(l)}</text>`)
    .join('\n')
  return FRAME(`
<text x="78" y="${(shift + brandY).toFixed(0)}" font-family="Instrument Serif" font-style="italic" font-size="44" fill="${INK}" letter-spacing="-1">midee</text>
${eyebrow(label, shift + eyebrowY)}
${titleSvg}
${descSvg}`)
}

// ── Render ──────────────────────────────────────────────────────────────
function render(svg, outPath) {
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: 1200 },
    font: { fontFiles, loadSystemFonts: false, defaultFontFamily: 'Inter' },
    background: '#05050a',
  })
  const png = resvg.render().asPng()
  writeFileSync(outPath, png)
  return png.byteLength
}

const defaultSvg = defaultBanner()
const kb = (render(defaultSvg, resolve(distDir, 'og.png')) / 1024).toFixed(1)
writeFileSync(resolve(distDir, 'og.svg'), defaultSvg)
console.log(`[build-og] wrote dist/og.png (${kb} KB, 1200×630) + dist/og.svg`)

const manifestPath = resolve(distDir, 'og-pages.json')
if (existsSync(manifestPath)) {
  const pages = JSON.parse(readFileSync(manifestPath, 'utf8'))
  mkdirSync(resolve(distDir, 'og'), { recursive: true })
  for (const p of pages) {
    render(pageBanner(p), resolve(distDir, 'og', `${p.slug}.png`))
  }
  console.log(`[build-og] wrote ${pages.length} page banners to dist/og/`)
}
