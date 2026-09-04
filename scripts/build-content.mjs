// Renders markdown files in content/ into static HTML pages under dist/.
// Each .md has YAML-lite frontmatter (title, description, path, type, date).
// Shared layout lives in content/_layout.html.

import { readFileSync, writeFileSync, readdirSync, mkdirSync, statSync } from 'node:fs'
import { resolve, join, relative } from 'node:path'
import { marked } from 'marked'
import { renderFontTags } from './fonts-css.mjs'
import { renderPosthogSnippet } from './posthog-snippet.mjs'

const posthogSnippet = renderPosthogSnippet()

const root = process.cwd()
const contentDir = resolve(root, 'content')
const distDir = resolve(root, 'dist')
const layout = readFileSync(resolve(contentDir, '_layout.html'), 'utf8')

// Self-hosted fonts via the same hashed woff2 files the SPA ships. Reads
// `dist/assets/` so this must run after `vite build` (it does — npm's
// `postbuild` hook). Drops the cross-origin chain Lighthouse measures as
// ~360 ms render-blocking on first load.
const { fontFaces, fontPreload } = renderFontTags(resolve(distDir, 'assets'))

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
    image: data.ogImage || `${SITE}/og.png`,
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
// (set via register_once in src/telemetry.ts).
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

// Mid-article CTA shortcode. Authors drop `{{cta}}` on its own line, or
// `{{cta:Button label|Supporting sentence}}` to override the copy. Placed
// after the how-to steps so readers with intent don't have to scroll to
// the end-of-page card. Quieter styling than `.page-cta` (see content.css).
// utm_content=cta_mid so PostHog can compare it against cta_end.
function midCta(path, args) {
  // `args` is captured from marked's output, so it is already HTML-escaped
  // (apostrophes arrive as &#39;). Don't escape again.
  const [label, blurb] = (args || '').split('|').map((s) => s.trim())
  const text = blurb || 'Free, no upload, no account. Drop in a MIDI and go.'
  const button = label || 'Open midee'
  return `<aside class="page-cta page-cta--mid">
  <p>${text}</p>
  <a class="cta-button" href="${appHref(path, 'cta_mid')}">${button} →</a>
</aside>`
}

// Display order for guide links (blog index "more guides" + the footer nav
// on every page). Pages not listed here sort last, alphabetically by path.
const GUIDE_ORDER = [
  '/online-midi-player/',
  '/midi-visualizer/',
  '/midi-converter/',
  '/midi-to-mp4/',
  '/midi-to-mp3/',
  '/midi-to-wav/',
  '/piano-roll-video-maker/',
  '/synthesia-alternative/',
  '/play-along-piano/',
  '/sight-reading-trainer/',
  '/live-midi-keyboard/',
  '/midi-loop-station/',
  '/best-midi-visualizers/',
  '/vs/synthesia/',
  '/vs/seemusic/',
  '/vs/midi2vidi/',
  '/vs/sightread-dev/',
]
const guideRank = new Map(GUIDE_ORDER.map((path, idx) => [path, idx]))
const byGuideOrder = (a, b) =>
  (guideRank.get(a.path) ?? Number.MAX_SAFE_INTEGER) - (guideRank.get(b.path) ?? Number.MAX_SAFE_INTEGER) ||
  a.path.localeCompare(b.path)

// Set in the main flow before any render() call.
let allPages = []

// Sitewide footer nav linking every guide, comparison, and post. Exists so
// each content page has ~20 internal inbound links instead of 2–3; Search
// Console showed most pages "discovered, not crawled" with the sparse graph.
// The current page is rendered as plain text so it doesn't self-link.
// Short form of a page title for nav labels and OG banners: explicit
// `navTitle` frontmatter, else the SEO title with its subtitle and year
// stripped ("MIDI to MP3: Free… (2026)" → "MIDI to MP3").
const shortTitle = (p) =>
  p.navTitle || p.title.split(/:| [-–—] /)[0].replace(/\s*\(\d{4}\)\s*$/, '').trim()

// /vs/synthesia/ → vs-synthesia; used for dist/og/<slug>.png.
const ogSlug = (path) => path.replace(/^\/+|\/+$/g, '').replace(/\//g, '-')
const ogImageFor = (path) => `${SITE}/og/${ogSlug(path)}.png`

function guidesFooter(currentPath) {
  const label = shortTitle
  const item = (p) =>
    p.path === currentPath
      ? `<li><span aria-current="page">${escapeHtml(label(p))}</span></li>`
      : `<li><a href="${p.path}">${escapeHtml(label(p))}</a></li>`
  const group = (heading, pages) =>
    pages.length === 0 ? '' : `<div><h2>${heading}</h2><ul>${pages.map(item).join('')}</ul></div>`
  const guides = allPages.filter((p) => p.type === 'page' && !p.path.startsWith('/vs/')).sort(byGuideOrder)
  const compare = allPages.filter((p) => p.type === 'page' && p.path.startsWith('/vs/')).sort(byGuideOrder)
  const posts = allPages.filter((p) => p.type === 'post').sort((a, b) => (b.date || '').localeCompare(a.date || ''))
  return `<nav class="footer-guides" aria-label="More from midee">${group('Guides', guides)}${group('Comparisons', compare)}${group('Blog', posts)}</nav>`
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
  data.ogImage = ogImageFor(data.path)
  const html = marked.parse(content)
    .replace(/<a href="\/"/g, `<a href="${appHref(data.path, 'inline')}"`)
    .replace(/<p>\{\{cta(?::([^}]*))?\}\}<\/p>/g, (_, args) => midCta(data.path, args))
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
    .replaceAll('{{guides}}', guidesFooter(data.path))
    .replaceAll('{{ogImage}}', data.ogImage)
    .replaceAll('{{posthogSnippet}}', posthogSnippet)
    .replaceAll('{{fontPreload}}', fontPreload)
    .replaceAll('{{fontFaces}}', fontFaces)

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

  const guideLinks = results
    .filter(p => p.type === 'page')
    .sort(byGuideOrder)
    .map(p => [p.path, p.title])

  const guidesHtml = guideLinks
    .map(([href, label]) => `<a href="${href}">${escapeHtml(label)}</a>`)
    .join(' · ')

  const body = `<h1>Blog</h1>\n<p class="lede">Writing about midee — how it is built, technical decisions, and how to get more out of the browser MIDI player, visualizer, live mode, and Learn mode.</p>\n<h2>Latest posts</h2>\n<ul class="post-list">\n${listHtml}\n</ul>\n<details>\n<summary class="post-meta-inline">More midee guides</summary>\n<p class="post-meta-inline">${guidesHtml}</p>\n</details>`

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
    .replaceAll('{{guides}}', guidesFooter(indexData.path))
    .replaceAll('{{ogImage}}', `${SITE}/og.png`)
    .replaceAll('{{appHrefBrand}}', appHref(indexData.path, 'brand'))
    .replaceAll('{{appHrefNav}}',   appHref(indexData.path, 'nav'))
    .replaceAll('{{appHrefCta}}',   appHref(indexData.path, 'cta_end'))
    .replaceAll('{{posthogSnippet}}', posthogSnippet)
    .replaceAll('{{fontPreload}}', fontPreload)
    .replaceAll('{{fontFaces}}', fontFaces)

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
// Pre-parse every page's frontmatter so each rendered page can carry the
// sitewide guides footer (see guidesFooter). Two passes over small files is
// cheaper than threading a dependency order through render().
allPages = files.map((f) => parseFrontmatter(readFileSync(f, 'utf8')).data)
const results = []
for (const f of files) {
  const result = render(f)
  results.push(result)
  console.log(`[build-content] rendered ${result.path}`)
}
const posts = writeBlogIndex(results)
writeRssFeed(posts)
// Manifest for build-og.mjs (runs next in postbuild): one banner per page.
writeFileSync(
  resolve(distDir, 'og-pages.json'),
  JSON.stringify(
    results.map((p) => ({
      slug: ogSlug(p.path),
      label: p.type === 'post' ? 'Blog' : p.path.startsWith('/vs/') ? 'Comparison' : 'Guide',
      title: p.ogTitle || shortTitle(p),
      description: p.ogDescription || p.description,
    })),
    null,
    2,
  ),
)
console.log(`[build-content] ${results.length} pages + blog index + rss`)
