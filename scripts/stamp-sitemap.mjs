// Writes dist/sitemap.xml with today's date for the homepage and per-file
// mtimes for content pages/posts. Runs as postbuild so Vite's copy of
// public/sitemap.xml is overwritten with the fresh version.

import { writeFileSync, readdirSync, statSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'

const root = process.cwd()
const contentDir = resolve(root, 'content')

function walkMd(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('_')) continue
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) walkMd(full, acc)
    else if (entry.endsWith('.md')) acc.push({ full, mtime: st.mtime })
  }
  return acc
}

function parsePath(mdFile) {
  const raw = readFileSync(mdFile, 'utf8')
  const m = raw.match(/^---\n([\s\S]+?)\n---/)
  if (!m) return null
  const line = m[1].split('\n').find(l => /^path:/.test(l))
  if (!line) return null
  return line.replace(/^path:\s*/, '').replace(/^["']|["']$/g, '').trim()
}

const today = new Date().toISOString().slice(0, 10)
const toIsoDate = (d) => d.toISOString().slice(0, 10)

const contentFiles = walkMd(contentDir)
const urls = [
  { loc: 'https://midee.app/', lastmod: today, changefreq: 'daily', priority: '1.0' },
  { loc: 'https://midee.app/blog/', lastmod: today, changefreq: 'weekly', priority: '0.7' },
]

for (const { full, mtime } of contentFiles) {
  const path = parsePath(full)
  if (!path) continue
  urls.push({
    loc: `https://midee.app${path}`,
    lastmod: toIsoDate(mtime),
    changefreq: path.startsWith('/blog/') ? 'monthly' : 'weekly',
    priority: path.startsWith('/blog/') ? '0.7' : '0.8',
  })
}

const body = urls.map(u => `  <url>
    <loc>${u.loc}</loc>
    <lastmod>${u.lastmod}</lastmod>
    <changefreq>${u.changefreq}</changefreq>
    <priority>${u.priority}</priority>
  </url>`).join('\n')

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${body}
</urlset>
`

const out = resolve(root, 'dist/sitemap.xml')
writeFileSync(out, xml, 'utf8')
console.log(`[stamp-sitemap] wrote ${urls.length} URLs to dist/sitemap.xml`)
