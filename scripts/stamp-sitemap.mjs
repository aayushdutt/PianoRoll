// Writes dist/sitemap.xml with frontmatter-driven `lastmod` for every
// content page/post, and today's date for the homepage + blog index.
// Runs as postbuild so Vite's copy of public/sitemap.xml is overwritten
// with the fresh version.
//
// We intentionally DO NOT use file mtime: fresh git checkouts (every CI
// deploy) reset mtimes to the checkout time, which would make every post
// claim `lastmod=today` on every deploy. Google ignores `lastmod` as a
// freshness signal when that pattern persists. Frontmatter `date` /
// `modified` is stable across clones and is what authors actually control.

import { writeFileSync, readdirSync, statSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'

const root = process.cwd()
const contentDir = resolve(root, 'content')
const today = new Date().toISOString().slice(0, 10)

function walkMd(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('_')) continue
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) walkMd(full, acc)
    else if (entry.endsWith('.md')) acc.push(full)
  }
  return acc
}

// Pulls path + date fields from a .md file's YAML-lite frontmatter.
// `modified` takes precedence over `date` so authors can bump one post
// without faking a new publish date. Both fall back to today when absent
// (content pages typically have no `date` and that's fine).
function readMeta(mdFile) {
  const raw = readFileSync(mdFile, 'utf8')
  const fm = raw.match(/^---\n([\s\S]+?)\n---/)?.[1] ?? ''
  const field = (name) => {
    const line = fm.split('\n').find(l => new RegExp(`^${name}:`).test(l))
    return line ? line.replace(new RegExp(`^${name}:\\s*`), '').replace(/^["']|["']$/g, '').trim() : null
  }
  return {
    path: field('path'),
    date: field('date'),
    modified: field('modified'),
  }
}

function isoDay(value) {
  if (!value) return today
  // Accept "YYYY-MM-DD" straight through; coerce other shapes via Date.
  const match = String(value).match(/^\d{4}-\d{2}-\d{2}/)
  if (match) return match[0]
  const d = new Date(value)
  return Number.isFinite(+d) ? d.toISOString().slice(0, 10) : today
}

const contentFiles = walkMd(contentDir)
const urls = [
  { loc: 'https://midee.app/', lastmod: today, changefreq: 'daily', priority: '1.0' },
  { loc: 'https://midee.app/blog/', lastmod: today, changefreq: 'weekly', priority: '0.7' },
]

for (const file of contentFiles) {
  const { path, date, modified } = readMeta(file)
  if (!path) continue
  urls.push({
    loc: `https://midee.app${path}`,
    lastmod: isoDay(modified ?? date),
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
