// Audits every generated HTML page in dist/ for broken local references.
// Checks:
//   - <a href="/local">      → file exists at that path
//   - <img src="/local">     → image exists
//   - <link href="/local">   → asset exists
//   - <script src="/local">  → script exists
//   - Meta tags referencing absolute URLs on our own origin (og:image, etc.)
// Ignores external http(s) URLs and anchors (#foo).
// Exits 0 with a warning list so the build doesn't fail on missing assets —
// adjust `exit(1)` at the bottom to make it blocking in CI.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { resolve, join, dirname, extname } from 'node:path'

const root = process.cwd()
const distDir = resolve(root, 'dist')
const SITE = 'https://midee.app'

function walkHtml(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) walkHtml(full, acc)
    else if (entry.endsWith('.html')) acc.push(full)
  }
  return acc
}

// Extract href/src URLs + URL-valued `content` attrs (og:image, etc.).
// Ignores non-URL `content` values like "en_US", "width=device-width", etc.
function extractRefs(html) {
  const refs = []

  // href + src are always URL-valued
  const attrRe = /(?:href|src)\s*=\s*["']([^"']+)["']/gi
  let m
  while ((m = attrRe.exec(html)) !== null) refs.push(m[1])

  // content attrs — only keep values that look URL-ish
  const contentRe = /content\s*=\s*["']([^"']+)["']/gi
  while ((m = contentRe.exec(html)) !== null) {
    const v = m[1].trim()
    if (v.startsWith('/') || /^https?:\/\//.test(v)) refs.push(v)
  }
  return refs
}

// Map a URL reference onto a filesystem path inside dist/, if applicable.
// Returns null for refs we shouldn't check (external, data:, mailto:, etc.).
function resolveLocal(ref, fromFile) {
  if (!ref) return null
  // Strip whitespace
  ref = ref.trim()
  // Ignore anchors-only, data/blob URIs, mailto/tel, javascript
  if (ref.startsWith('#')) return null
  if (ref.startsWith('data:')) return null
  if (ref.startsWith('blob:')) return null
  if (ref.startsWith('mailto:')) return null
  if (ref.startsWith('tel:')) return null
  if (ref.startsWith('javascript:')) return null
  // Canonicalize absolute midee.app URLs into root-relative
  if (ref.startsWith(SITE)) ref = ref.slice(SITE.length) || '/'
  // Skip any remaining external URL
  if (/^https?:\/\//.test(ref)) return null
  // Skip protocol-relative
  if (ref.startsWith('//')) return null

  // Strip query/hash
  ref = ref.replace(/[?#].*$/, '')
  if (ref === '') return null

  // Resolve relative to the file's dir, or from dist root for absolute paths
  let fsPath
  if (ref.startsWith('/')) {
    fsPath = join(distDir, ref)
  } else {
    fsPath = resolve(dirname(fromFile), ref)
  }

  // If the URL ends with '/', the canonical file is index.html inside that dir
  if (fsPath.endsWith('/')) fsPath = join(fsPath, 'index.html')
  // If it has no extension, treat as a directory with index.html
  else if (!extname(fsPath) && !existsSync(fsPath)) {
    const idx = join(fsPath, 'index.html')
    if (existsSync(idx)) return idx
  }
  return fsPath
}

const htmlFiles = walkHtml(distDir)
const broken = []
const checked = new Set()

for (const file of htmlFiles) {
  const raw = readFileSync(file, 'utf8')
  // Strip HTML comments so we don't flag commented-out placeholder <link> tags.
  const html = raw.replace(/<!--[\s\S]*?-->/g, '')
  const refs = extractRefs(html)
  for (const ref of refs) {
    const resolved = resolveLocal(ref, file)
    if (!resolved) continue
    if (checked.has(resolved + '::' + ref)) continue
    checked.add(resolved + '::' + ref)
    if (!existsSync(resolved)) {
      broken.push({ file: file.replace(distDir + '/', ''), ref, resolved: resolved.replace(distDir + '/', '') })
    }
  }
}

// Also scan manifest.webmanifest for icon refs — those are live references
// even though the file isn't HTML.
const manifestPath = join(distDir, 'manifest.webmanifest')
if (existsSync(manifestPath)) {
  try {
    const mf = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const iconSrcs = (mf.icons || []).map(i => i.src).filter(Boolean)
    for (const src of iconSrcs) {
      const resolved = resolveLocal(src, manifestPath)
      if (!resolved) continue
      if (!existsSync(resolved)) {
        broken.push({ file: 'manifest.webmanifest', ref: src, resolved: resolved.replace(distDir + '/', '') })
      }
    }
  } catch (err) {
    console.warn(`[check-links] couldn't parse manifest.webmanifest: ${err.message}`)
  }
}

if (broken.length === 0) {
  console.log(`[check-links] ✓ ${htmlFiles.length} HTML files, ${checked.size} local refs, 0 broken`)
  process.exit(0)
}

console.log(`[check-links] ⚠ ${broken.length} broken local references in ${htmlFiles.length} HTML files:\n`)
const byFile = new Map()
for (const b of broken) {
  if (!byFile.has(b.file)) byFile.set(b.file, [])
  byFile.get(b.file).push(b)
}
for (const [file, items] of byFile) {
  console.log(`  ${file}`)
  for (const item of items) {
    console.log(`    → ${item.ref}   (looked for ${item.resolved})`)
  }
}

// Don't fail the build for now — just warn. Flip to process.exit(1) once
// every current reference resolves and you want future builds to be strict.
process.exit(0)
