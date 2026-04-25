/// <reference types="vitest" />
import { defineConfig } from 'vite'
import solid from 'vite-plugin-solid'

export default defineConfig({
  plugins: [solid()],
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
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    setupFiles: ['./vitest.setup.ts'],
  },
})
