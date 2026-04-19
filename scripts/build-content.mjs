// Renders markdown files in content/ into static HTML pages under dist/.
// Each .md has YAML-lite frontmatter (title, description, path, type, date).
// Shared layout lives in content/_layout.html.

import { readFileSync, writeFileSync, readdirSync, mkdirSync, statSync } from 'node:fs'
import { resolve, join, relative } from 'node:path'
import { marked } from 'marked'

const root = process.cwd()
const contentDir = resolve(root, 'content')
const distDir = resolve(root, 'dist')
const layout = readFileSync(resolve(contentDir, '_layout.html'), 'utf8')

const SITE = 'https://midee.app'

marked.setOptions({ gfm: true, breaks: false })

function parseFrontmatter(raw) {
  const match = raw.match(/^---\n([\s\S]+?)\n---\n([\s\S]*)$/)
  if (!match) return { data: {}, content: raw }
  const data = {}
  for (const line of match[1].split('\n')) {
    const m = line.match(/^([\w-]+):\s*(.*)$/)
    if (!m) continue
    let value = m[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    data[m[1]] = value
  }
  return { data, content: match[2] }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// For <meta content="…"> values. Escapes only what HTML attribute parsing
// actually requires, so apostrophes stay as apostrophes (no &#39; noise).
function escapeAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
}

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

function buildJsonLd({ data, html }) {
  const isPost = data.type === 'post'
  const base = {
    '@context': 'https://schema.org',
    '@type': isPost ? 'BlogPosting' : 'WebPage',
    headline: data.title,
    description: data.description,
    url: `${SITE}${data.path}`,
    image: `${SITE}/og.png`,
    author: { '@type': 'Person', name: 'Aayush Dutt' },
    publisher: {
      '@type': 'Organization',
      name: 'midee',
      url: SITE,
    },
  }
  if (isPost) {
    base.datePublished = data.date
    // `modified` takes precedence when present so the sitemap `lastmod` and
    // the structured-data `dateModified` stay in sync for edited posts.
    base.dateModified = data.modified || data.date
    base.mainEntityOfPage = `${SITE}${data.path}`
    // Rough word count — helps some crawlers size the article.
    const wordCount = (html.replace(/<[^>]+>/g, '').match(/\S+/g) || []).length
    base.wordCount = wordCount
    base.articleSection = data.path.startsWith('/blog/') ? 'Blog' : undefined
  }
  return JSON.stringify(base, null, 2)
}

// Builds Home > [Blog >] Current breadcrumbs. Eligible for the breadcrumb
// trail that Google shows above a result's URL.
function buildBreadcrumbJsonLd({ data }) {
  const items = [
    { '@type': 'ListItem', position: 1, name: 'midee', item: `${SITE}/` },
  ]
  if (data.path.startsWith('/blog/')) {
    items.push({ '@type': 'ListItem', position: 2, name: 'Blog', item: `${SITE}/blog/` })
    items.push({ '@type': 'ListItem', position: 3, name: data.title, item: `${SITE}${data.path}` })
  } else {
    items.push({ '@type': 'ListItem', position: 2, name: data.title, item: `${SITE}${data.path}` })
  }
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items,
  }, null, 2)
}

// Extra <meta> tags in <head> for posts — published/modified times that
// aggregators and social platforms read, plus og:type=article override.
function buildArticleMeta(data) {
  if (data.type !== 'post') return ''
  const iso = new Date(data.date).toISOString()
  return [
    `<meta property="article:published_time" content="${iso}" />`,
    `<meta property="article:modified_time" content="${iso}" />`,
    `<meta property="article:author" content="Aayush Dutt" />`,
    `<meta property="article:section" content="Blog" />`,
  ].join('\n    ')
}

function postMetaBlock(data) {
  if (data.type !== 'post') return ''
  const date = new Date(data.date)
  const pretty = date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
  return `<div class="post-meta"><time datetime="${data.date}">${pretty}</time><span class="dot">·</span><span>${data.readingTime || '5 min read'}</span></div>`
}

function wrapContent({ html, data }) {
  if (data.type === 'post') {
    return `<article itemscope itemtype="https://schema.org/BlogPosting">\n${html}\n</article>`
  }
  return html
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true })
}

// Build an app-home link with UTMs derived from the content page. Lets us
// answer "which post / which CTA position drove this app conversion?" in
// PostHog without instrumenting the content pages themselves — UTMs are
// captured by autocapture and persisted as landing_utm_* super-props
// (set via register_once in src/analytics.ts).
//   source   — content section (blog / vs / guide)
//   campaign — the page slug
//   content  — CTA position (brand / nav / cta_end)
function appHref(path, position) {
  const source = path.startsWith('/blog/') ? 'blog'
    : path.startsWith('/vs/')  ? 'vs'
    : 'guide'
  // /blog/playing-your-midi-keyboard-in-the-browser/ → playing-your-midi-keyboard-in-the-browser
  const slug = path.replace(/^\/+|\/+$/g, '').split('/').pop() || 'index'
  const params = new URLSearchParams({
    utm_source: source,
    utm_medium: 'content',
    utm_campaign: slug,
    utm_content: position,
  })
  return `/?${params.toString()}`
}

function render(mdPath) {
  const raw = readFileSync(mdPath, 'utf8')
  const { data, content } = parseFrontmatter(raw)

  if (!data.title || !data.description || !data.path) {
    throw new Error(`Missing required frontmatter in ${relative(root, mdPath)}`)
  }

  // Inline CTAs in markdown — `[midee](/)`, `[Open it](/)`, etc. — all
  // render as <a href="/">. Rewrite them so authors don't have to hand-
  // attach UTMs in every post. Scoped to <a …> so future markdown features
  // that emit other href="/" values (e.g. canonical <link>) aren't caught.
  // utm_content=inline distinguishes these from brand/nav/cta_end positions.
  const html = marked.parse(content)
    .replace(/<a href="\/"/g, `<a href="${appHref(data.path, 'inline')}"`)
  const jsonLd = buildJsonLd({ data, html })
  const breadcrumbJsonLd = buildBreadcrumbJsonLd({ data })
  const ogType = data.type === 'post' ? 'article' : 'website'

  const page = layout
    .replaceAll('{{title}}', escapeAttr(data.title))
    .replaceAll('{{description}}', escapeAttr(data.description))
    .replaceAll('{{path}}', data.path)
    .replaceAll('{{ogType}}', ogType)
    .replaceAll('{{articleMeta}}', buildArticleMeta(data))
    .replaceAll('{{jsonLd}}', jsonLd)
    .replaceAll('{{breadcrumbJsonLd}}', breadcrumbJsonLd)
    .replaceAll('{{meta}}', postMetaBlock(data))
    .replaceAll('{{content}}', wrapContent({ html, data }))
    .replaceAll('{{appHrefBrand}}', appHref(data.path, 'brand'))
    .replaceAll('{{appHrefNav}}',   appHref(data.path, 'nav'))
    .replaceAll('{{appHrefCta}}',   appHref(data.path, 'cta_end'))

  const outDir = resolve(distDir, '.' + data.path)
  ensureDir(outDir)
  const outPath = join(outDir, 'index.html')
  writeFileSync(outPath, page, 'utf8')
  return { ...data }
}

function writeBlogIndex(results) {
  const posts = results
    .filter(p => p.type === 'post')
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''))

  if (posts.length === 0) return posts

  const listHtml = posts.map(p => {
    const date = new Date(p.date)
    const pretty = date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
    return `<li><a href="${p.path}">${escapeHtml(p.title)}</a><br/><span class="post-meta-inline">${pretty}</span><p>${escapeHtml(p.description)}</p></li>`
  }).join('\n')

  const body = `<h1>Blog</h1>\n<p class="lede">Writing about midee — how it is built, technical decisions, and how to get more out of it.</p>\n<ul class="post-list">\n${listHtml}\n</ul>`

  const indexData = { title: 'Blog', description: 'Writing about midee — how it is built, technical decisions, and how to get more out of the MIDI visualizer.', path: '/blog/' }
  const breadcrumb = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'midee', item: `${SITE}/` },
      { '@type': 'ListItem', position: 2, name: 'Blog', item: `${SITE}/blog/` },
    ],
  }, null, 2)

  const page = layout
    .replaceAll('{{title}}', escapeAttr(indexData.title))
    .replaceAll('{{description}}', escapeAttr(indexData.description))
    .replaceAll('{{path}}', indexData.path)
    .replaceAll('{{ogType}}', 'website')
    .replaceAll('{{articleMeta}}', '')
    .replaceAll('{{jsonLd}}', JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'Blog',
      name: 'midee blog',
      description: indexData.description,
      url: `${SITE}/blog/`,
      publisher: {
        '@type': 'Organization',
        name: 'midee',
        url: SITE,
      },
    }, null, 2))
    .replaceAll('{{breadcrumbJsonLd}}', breadcrumb)
    .replaceAll('{{meta}}', '')
    .replaceAll('{{content}}', body)
    .replaceAll('{{appHrefBrand}}', appHref(indexData.path, 'brand'))
    .replaceAll('{{appHrefNav}}',   appHref(indexData.path, 'nav'))
    .replaceAll('{{appHrefCta}}',   appHref(indexData.path, 'cta_end'))

  ensureDir(resolve(distDir, 'blog'))
  writeFileSync(resolve(distDir, 'blog', 'index.html'), page, 'utf8')
  return posts
}

// Atom 1.0 / RSS 2.0 combined — emits a valid RSS 2.0 doc. Atom would be a
// cleaner spec but RSS has broader reader support.
function writeRssFeed(posts) {
  if (posts.length === 0) return
  const escapeXml = (s) => String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')

  const lastBuildDate = new Date().toUTCString()
  const items = posts.map(p => {
    const pubDate = new Date(p.date).toUTCString()
    const url = `${SITE}${p.path}`
    return `    <item>
      <title>${escapeXml(p.title)}</title>
      <link>${url}</link>
      <guid isPermaLink="true">${url}</guid>
      <pubDate>${pubDate}</pubDate>
      <description>${escapeXml(p.description)}</description>
      <author>hello@midee.app (Aayush Dutt)</author>
    </item>`
  }).join('\n')

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>midee blog</title>
    <link>${SITE}/blog/</link>
    <atom:link href="${SITE}/blog/rss.xml" rel="self" type="application/rss+xml" />
    <description>Writing about midee — a free, open-source MIDI visualizer in the browser. Technical decisions, release notes, and how to get more out of the app.</description>
    <language>en-us</language>
    <lastBuildDate>${lastBuildDate}</lastBuildDate>
${items}
  </channel>
</rss>
`
  writeFileSync(resolve(distDir, 'blog', 'rss.xml'), xml, 'utf8')
}

// MAIN
const files = walkMd(contentDir)
const results = []
for (const f of files) {
  const result = render(f)
  results.push(result)
  console.log(`[build-content] rendered ${result.path}`)
}
const posts = writeBlogIndex(results)
writeRssFeed(posts)
console.log(`[build-content] ${results.length} pages + blog index + rss`)
