// Renders content/og.svg into dist/og.png (1200×630) using @resvg/resvg-js
// with the app's real fonts (Instrument Serif, Inter, JetBrains Mono) loaded
// from @fontsource packages. Runs during postbuild so the OG image is always
// fresh and in sync with whatever the SVG declares.

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Resvg } from '@resvg/resvg-js'

const root = process.cwd()
const svgPath = resolve(root, 'content/og.svg')
const pngOut = resolve(root, 'dist/og.png')
const svgOut = resolve(root, 'dist/og.svg')

const FS = resolve(root, 'node_modules/@fontsource')
const fontFiles = [
  `${FS}/instrument-serif/files/instrument-serif-latin-400-normal.woff`,
  `${FS}/instrument-serif/files/instrument-serif-latin-400-italic.woff`,
  `${FS}/inter/files/inter-latin-400-normal.woff`,
  `${FS}/inter/files/inter-latin-500-normal.woff`,
  `${FS}/inter/files/inter-latin-600-normal.woff`,
  `${FS}/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff`,
]

const svg = readFileSync(svgPath, 'utf8')

const resvg = new Resvg(svg, {
  fitTo: { mode: 'width', value: 1200 },
  font: {
    fontFiles,
    loadSystemFonts: false,
    defaultFontFamily: 'Inter',
  },
  background: '#05050a',
})

const pngBuffer = resvg.render().asPng()
writeFileSync(pngOut, pngBuffer)
writeFileSync(svgOut, svg)

const kb = (pngBuffer.byteLength / 1024).toFixed(1)
console.log(`[build-og] wrote dist/og.png (${kb} KB, 1200×630) + dist/og.svg`)
