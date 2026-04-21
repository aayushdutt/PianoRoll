// Renders the canonical favicon SVG (content/favicon.svg) and its maskable
// sibling (content/favicon-maskable.svg) into the full set of raster icons
// Google SERPs, iOS, Android, and PWA launchers expect — written into
// public/icons/ so Vite picks them up as static assets and serves them at
// /icons/... on the deployed site.
//
// Not wired into postbuild: icons change rarely, and keeping the PNGs in
// git makes the deploy deterministic. Regenerate explicitly via
// `npm run icons` whenever content/favicon*.svg changes.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Resvg } from '@resvg/resvg-js'

const root = process.cwd()
const outDir = resolve(root, 'public/icons')
mkdirSync(outDir, { recursive: true })

const iconSvg = readFileSync(resolve(root, 'content/favicon.svg'), 'utf8')
const maskableSvg = readFileSync(resolve(root, 'content/favicon-maskable.svg'), 'utf8')

// Size list. Google SERPs specifically want a favicon sized to a multiple
// of 48px — 96×96 is the sweet spot (crisp, not huge). 180×180 is Apple's
// canonical apple-touch-icon. 192/512 are the PWA manifest sizes.
/** @type {Array<{ svg: string, out: string, size: number }>} */
const targets = [
  { svg: iconSvg, out: 'favicon-16.png', size: 16 },
  { svg: iconSvg, out: 'favicon-32.png', size: 32 },
  { svg: iconSvg, out: 'favicon-96.png', size: 96 },
  { svg: iconSvg, out: 'apple-touch-icon.png', size: 180 },
  { svg: iconSvg, out: 'icon-192.png', size: 192 },
  { svg: iconSvg, out: 'icon-512.png', size: 512 },
  { svg: maskableSvg, out: 'icon-maskable-512.png', size: 512 },
]

for (const { svg, out, size } of targets) {
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: size } })
  const png = resvg.render().asPng()
  writeFileSync(resolve(outDir, out), png)
  const kb = (png.byteLength / 1024).toFixed(1)
  console.log(`[build-icons] wrote public/icons/${out} (${size}×${size}, ${kb} KB)`)
}

// Ship the SVG too — modern browsers prefer it for tabs (crisp at any DPI).
writeFileSync(resolve(outDir, 'favicon.svg'), iconSvg)
console.log('[build-icons] wrote public/icons/favicon.svg')
