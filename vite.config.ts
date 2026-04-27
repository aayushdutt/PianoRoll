/// <reference types="vitest" />
import { defineConfig, type Plugin } from 'vite'
import solid from 'vite-plugin-solid'

// Preload the body font (Inter 400) so the woff2 fetch starts in parallel
// with HTML parse, not after CSS is parsed. Saves ~100-200 ms on LCP for
// first-time visitors. Other weights / Instrument Serif / JetBrains Mono
// load lazily via @font-face when the CSS resolves — fine, they're not
// above-the-fold.
const preloadBodyFont = (): Plugin => ({
  name: 'preload-body-font',
  apply: 'build',
  transformIndexHtml: {
    order: 'post',
    handler(html, ctx) {
      const bundle = ctx.bundle
      if (!bundle) return html
      const inter400 = Object.values(bundle).find(
        (c) => c.type === 'asset' && /(^|\/)inter-latin-400-normal-[^/]+\.woff2$/.test(c.fileName),
      )
      if (!inter400) return html
      const tag = `    <link rel="preload" as="font" type="font/woff2" crossorigin href="/${inter400.fileName}">\n`
      return html.replace('</head>', `${tag}</head>`)
    },
  },
})

export default defineConfig({
  plugins: [solid(), preloadBodyFont()],
  // Pre-bundle Mediabunny at dev startup. It is only reached via `import('./export/VideoExporter')`
  // in `app.ts`; lazy discovery can re-run the dep optimizer while the tab still references old
  // `node_modules/.vite/deps/*` URLs → 504 (Outdated Optimize Dep) + failed dynamic import.
  optimizeDeps: {
    include: ['mediabunny'],
  },
  resolve: {
    alias: {
      // @tonejs/piano's MidiInput module imports Node's 'events' — polyfill for browser
      events: 'events',
    },
  },
  build: {
    // 'hidden' emits .map files next to the .js bundles but omits the
    // `//# sourceMappingURL=` comment, so prod users never download maps and
    // their stack traces stay opaque from devtools. The PostHog CLI
    // (`scripts/upload-sourcemaps.mjs`) reads those .map files at upload
    // time, injects a chunk-id, and ships them to PostHog where they're paired
    // with caught errors at view time.
    sourcemap: 'hidden',
    rollupOptions: {
      output: {
        // Force every pixi.js module into a single `pixi` chunk.
        //
        // Why: pixi's `Application.init()` dynamic-imports its renderer
        // (`./gl/WebGLRenderer.mjs` etc. — see autoDetectRenderer.mjs).
        // When rolldown's chunk-graph optimizer kicks in (any time pixi
        // is shared between two dynamic boundaries — e.g. the main entry
        // and a lazy LearnController), it splits the renderer into a
        // separate chunk AND emits a top-level `new BaseClass()` in
        // CanvasRenderer that depends on a class living in a sibling
        // chunk. The two chunks form a circular dep at module-eval time
        // → TDZ crash: `Uncaught TypeError: _ is not a constructor`.
        //
        // Bundling all of pixi into one chunk makes those dynamic
        // imports same-chunk (transparent) and removes the cycle.
        // Single 'pixi' chunk is fetched in parallel with the entry
        // (Vite auto-preloads it as a static dep of index), so
        // first-paint latency is effectively the same as inlining,
        // with the bonus that the chunk stays cached across reloads
        // even when the app shell changes.
        manualChunks(id) {
          if (id.includes('node_modules/pixi.js')) return 'pixi'
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    setupFiles: ['./vitest.setup.ts'],
  },
})
